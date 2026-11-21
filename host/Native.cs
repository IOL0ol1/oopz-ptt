using System.Runtime.InteropServices;

namespace OopzPtt;

internal static unsafe partial class Native
{
    public const uint WM_DESTROY = 0x0002;
    public const uint WM_INPUT = 0x00FF;
    public const uint WM_TIMER = 0x0113;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_NULL = 0x0000;
    public const uint WM_APP = 0x8000;

    public const uint WS_POPUP = 0x80000000;
    public const uint WS_EX_TOOLWINDOW = 0x00000080;

    public const uint RIM_TYPEMOUSE = 0;
    public const uint RIM_TYPEKEYBOARD = 1;
    public const uint RID_INPUT = 0x10000003;
    public const uint RIDEV_REMOVE = 0x00000001;
    public const uint RIDEV_INPUTSINK = 0x00000100;
    public const ushort RI_KEY_BREAK = 0x01;
    public const ushort RI_KEY_E0 = 0x02;

    public const uint NIM_ADD = 0;
    public const uint NIM_MODIFY = 1;
    public const uint NIM_DELETE = 2;
    public const uint NIF_MESSAGE = 0x01;
    public const uint NIF_ICON = 0x02;
    public const uint NIF_TIP = 0x04;
    public const uint NIF_INFO = 0x10;
    public const uint NIIF_INFO = 0x01;
    public const uint NIIF_NOSOUND = 0x10;

    public const uint MF_STRING = 0x0000;
    public const uint MF_GRAYED = 0x0001;
    public const uint MF_CHECKED = 0x0008;
    public const uint MF_SEPARATOR = 0x0800;
    public const uint TPM_RIGHTBUTTON = 0x0002;
    public const uint TPM_NONOTIFY = 0x0080;
    public const uint TPM_RETURNCMD = 0x0100;

    public const uint MB_ICONWARNING = 0x30;
    public const int SW_SHOWNORMAL = 1;
    public const int SM_CXSMICON = 49;

    [StructLayout(LayoutKind.Sequential)]
    public struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public IntPtr lpszMenuName;
        public IntPtr lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RAWINPUTDEVICE
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RAWINPUTHEADER
    {
        public uint Type;
        public uint Size;
        public IntPtr Device;
        public IntPtr WParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        public fixed char szTip[128];
        public uint dwState;
        public uint dwStateMask;
        public fixed char szInfo[256];
        public uint uVersion;
        public fixed char szInfoTitle[64];
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO
    {
        public int fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    public static partial ushort RegisterClassExW(WNDCLASSEXW* wc);

    [LibraryImport("user32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    public static partial IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [LibraryImport("user32.dll")]
    public static partial IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [LibraryImport("user32.dll")]
    public static partial int GetMessageW(MSG* msg, IntPtr hWnd, uint filterMin, uint filterMax);

    [LibraryImport("user32.dll")]
    public static partial int TranslateMessage(MSG* msg);

    [LibraryImport("user32.dll")]
    public static partial IntPtr DispatchMessageW(MSG* msg);

    [LibraryImport("user32.dll")]
    public static partial int PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [LibraryImport("user32.dll")]
    public static partial void PostQuitMessage(int exitCode);

    [LibraryImport("user32.dll")]
    public static partial int DestroyWindow(IntPtr hWnd);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial IntPtr FindWindowW(string className, string? windowName);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial uint RegisterWindowMessageW(string name);

    [LibraryImport("user32.dll", SetLastError = true)]
    public static partial int RegisterRawInputDevices(RAWINPUTDEVICE* devices, uint count, uint size);

    [LibraryImport("user32.dll")]
    public static partial uint GetRawInputData(IntPtr rawInput, uint command, void* data, uint* size, uint headerSize);

    [LibraryImport("user32.dll")]
    public static partial short GetAsyncKeyState(int vk);

    [LibraryImport("user32.dll")]
    public static partial nuint SetTimer(IntPtr hWnd, nuint id, uint elapse, IntPtr timerProc);

    [LibraryImport("user32.dll")]
    public static partial int KillTimer(IntPtr hWnd, nuint id);

    [LibraryImport("user32.dll")]
    public static partial IntPtr CreatePopupMenu();

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int AppendMenuW(IntPtr menu, uint flags, nuint id, string? text);

    [LibraryImport("user32.dll")]
    public static partial int TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hWnd, IntPtr tpm);

    [LibraryImport("user32.dll")]
    public static partial int DestroyMenu(IntPtr menu);

    [LibraryImport("user32.dll")]
    public static partial int SetForegroundWindow(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    public static partial int GetCursorPos(POINT* point);

    [LibraryImport("user32.dll")]
    public static partial int GetSystemMetrics(int index);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [LibraryImport("user32.dll")]
    public static partial IntPtr CreateIconIndirect(ICONINFO* info);

    [LibraryImport("user32.dll")]
    public static partial int DestroyIcon(IntPtr icon);

    [LibraryImport("gdi32.dll")]
    public static partial IntPtr CreateDIBSection(IntPtr hdc, BITMAPINFOHEADER* info, uint usage, void** bits, IntPtr section, uint offset);

    [LibraryImport("gdi32.dll")]
    public static partial IntPtr CreateBitmap(int width, int height, uint planes, uint bitCount, void* bits);

    [LibraryImport("gdi32.dll")]
    public static partial int DeleteObject(IntPtr obj);

    [LibraryImport("shell32.dll")]
    public static partial int Shell_NotifyIconW(uint message, NOTIFYICONDATAW* data);

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial IntPtr ShellExecuteW(IntPtr hWnd, string? verb, string file, string? args, string? dir, int show);

    [LibraryImport("kernel32.dll")]
    public static partial IntPtr GetModuleHandleW(IntPtr moduleName);

    public static void CopyTo(string? text, char* dest, int capacity)
    {
        var s = (text ?? "").AsSpan();
        if (s.Length >= capacity) s = s[..(capacity - 1)];
        s.CopyTo(new Span<char>(dest, capacity));
        dest[s.Length] = '\0';
    }
}
