using static OopzPtt.Native;

namespace OopzPtt;

internal static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        bool relaunch = args.Contains("--relaunch");
        bool autostart = args.Contains("--autostart");

        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OopzPtt");
        Directory.CreateDirectory(dir);
        Log.Init(dir);

        using var mutex = new Mutex(true, @"Local\OopzPtt.Host", out bool owned);
        if (!owned && relaunch)
        {
            // 以管理员身份重启时，旧进程还没完全退出
            try { owned = mutex.WaitOne(TimeSpan.FromSeconds(5)); }
            catch (AbandonedMutexException) { owned = true; }
        }
        if (!owned)
        {
            var other = FindWindowW(App.WindowClass, null);
            if (other != IntPtr.Zero) PostMessageW(other, App.WM_SECOND_INSTANCE, IntPtr.Zero, IntPtr.Zero);
            return 0;
        }

        try
        {
            return new App(new SettingsStore(dir), autostart || relaunch).Run();
        }
        catch (Exception ex)
        {
            Log.Write("致命错误: " + ex);
            MessageBoxW(IntPtr.Zero, ex.Message, "Oopz 按键说话", MB_ICONWARNING);
            return 1;
        }
        finally
        {
            try { mutex.ReleaseMutex(); } catch { }
        }
    }
}
