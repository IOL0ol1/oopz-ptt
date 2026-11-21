using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;
using static OopzPtt.Native;

namespace OopzPtt;

internal sealed unsafe class App
{
    public const string WindowClass = "OopzPtt.Host";
    public const uint WM_TRAY = WM_APP + 1;
    public const uint WM_PUMP = WM_APP + 2;
    public const uint WM_SECOND_INSTANCE = WM_APP + 3;

    const string OopzUrl = "https://web.oopz.cn/";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValue = "OopzPtt";

    const nuint TimerRelease = 1;
    const nuint TimerWatchdog = 2;
    const nuint TimerOpenWeb = 3;
    const nuint TimerLearn = 4;

    const nuint CmdOpenWeb = 1;
    const nuint CmdAutoStart = 3;
    const nuint CmdOpenOnStart = 4;
    const nuint CmdRunAsAdmin = 5;
    const nuint CmdExit = 9;

    const int VK_ESCAPE = 0x1B;

    static App? _current;

    readonly ConcurrentQueue<Action> _queue = new();
    readonly SettingsStore _store;
    readonly WsServer _ws = new();
    readonly bool[] _down = new bool[256];
    readonly bool _quietStart;
    readonly string _version;

    IntPtr _hwnd;
    uint _taskbarCreated;
    bool _trayAdded;
    IntPtr _trayIcon;
    // 托盘缓存键：连接状态 + 发言模式。提示文字两者都依赖，任一变化都要重设图标。
    int _trayKey = -1;

    bool _held;
    bool _open;
    int _watchMiss;

    bool _learning;
    int _learnMod;

    bool _mouseRegistered;

    public App(SettingsStore store, bool quietStart)
    {
        _store = store;
        _quietStart = quietStart;
        var v = typeof(App).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        _version = v.Split('+')[0];
        _current = this;
    }

    Settings S => _store.Current;

