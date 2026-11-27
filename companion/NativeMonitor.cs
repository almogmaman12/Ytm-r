using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace YtmCompanion;

// A narrow, read-only connection. No remote command interpreter or process launch.
// The experimental client is deliberately pinned to the test relay, not production.
internal sealed record NativeCredentials(string Token, string PcCode)
{
    public const string Relay = "https://ytm-r.onrender.com";
    public void Validate()
    {
        if (Token is null || !Regex.IsMatch(Token, @"\A[A-Za-z0-9_-]{20,200}\z") ||
            PcCode is null || PcCode.Length < 8 || PcCode.Length > 256)
            throw new ArgumentException("Enter the test relay token and PC code (at least eight characters).");
    }
    public string Protect()
    {
        Validate();
        return Convert.ToBase64String(ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(this), null, DataProtectionScope.CurrentUser));
    }
    public static NativeCredentials Unprotect(string data)
    {
        var value = JsonSerializer.Deserialize<NativeCredentials>(ProtectedData.Unprotect(Convert.FromBase64String(data), null, DataProtectionScope.CurrentUser))
            ?? throw new InvalidDataException("Invalid native credentials.");
        value.Validate();
        return value;
    }
    public string Proof(string nonce) =>
        Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(PcCode), Encoding.UTF8.GetBytes($"{Token}|native|{nonce}"))).ToLowerInvariant();
}

internal sealed class NativeMonitor : IDisposable
{
    private CancellationTokenSource? stop;
    private Task? worker;
    public void Start(string protectedConfig)
    {
        Dispose();
        if (string.IsNullOrEmpty(protectedConfig)) return;
        NativeCredentials config;
        try { config = NativeCredentials.Unprotect(protectedConfig); }
        catch { return; } // damaged or other-user credentials fail closed
        var cts = new CancellationTokenSource();
        stop = cts;
        worker = Task.Run(() => Run(config, cts.Token));
    }
    public void Dispose()
    {
        var old = stop;
        var task = worker;
        stop = null;
        worker = null;
        if (old is null) return;
        old.Cancel();
        if (task is null) old.Dispose();
        else _ = task.ContinueWith(_ => old.Dispose(), TaskScheduler.Default);
    }
    private static async Task Run(NativeCredentials config, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Session(config, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch { /* No secret or relay URL is logged. Retry conservatively. */ }
            try { await Task.Delay(TimeSpan.FromMinutes(2), ct); }
            catch (OperationCanceledException) { break; }
        }
    }
    private static async Task Session(NativeCredentials config, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(25);
        using var auth = CancellationTokenSource.CreateLinkedTokenSource(ct);
        auth.CancelAfter(TimeSpan.FromSeconds(25));
        var uri = new Uri("wss://ytm-r.onrender.com/ws?role=native&token=" + Uri.EscapeDataString(config.Token));
        await ws.ConnectAsync(uri, auth.Token);
        using (var first = await Read(ws, auth.Token))
        {
            var root = first.RootElement;
            if (root.GetProperty("type").GetString() != "challenge") return;
            var nonce = root.GetProperty("nonce").GetString() ?? "";
            if (!Regex.IsMatch(nonce, @"\A[0-9a-f]{32}\z")) return;
            await Send(ws, new { type = "auth", proof = config.Proof(nonce) }, auth.Token);
        }
        using (var second = await Read(ws, auth.Token))
        {
            var root = second.RootElement;
            if (root.GetProperty("type").GetString() != "authed" ||
                !root.TryGetProperty("guarded", out var guarded) || guarded.ValueKind != JsonValueKind.True) return;
        }
        using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var sender = Snapshots(ws, session.Token);
        var receiver = Drain(ws, session.Token);
        try { await Task.WhenAny(sender, receiver); }
        finally
        {
            session.Cancel();
            try { await Task.WhenAll(sender, receiver); } catch { }
        }
    }
    private static async Task Drain(ClientWebSocket ws, CancellationToken ct)
    {
        while (ws.State == WebSocketState.Open)
        {
            using var ignored = await Read(ws, ct);
            // Ignore all incoming messages after authentication: no executable commands.
        }
    }
    private static async Task Snapshots(ClientWebSocket ws, CancellationToken ct)
    {
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            await Send(ws, Snapshot(), ct);
            await Task.Delay(TimeSpan.FromSeconds(60), ct);
        }
    }
    private static async Task<JsonDocument> Read(ClientWebSocket ws, CancellationToken ct)
    {
        var buf = new byte[4096];
        using var output = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(new ArraySegment<byte>(buf), ct);
            if (result.MessageType != WebSocketMessageType.Text || output.Length + result.Count > 4096)
                throw new InvalidDataException("Unexpected native frame.");
            output.Write(buf, 0, result.Count);
        } while (!result.EndOfMessage);
        return JsonDocument.Parse(output.ToArray());
    }
    private static Task Send(ClientWebSocket ws, object data, CancellationToken ct) =>
        ws.SendAsync(new ArraySegment<byte>(JsonSerializer.SerializeToUtf8Bytes(data)), WebSocketMessageType.Text, true, ct);
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus buffer);
    private static object Snapshot()
    {
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        bool available = GlobalMemoryStatusEx(ref memory);
        var power = SystemInformation.PowerStatus;
        var battery = power.BatteryChargeStatus;
        int? percent = battery.HasFlag(BatteryChargeStatus.NoSystemBattery) || battery == BatteryChargeStatus.Unknown
            ? null : Math.Clamp((int)Math.Round(power.BatteryLifePercent * 100), 0, 100);
        return new
        {
            type = "native_snapshot",
            version = typeof(Program).Assembly.GetName().Version?.ToString(4),
            uptime = Math.Max(0L, Environment.TickCount64 / 1000),
            ramTotal = available ? (long?)(memory.TotalPhys / 1048576) : null,
            ramAvailable = available ? (long?)(memory.AvailPhys / 1048576) : null,
            battery = percent,
            power = power.PowerLineStatus == PowerLineStatus.Online ? "ac" :
                power.PowerLineStatus == PowerLineStatus.Offline ? "battery" : "unknown"
        };
    }
}
