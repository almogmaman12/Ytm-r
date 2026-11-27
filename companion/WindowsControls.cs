using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace YtmCompanion;

internal static class WindowsControls
{
    internal record Output(string id, string name);
    internal record AudioState(int? volume, bool? muted, string? device, Output[] devices);
    private static string Id(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..32];
    internal static AudioState ReadAudio()
    {
        try
        {
            using var e = new MMDeviceEnumerator();
            using var current = e.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var outputs = new List<Output>();
            foreach (var d in e.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                using (d)
                {
                    if (outputs.Count >= 12) continue;
                    var name = d.FriendlyName;
                    outputs.Add(new Output(Id(d.ID), name[..Math.Min(name.Length, 96)]));
                }
            }
            return new AudioState((int)Math.Round(current.AudioEndpointVolume.MasterVolumeLevelScalar * 100),
                current.AudioEndpointVolume.Mute, Id(current.ID), outputs.ToArray());
        }
        catch { return new AudioState(null, null, null, Array.Empty<Output>()); }
    }
    internal static bool Valid(string action, JsonElement value) => action switch
    {
        "volume" => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out int n) && n >= 0 && n <= 100,
        "mute" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "output" => value.ValueKind == JsonValueKind.String && System.Text.RegularExpressions.Regex.IsMatch(value.GetString()!, @"\A[0-9a-f]{32}\z"),
        "media_toggle" or "media_next" or "media_previous" or "media_stop" or "chrome_open" or "chrome_close" =>
            value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined,
        _ => false
    };

    internal static string Execute(string action, JsonElement value)
    {
        if (!Valid(action,value)) throw new ArgumentException("Invalid action.");
        switch (action)
        {
            case "volume":
            case "mute":
                using (var e = new MMDeviceEnumerator())
                using (var d = e.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia))
                {
                    if (action == "volume") d.AudioEndpointVolume.MasterVolumeLevelScalar = value.GetInt32() / 100f;
                    else d.AudioEndpointVolume.Mute = value.GetBoolean();
                }
                return "Windows audio updated.";
            case "output":
                SelectOutput(value.GetString()!);
                return "Default output changed. Apps using a fixed device may not follow it.";
            case "media_toggle": MediaKey(0xB3); return "Play/pause key sent.";
            case "media_next": MediaKey(0xB0); return "Next media key sent.";
            case "media_previous": MediaKey(0xB1); return "Previous media key sent.";
            case "media_stop": MediaKey(0xB2); return "Stop media key sent.";
            case "chrome_open": OpenChrome(); return "Chrome launch requested.";
            case "chrome_close":
                return CloseChrome() == 0 ? "No visible Chrome windows to close." : "Chrome close requested. Dialogs or background processes may remain.";
            default: throw new ArgumentException("Unknown action.");
        }
    }

    // Windows does not expose a documented default-endpoint setter. This narrowly scoped
    // compatibility interface may be unavailable on future builds; fail without changing anything else.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat();
        [PreserveSig] int GetDeviceFormat();
        [PreserveSig] int ResetDeviceFormat();
        [PreserveSig] int SetDeviceFormat();
        [PreserveSig] int GetProcessingPeriod();
        [PreserveSig] int SetProcessingPeriod();
        [PreserveSig] int GetShareMode();
        [PreserveSig] int SetShareMode();
        [PreserveSig] int GetPropertyValue();
        [PreserveSig] int SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, Role role);
    }
    private static void SelectOutput(string id)
    {
        using var e = new MMDeviceEnumerator();
        string? raw = null;
        foreach (var d in e.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            using (d) { if (Id(d.ID) == id) raw = d.ID; }
        if (raw is null) throw new InvalidOperationException("Output device is not available.");
        object policy = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9"), true)!)!;
        try
        {
            var p = (IPolicyConfig)policy;
            Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(raw, Role.Multimedia));
            Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(raw, Role.Console));
            // Communications routing is intentionally preserved.
        }
        finally { Marshal.ReleaseComObject(policy); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyInput { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeyInput key;
        [FieldOffset(0)] public MouseInput mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint type; public InputUnion data; }
    [DllImport("user32.dll", SetLastError=true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    private static void MediaKey(ushort key)
    {
        var down = new Input { type=1, data=new InputUnion { key=new KeyInput { vk=key,flags=1 } } };
        var up = new Input { type=1, data=new InputUnion { key=new KeyInput { vk=key,flags=3 } } };
        if (SendInput(2,new[]{down,up},Marshal.SizeOf<Input>()) != 2)
            throw new InvalidOperationException("Windows did not accept the media key.");
    }

    private static string[] ChromePaths() => new[] {
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
    }.Where(x=>!string.IsNullOrWhiteSpace(x)).Select(x=>Path.Combine(x,"Google","Chrome","Application","chrome.exe")).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    private static HashSet<int> ChromeProcesses()
    {
        var ids = new HashSet<int>();
        using var current = Process.GetCurrentProcess();
        var paths = ChromePaths();
        foreach(var p in Process.GetProcessesByName("chrome"))
        {
            using(p)
            {
                try
                {
                    if(p.SessionId==current.SessionId && paths.Contains(p.MainModule?.FileName,StringComparer.OrdinalIgnoreCase)) ids.Add(p.Id);
                }
                catch { }
            }
        }
        return ids;
    }
    internal static bool ChromeRunning() => ChromeProcesses().Count > 0;
    internal static bool ChromeOpen() => ChromeWindows(false) > 0;
    private static void OpenChrome()
    {
        var path = ChromePaths().FirstOrDefault(File.Exists) ?? throw new InvalidOperationException("Chrome was not found in a standard installation folder.");
        using var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }
    private delegate bool WindowCallback(IntPtr hwnd,IntPtr data);
    [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder name,int maxCount);
    private static int CloseChrome() => ChromeWindows(true);
    private static int ChromeWindows(bool close)
    {
        var ids=ChromeProcesses();
        int count=0;
        EnumWindows((hwnd,_)=>{
            GetWindowThreadProcessId(hwnd,out uint pid);
            if(!ids.Contains((int)pid)||!IsWindowVisible(hwnd)) return true;
            var name=new StringBuilder(64);
            if(GetClassName(hwnd,name,name.Capacity)>0 && name.ToString()=="Chrome_WidgetWin_1" && (!close||PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero))) count++;
            return true;
        },IntPtr.Zero);
        return count;
    }
}