    public int Run()
    {
        var instance = GetModuleHandleW(IntPtr.Zero);
        fixed (char* cls = WindowClass)
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = (IntPtr)(delegate* unmanaged<IntPtr, uint, IntPtr, IntPtr, IntPtr>)&WndProc,
                hInstance = instance,
                lpszClassName = (IntPtr)cls,
            };
            if (RegisterClassExW(&wc) == 0)
                throw new InvalidOperationException("RegisterClassEx 失败: " + Marshal.GetLastPInvokeError());
        }

        _hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, WindowClass, "Oopz PTT", WS_POPUP, 0, 0, 0, 0,
            IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero)
            throw new InvalidOperationException("CreateWindowEx 失败: " + Marshal.GetLastPInvokeError());

        _taskbarCreated = RegisterWindowMessageW("TaskbarCreated");
        RegisterRaw(0x06, true);
        UpdateMouseRegistration();

        _ws.Connection += (id, up) => Post(() => OnConnection(id, up));
        _ws.Received += (id, text) => Post(() => OnClientMessage(id, text));
        if (!_ws.Start())
        {
            MessageBoxW(IntPtr.Zero, $"无法监听 127.0.0.1:{WsServer.Port}，端口可能被其他程序占用。", "Oopz 按键说话", MB_ICONWARNING);
            return 1;
        }

        UpdateTray();
        if (_store.FirstRun)
        {
            _store.Save();
            Balloon("Oopz 按键说话已在后台运行", "在 Oopz 网页版「设置 → 语音设置」中选择按键说话并设置快捷键。");
        }
        if (S.OpenOnStart && !_quietStart)
            SetTimer(_hwnd, TimerOpenWeb, 2500, IntPtr.Zero);

        Log.Write($"启动 v{_version}");
        MSG msg;
        while (GetMessageW(&msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        RemoveTray();
        _ws.Stop();
        return 0;
    }

    void Post(Action action)
    {
        _queue.Enqueue(action);
        PostMessageW(_hwnd, WM_PUMP, IntPtr.Zero, IntPtr.Zero);
    }

    [UnmanagedCallersOnly]
    static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (_current != null && _current.Handle(hWnd, msg, wParam, lParam, out var result))
                return result;
        }
        catch (Exception ex)
        {
            Log.Write("消息处理异常: " + ex);
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    bool Handle(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, out IntPtr result)
    {
        result = IntPtr.Zero;
        switch (msg)
        {
            case WM_INPUT:
                OnRawInput(lParam);
                return false; // 交给 DefWindowProc 做清理
            case WM_TIMER:
                OnTimer((nuint)wParam);
                return true;
            case WM_TRAY:
                var m = (uint)(lParam.ToInt64() & 0xFFFF);
                if (m is WM_LBUTTONUP or WM_RBUTTONUP) ShowMenu();
                return true;
            case WM_PUMP:
                while (_queue.TryDequeue(out var a)) a();
                return true;
            case WM_SECOND_INSTANCE:
                if (_ws.Count == 0) OpenWeb();
                else Balloon("Oopz 按键说话已在运行", "右键托盘图标可以打开设置。");
                return true;
            case WM_DESTROY:
                PostQuitMessage(0);
                return true;
        }
        if (msg == _taskbarCreated && msg != 0)
        {
            // 资源管理器重启后托盘图标会丢失，需要重新添加
            _trayAdded = false;
            _trayKey = -1;
            UpdateTray();
            return true;
        }
        return false;
    }

    // ---------------- 原始输入 ----------------

    void RegisterRaw(ushort usage, bool on)
    {
        var dev = new RAWINPUTDEVICE
        {
            UsagePage = 0x01,
            Usage = usage,
            Flags = on ? RIDEV_INPUTSINK : RIDEV_REMOVE,
            Target = on ? _hwnd : IntPtr.Zero,
        };
        if (RegisterRawInputDevices(&dev, 1, (uint)sizeof(RAWINPUTDEVICE)) == 0)
            Log.Write($"RegisterRawInputDevices(usage={usage}, on={on}) 失败: {Marshal.GetLastPInvokeError()}");
    }

    // 鼠标原始输入量很大（每次移动都有），只在需要时才注册
    void UpdateMouseRegistration()
    {
        bool need = _learning || (S.Ptt && S.Binding is { IsMouse: true });
        if (need == _mouseRegistered) return;
        RegisterRaw(0x02, need);
        _mouseRegistered = need;
    }

    void OnRawInput(IntPtr hRaw)
    {
        const int capacity = 64;
        byte* buf = stackalloc byte[capacity];
        uint size = capacity;
        uint hdr = (uint)sizeof(RAWINPUTHEADER);
        uint n = GetRawInputData(hRaw, RID_INPUT, buf, &size, hdr);
        if (n == 0 || n == uint.MaxValue) return;

        var header = (RAWINPUTHEADER*)buf;
        byte* data = buf + hdr;
        if (header->Type == RIM_TYPEKEYBOARD)
        {
            ushort make = *(ushort*)data;
            ushort flags = *(ushort*)(data + 2);
            ushort vkey = *(ushort*)(data + 6);
            if (vkey == 0 || vkey >= 0xFF) return;
            int vk = NormalizeVk(vkey, make, flags);
            bool up = (flags & RI_KEY_BREAK) != 0;
            bool wasDown = _down[vk];
            _down[vk] = !up;
            if (!up && wasDown) return; // 自动重复
            OnButton(false, vk, up);
        }
        else if (header->Type == RIM_TYPEMOUSE)
        {
            ushort bf = *(ushort*)(data + 4);
            if (bf == 0) return;
            if ((bf & 0x0010) != 0) OnButton(true, 3, false);
            if ((bf & 0x0020) != 0) OnButton(true, 3, true);
            if ((bf & 0x0040) != 0) OnButton(true, 4, false);
            if ((bf & 0x0080) != 0) OnButton(true, 4, true);
            if ((bf & 0x0100) != 0) OnButton(true, 5, false);
            if ((bf & 0x0200) != 0) OnButton(true, 5, true);
        }
    }

    static int NormalizeVk(int vk, ushort make, ushort flags)
    {
        bool e0 = (flags & RI_KEY_E0) != 0;
        return vk switch
        {
            0x10 => make == 0x36 ? 0xA1 : 0xA0,
            0x11 => e0 ? 0xA3 : 0xA2,
            0x12 => e0 ? 0xA5 : 0xA4,
            _ => vk,
        };
    }

    static bool IsModifier(int vk) => vk is 0xA0 or 0xA1 or 0xA2 or 0xA3 or 0xA4 or 0xA5 or 0x5B or 0x5C;

    static bool Pressed(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;

    static int CurrentMods()
    {
        int m = 0;
        if (Pressed(0x11)) m |= 1;
        if (Pressed(0x10)) m |= 2;
        if (Pressed(0x12)) m |= 4;
        if (Pressed(0x5B) || Pressed(0x5C)) m |= 8;
        return m;
    }

    void OnButton(bool mouse, int code, bool up)
    {
        if (_learning)
        {
            Learn(mouse, code, up);
            return;
        }
        var b = S.Binding;
        if (!S.Ptt || b == null || b.IsMouse != mouse || b.Code != code) return;
        if (up) Release();
        else if ((CurrentMods() & b.Mods) == b.Mods) Press();
    }

    // ---------------- 按键说话 ----------------

    void Press()
    {
        KillTimer(_hwnd, TimerRelease);
        bool changed = !_held || !_open;
        _held = true;
        _open = true;
        _watchMiss = 0;
        SetTimer(_hwnd, TimerWatchdog, 150, IntPtr.Zero);
        if (changed) NotifyPtt();
    }

    void Release()
    {
        if (!_held) return;
        _held = false;
        KillTimer(_hwnd, TimerWatchdog);
        if (S.Delay <= 0) _open = false;
        else SetTimer(_hwnd, TimerRelease, (uint)S.Delay, IntPtr.Zero);
        NotifyPtt();
    }

    void ResetPtt(bool notify)
    {
        KillTimer(_hwnd, TimerRelease);
        KillTimer(_hwnd, TimerWatchdog);
        bool changed = _held || _open;
        _held = false;
        _open = false;
        if (notify && changed) NotifyPtt();
    }

    // 锁屏、UAC 等情况下可能收不到松开事件，定时核对一次真实按键状态
    void Watchdog()
    {
        var b = S.Binding;
        if (!_held || b == null)
        {
            KillTimer(_hwnd, TimerWatchdog);
            return;
        }
        int vk = b.IsMouse ? b.Code switch { 3 => 0x04, 4 => 0x05, _ => 0x06 } : b.Code;
        if (Pressed(vk))
        {
            _watchMiss = 0;
            return;
        }
        if (++_watchMiss >= 2)
        {
            if (!b.IsMouse) _down[b.Code] = false;
            Release();
        }
    }

    void NotifyPtt()
    {
        _ws.Broadcast(Json(new OutMsg { T = "ptt", Held = _held, Open = _open }));
        UpdateTray();
    }

    // ---------------- 录制快捷键 ----------------

    void StartLearn()
    {
        ResetPtt(true);
        _learning = true;
        _learnMod = 0;
        UpdateMouseRegistration();
        SetTimer(_hwnd, TimerLearn, 15000, IntPtr.Zero);
    }

    void EndLearn(Binding? result)
    {
        if (!_learning) return;
        _learning = false;
        KillTimer(_hwnd, TimerLearn);
        if (result != null)
        {
            S.Binding = result;
            _store.Save();
            _ws.Broadcast(Json(new OutMsg { T = "learned", Binding = result }));
        }
        else
        {
            _ws.Broadcast(Json(new OutMsg { T = "learnEnd" }));
        }
        UpdateMouseRegistration();
        BroadcastState();
    }

    void Learn(bool mouse, int code, bool up)
    {
        if (mouse)
        {
            if (!up) EndLearn(new Binding { Dev = "mouse", Code = code, Mods = CurrentMods() });
            return;
        }
        if (IsModifier(code))
        {
            // 单独按下再松开一个修饰键，就绑定这个修饰键本身
            if (!up) _learnMod = code;
            else if (_learnMod == code) EndLearn(new Binding { Dev = "kb", Code = code });
            return;
        }
        if (up) return;
        if (code == VK_ESCAPE)
        {
            EndLearn(null);
            return;
        }
        EndLearn(new Binding { Dev = "kb", Code = code, Mods = CurrentMods() });
    }

    // ---------------- 网页通信 ----------------

    void OnConnection(int id, bool up)
    {
        if (up) SendState(id);
        else if (_ws.Count == 0 && _learning) EndLearn(null);
        UpdateTray();
    }

    void OnClientMessage(int id, string text)
    {
        InMsg? msg;
        try { msg = JsonSerializer.Deserialize(text, JsonCtx.Default.InMsg); }
        catch (JsonException) { return; }
        switch (msg?.T)
        {
            case "hello":
                SendState(id);
                break;
            case "set" when msg.Cfg != null:
                ApplyPatch(msg.Cfg);
                break;
            case "learn":
                StartLearn();
                break;
            case "learnCancel":
                EndLearn(null);
                break;
        }
    }

    void ApplyPatch(CfgPatch p)
    {
        var oldMode = S.Mode;
        var oldBinding = S.Binding;
        if (p.Mode != null) S.Mode = p.Mode;
        if (p.Delay != null) S.Delay = p.Delay.Value;
        if (p.ClearBinding == true) S.Binding = null;
        else if (p.Binding != null) S.Binding = p.Binding;
        S.Normalize();
        _store.Save();

        if (S.Mode != oldMode || !SameBinding(oldBinding, S.Binding)) ResetPtt(false);
        UpdateMouseRegistration();
        BroadcastState();
    }

    static bool SameBinding(Binding? a, Binding? b) =>
        a == null ? b == null : b != null && a.Dev == b.Dev && a.Code == b.Code && a.Mods == b.Mods;

    OutMsg StateMsg() => new() { T = "state", V = _version, Cfg = S, Held = _held, Open = _open };

    void SendState(int id) => _ws.Send(id, Json(StateMsg()));

    void BroadcastState()
    {
        _ws.Broadcast(Json(StateMsg()));
        UpdateTray();
    }

    static string Json(OutMsg m) => JsonSerializer.Serialize(m, JsonCtx.Default.OutMsg);

    // ---------------- 定时器 ----------------

    void OnTimer(nuint id)
    {
        switch (id)
        {
            case TimerRelease:
                KillTimer(_hwnd, TimerRelease);
                if (!_held && _open)
                {
                    _open = false;
                    NotifyPtt();
                }
                break;
            case TimerWatchdog:
                Watchdog();
                break;
            case TimerOpenWeb:
                KillTimer(_hwnd, TimerOpenWeb);
                if (_ws.Count == 0) OpenWeb();
                break;
            case TimerLearn:
                EndLearn(null);
                break;
        }
    }

    // ---------------- 托盘 ----------------

    void UpdateTray()
    {
        // 0=未连接 1=已连接待机 2=正在说话
        int state = _ws.Count == 0 ? 0 : _open ? 2 : 1;
        // 「已连接」的提示文字还取决于发言模式，缓存键必须包含它，
        // 否则切换自由发言/按键说话时托盘提示不会更新。
        int key = (state << 1) | (S.Ptt ? 1 : 0);
        if (key == _trayKey && _trayAdded) return;
        _trayKey = key;

        int size = GetSystemMetrics(SM_CXSMICON);
        if (size <= 0) size = 16;
        uint color = state switch
        {
            0 => 0xFF8C8C8C,
            2 => 0xFF2DB55D,
            _ => LightTaskbar() ? 0xFF303030 : 0xFFEDEDED,
        };
        var icon = MicIcon.Create(size, color);
        string tip = state switch
        {
            0 => "Oopz 按键说话 - 等待网页连接",
            2 => "Oopz 按键说话 - 正在说话",
            _ => S.Ptt ? "Oopz 按键说话 - 已连接（按键说话）" : "Oopz 按键说话 - 已连接（自由发言）",
        };

        var nid = NewNotifyData();
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = icon;
        CopyTo(tip, nid.szTip, 128);
        int ok = Shell_NotifyIconW(_trayAdded ? NIM_MODIFY : NIM_ADD, &nid);
        if (ok != 0) _trayAdded = true;

        if (_trayIcon != IntPtr.Zero) DestroyIcon(_trayIcon);
        _trayIcon = icon;
    }

    void RemoveTray()
    {
        if (!_trayAdded) return;
        var nid = NewNotifyData();
        Shell_NotifyIconW(NIM_DELETE, &nid);
        _trayAdded = false;
    }

    void Balloon(string title, string text)
    {
        if (!_trayAdded) return;
        var nid = NewNotifyData();
        nid.uFlags = NIF_INFO;
        nid.dwInfoFlags = NIIF_INFO | NIIF_NOSOUND;
        CopyTo(title, nid.szInfoTitle, 64);
        CopyTo(text, nid.szInfo, 256);
        Shell_NotifyIconW(NIM_MODIFY, &nid);
    }

    NOTIFYICONDATAW NewNotifyData() => new()
    {
        cbSize = (uint)sizeof(NOTIFYICONDATAW),
        hWnd = _hwnd,
        uID = 1,
    };

    static bool LightTaskbar()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return k?.GetValue("SystemUsesLightTheme") is int v && v != 0;
        }
        catch { return false; }
    }

    void ShowMenu()
    {
        var menu = CreatePopupMenu();
        bool connected = _ws.Count > 0;
        bool elevated = Environment.IsPrivilegedProcess;
        AppendMenuW(menu, MF_STRING, CmdOpenWeb, "打开 Oopz 网页版");
        AppendMenuW(menu, IsAutoStart() ? MF_CHECKED : MF_STRING, CmdAutoStart, "开机自动启动");
        AppendMenuW(menu, S.OpenOnStart ? MF_CHECKED : MF_STRING, CmdOpenOnStart, "启动时打开网页");
        AppendMenuW(menu, elevated ? MF_GRAYED : MF_STRING, CmdRunAsAdmin, elevated ? "已以管理员身份运行" : "以管理员身份重新启动");
        AppendMenuW(menu, MF_SEPARATOR, 0, null);
        AppendMenuW(menu, MF_GRAYED, 0, $"版本 {_version}");
        AppendMenuW(menu, MF_STRING, CmdExit, "退出");

        POINT pt;
        GetCursorPos(&pt);
        SetForegroundWindow(_hwnd);
        int cmd = TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, pt.X, pt.Y, _hwnd, IntPtr.Zero);
        PostMessageW(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
        DestroyMenu(menu);

        switch ((nuint)cmd)
        {
            case CmdOpenWeb:
                OpenWeb();
                break;
            case CmdAutoStart:
                SetAutoStart(!IsAutoStart());
                break;
            case CmdOpenOnStart:
                S.OpenOnStart = !S.OpenOnStart;
                _store.Save();
                break;
            case CmdRunAsAdmin:
                RestartElevated();
                break;
            case CmdExit:
                DestroyWindow(_hwnd);
                break;
        }
    }

    static void OpenWeb() => ShellExecuteW(IntPtr.Zero, "open", OopzUrl, null, null, SW_SHOWNORMAL);

    static string ExePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "OopzPtt.exe");

    static bool IsAutoStart()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue(RunValue) is string s && s.Contains(ExePath, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static void SetAutoStart(bool on)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunKey);
            if (on) k.SetValue(RunValue, $"\"{ExePath}\" --autostart");
            else k.DeleteValue(RunValue, false);
        }
        catch (Exception ex)
        {
            Log.Write("设置开机启动失败: " + ex.Message);
        }
    }

    void RestartElevated()
    {
        var r = ShellExecuteW(IntPtr.Zero, "runas", ExePath, "--relaunch", null, SW_SHOWNORMAL);
        if (r.ToInt64() > 32) DestroyWindow(_hwnd);
    }
}
