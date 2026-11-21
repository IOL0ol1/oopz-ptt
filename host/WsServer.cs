using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

namespace OopzPtt;

// 只监听 127.0.0.1，只接受来自 Oopz 网页（油猴脚本）或浏览器扩展后台的连接
internal sealed class WsServer
{
    public const int Port = 29271;

    static bool OriginAllowed(string origin) =>
        origin.Equals("https://web.oopz.cn", StringComparison.OrdinalIgnoreCase) ||
        origin.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase);
    const string Magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    readonly ConcurrentDictionary<int, Client> _clients = new();
    TcpListener? _listener;
    int _nextId;

    public event Action<int, bool>? Connection;
    public event Action<int, string>? Received;

    public int Count => _clients.Count;

    public bool Start()
    {
        try
        {
            _listener = new TcpListener(IPAddress.Loopback, Port);
            _listener.Server.ExclusiveAddressUse = true;
            _listener.Start();
        }
        catch (SocketException ex)
        {
            Log.Write($"监听端口 {Port} 失败: {ex.Message}");
            return false;
        }
        _ = AcceptLoop();
        return true;
    }

    public void Stop()
    {
        try { _listener?.Stop(); } catch { }
        foreach (var c in _clients.Values) c.Abort();
    }

    public void Send(int id, string json)
    {
        if (_clients.TryGetValue(id, out var c)) _ = c.SendAsync(json);
    }

    public void Broadcast(string json)
    {
        foreach (var c in _clients.Values) _ = c.SendAsync(json);
    }

    async Task AcceptLoop()
    {
        while (true)
        {
            TcpClient tcp;
            try { tcp = await _listener!.AcceptTcpClientAsync().ConfigureAwait(false); }
            catch { return; }
            _ = Serve(tcp);
        }
    }

    async Task Serve(TcpClient tcp)
    {
        using var _ = tcp;
        tcp.NoDelay = true;
        var stream = tcp.GetStream();
        Client? client = null;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var head = await ReadHead(stream, cts.Token).ConfigureAwait(false);
            if (head == null) return;

            var accept = Handshake(head, out var status);
            if (accept == null)
            {
                await WriteAscii(stream, $"HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").ConfigureAwait(false);
                return;
            }
            await WriteAscii(stream,
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n").ConfigureAwait(false);

            var ws = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions
            {
                IsServer = true,
                KeepAliveInterval = TimeSpan.FromSeconds(20),
            });
            client = new Client(Interlocked.Increment(ref _nextId), ws);
            _clients[client.Id] = client;
            Connection?.Invoke(client.Id, true);
            await ReceiveLoop(client).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
        }
        catch (Exception ex)
        {
            Log.Write("连接处理异常: " + ex);
        }
        finally
        {
            if (client != null && _clients.TryRemove(client.Id, out var _))
                Connection?.Invoke(client.Id, false);
        }
    }

    async Task ReceiveLoop(Client client)
    {
        var buf = new byte[4096];
        var msg = new MemoryStream();
        while (client.Ws.State == WebSocketState.Open)
        {
            var r = await client.Ws.ReceiveAsync(buf, CancellationToken.None).ConfigureAwait(false);
            if (r.MessageType == WebSocketMessageType.Close)
            {
                try { await client.Ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None).ConfigureAwait(false); }
                catch { }
                return;
            }
            msg.Write(buf, 0, r.Count);
            if (msg.Length > 64 * 1024) return;
            if (!r.EndOfMessage) continue;
            if (r.MessageType == WebSocketMessageType.Text)
                Received?.Invoke(client.Id, Encoding.UTF8.GetString(msg.GetBuffer(), 0, (int)msg.Length));
            msg.SetLength(0);
        }
    }

    static string? Handshake(string head, out string status)
    {
        status = "400 Bad Request";
        var lines = head.Split("\r\n");
        if (lines.Length == 0 || !lines[0].StartsWith("GET ", StringComparison.Ordinal)) return null;

        var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            int i = line.IndexOf(':');
            if (i > 0) h[line[..i].Trim()] = line[(i + 1)..].Trim();
        }

        if (!h.TryGetValue("Upgrade", out var up) || !up.Equals("websocket", StringComparison.OrdinalIgnoreCase)) return null;
        if (!h.TryGetValue("Sec-WebSocket-Key", out var key) || key.Length == 0) return null;

        // 防 DNS 重绑定：Host 必须是本机地址
        if (!h.TryGetValue("Host", out var host) ||
            !(host == $"127.0.0.1:{Port}" || host == $"localhost:{Port}"))
        {
            status = "403 Forbidden";
            return null;
        }
        if (!h.TryGetValue("Origin", out var origin) || !OriginAllowed(origin.TrimEnd('/')))
        {
            status = "403 Forbidden";
            Log.Write("拒绝来源: " + (origin ?? "(无)"));
            return null;
        }

        return Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + Magic)));
    }

    static async Task<string?> ReadHead(NetworkStream stream, CancellationToken ct)
    {
        var buf = new byte[8192];
        int len = 0;
        while (len < buf.Length)
        {
            int n = await stream.ReadAsync(buf.AsMemory(len), ct).ConfigureAwait(false);
            if (n == 0) return null;
            len += n;
            var end = buf.AsSpan(0, len).IndexOf("\r\n\r\n"u8);
            if (end >= 0) return Encoding.ASCII.GetString(buf, 0, end);
        }
        return null;
    }

    static Task WriteAscii(NetworkStream stream, string text) => stream.WriteAsync(Encoding.ASCII.GetBytes(text)).AsTask();

    sealed class Client(int id, WebSocket ws)
    {
        readonly SemaphoreSlim _lock = new(1, 1);
        public int Id { get; } = id;
        public WebSocket Ws { get; } = ws;

        public async Task SendAsync(string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (Ws.State == WebSocketState.Open)
                    await Ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch { }
            finally { _lock.Release(); }
        }

        public void Abort()
        {
            try { Ws.Abort(); } catch { }
        }
    }
}
