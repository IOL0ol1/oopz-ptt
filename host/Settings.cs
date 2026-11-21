using System.Text.Json;
using System.Text.Json.Serialization;

namespace OopzPtt;

public sealed class Binding
{
    // "kb": Code 为 Windows 虚拟键码（左右修饰键区分）；"mouse": Code 3=中键 4=侧键1 5=侧键2
    public string Dev { get; set; } = "kb";
    public int Code { get; set; }
    // 1=Ctrl 2=Shift 4=Alt 8=Win
    public int Mods { get; set; }

    public bool IsMouse => Dev == "mouse";

    public bool IsValid() => Dev switch
    {
        "kb" => Code is > 0 and < 255,
        "mouse" => Code is >= 3 and <= 5,
        _ => false,
    };
}

public sealed class Settings
{
    public string Mode { get; set; } = "free";
    public Binding? Binding { get; set; }
    public int Delay { get; set; } = 200;
    public bool OpenOnStart { get; set; } = true;

    public bool Ptt => Mode == "ptt";

    public void Normalize()
    {
        if (Mode != "ptt") Mode = "free";
        Delay = Math.Clamp(Delay, 0, 2000);
        if (Binding != null)
        {
            Binding.Mods &= 0xF;
            if (!Binding.IsValid()) Binding = null;
        }
    }
}

public sealed class CfgPatch
{
    public string? Mode { get; set; }
    public Binding? Binding { get; set; }
    public bool? ClearBinding { get; set; }
    public int? Delay { get; set; }
}

public sealed class InMsg
{
    public string? T { get; set; }
    public string? V { get; set; }
    public CfgPatch? Cfg { get; set; }
}

public sealed class OutMsg
{
    public string T { get; set; } = "";
    public string? V { get; set; }
    public Settings? Cfg { get; set; }
    public bool? Held { get; set; }
    public bool? Open { get; set; }
    public Binding? Binding { get; set; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Settings))]
[JsonSerializable(typeof(InMsg))]
[JsonSerializable(typeof(OutMsg))]
internal partial class JsonCtx : JsonSerializerContext
{
    static JsonCtx? _indented;

    public static JsonCtx Indented =>
        _indented ??= new JsonCtx(new JsonSerializerOptions(Default.Options) { WriteIndented = true });
}

internal sealed class SettingsStore
{
    readonly string _path;

    public SettingsStore(string dir)
    {
        _path = Path.Combine(dir, "settings.json");
        Load();
    }

    public Settings Current { get; private set; } = new();
    public bool FirstRun { get; private set; }

    void Load()
    {
        try
        {
            if (File.Exists(_path))
                Current = JsonSerializer.Deserialize(File.ReadAllText(_path), JsonCtx.Default.Settings) ?? new();
            else
                FirstRun = true;
        }
        catch (Exception ex)
        {
            Log.Write("读取设置失败: " + ex.Message);
            Current = new();
        }
        Current.Normalize();
    }

    public void Save()
    {
        try
        {
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(Current, JsonCtx.Indented.Settings));
            File.Move(tmp, _path, true);
        }
        catch (Exception ex)
        {
            Log.Write("保存设置失败: " + ex.Message);
        }
    }
}
