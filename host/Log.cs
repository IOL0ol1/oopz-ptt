namespace OopzPtt;

internal static class Log
{
    static readonly object Gate = new();
    static string? _path;

    public static void Init(string dir)
    {
        _path = Path.Combine(dir, "host.log");
        try
        {
            var fi = new FileInfo(_path);
            if (fi.Exists && fi.Length > 512 * 1024) fi.Delete();
        }
        catch { }
    }

    public static void Write(string text)
    {
        if (_path == null) return;
        lock (Gate)
        {
            try { File.AppendAllText(_path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {text}\r\n"); }
            catch { }
        }
    }
}
