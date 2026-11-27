using YtmCompanion;

if (args.Length == 1 && args[0] == "updater") { await UpdaterTests.Run(); return; }
if (args.Length == 1 && args[0] == "native")
{
    var credentials = new NativeCredentials("abcdefghijklmnopqrstuvwx_1234", "test-only-pc-code", "https://relay.example.com:8443");
    var encrypted = credentials.Protect();
    if (encrypted.Contains(credentials.Token) || NativeCredentials.Unprotect(encrypted) != credentials)
        throw new Exception("Native credential round trip failed.");
    var nonce = "0123456789abcdef0123456789abcdef";
    var expected = Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(credentials.PcCode),
        System.Text.Encoding.UTF8.GetBytes(credentials.Token + "|native|" + nonce))).ToLowerInvariant();
    if (credentials.Proof(nonce) != expected) throw new Exception("Native challenge proof mismatch.");
    bool rejected = false;
    try { new NativeCredentials("short","weak","https://relay.example.com").Protect(); } catch (ArgumentException) { rejected = true; }
    if (!rejected) throw new Exception("Invalid native credentials accepted.");
    if (credentials.SocketUri().AbsoluteUri != "wss://relay.example.com:8443/ws?role=native&token="+credentials.Token)
        throw new Exception("Configurable relay URI mismatch.");
    foreach (var invalid in new[]{"http://relay.example.com","https://user:pass@relay.example.com","https://relay.example.com/path","https://relay.example.com/?q=1","https://relay.example.com/#fragment","wss://relay.example.com",""})
    {
        bool blocked=false;
        try { NativeCredentials.NormalizeRelay(invalid); } catch(ArgumentException) { blocked=true; }
        if(!blocked)throw new Exception("Unsafe relay accepted.");
    }
    if(NativeCredentials.NormalizeRelay(" https://relay.example.com/ ")!="https://relay.example.com")throw new Exception("Relay normalization failed.");
    bool Valid(string action,string json) { using var doc=System.Text.Json.JsonDocument.Parse(json); return WindowsControls.Valid(action,doc.RootElement); }
    if (!Valid("volume","0") || !Valid("volume","100") || Valid("volume","101") || Valid("volume","50.5") ||
        !Valid("mute","true") || Valid("mute","1") || !Valid("output","\""+new string('a',32)+"\"") ||
        Valid("output","\"arbitrary-path\"") || !Valid("media_next","null") || !Valid("chrome_open","null") ||
        !Valid("chrome_close","null") || Valid("chrome_open","\"https://example.com\"") ||
        Valid("powershell","null") || Valid("shutdown","null"))
        throw new Exception("Windows action allowlist failed.");
    var feed=CompanionUpdater.Feed;
    var descriptor=$"""<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2018" Version="0.1.0.8" Uri="{feed}"><MainPackage Name="YtmRemote.Companion" Publisher="CN=YTM Remote Companion" Version="0.1.0.8" ProcessorArchitecture="x64" Uri="{CompanionUpdater.BaseUrl}YtmCompanion-0.1.0.8.msix"/><UpdateSettings/></AppInstaller>""";
    if(CompanionUpdater.ParseFeed(descriptor)!=new Version(0,1,0,8))throw new Exception("Companion feed version mismatch");
    foreach(var invalid in new[]{descriptor.Replace("CN=YTM Remote Companion","CN=Other"),descriptor.Replace("YtmCompanion-0.1.0.8.msix","other.msix"),descriptor.Replace("0.1.0.8","0.1.0.65536"),descriptor.Replace("<UpdateSettings/>","<OptionalPackages/>")})
    {
        bool blocked=false;
        try { CompanionUpdater.ParseFeed(invalid); } catch(InvalidDataException) { blocked=true; }
        if(!blocked)throw new Exception("Invalid companion feed accepted");
    }
    Console.WriteLine("PASS: native DPAPI credentials, authentication proof, Windows action allowlist and companion feed validation");
    return;
}
if (args.Length != 2) throw new ArgumentException("Expected mode and isolated settings path.");
var path = Path.GetFullPath(args[1]);
if (string.Equals(path, Path.Combine(Store.Folder,"settings.json"), StringComparison.OrdinalIgnoreCase))
    throw new ArgumentException("Do not use production settings for tests.");
const string password = "test-only-password";
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
if (args[0] == "write")
{
    Check(!File.Exists(path), "Expected new temporary settings file");
    var s = new Settings { ExtensionFolder = @"C:\Example\Extension", PublicKey = PublisherTrust.PublicKey ?? "",
        AutomaticUpdates = true, StartWithWindows = true };
    Store.SetPassword(s,password);
    Store.SaveTo(s,path);
    Console.WriteLine("PASS: settings saved");
}
else if (args[0] == "read")
{
    var s = Store.LoadFrom(path);
    Check(s.ExtensionFolder == @"C:\Example\Extension","Folder did not persist");
    Check(s.AutomaticUpdates && s.StartWithWindows,"Options did not persist");
    Check(Store.Verify(s,password) && !Store.Verify(s,"incorrect"),"Password verification failed");
    var oldHash=s.PasswordHash;
    s.AutomaticUpdates=false;
    Store.SaveTo(s,path);
    var updated=Store.LoadFrom(path);
    Check(!updated.AutomaticUpdates && updated.StartWithWindows,"Atomic replacement failed");
    Check(updated.PasswordHash==oldHash && Store.Verify(updated,password),"Password changed unexpectedly");
    File.WriteAllText(path,"{invalid");
    bool rejected=false;
    try { Store.LoadFrom(path); } catch { rejected=true; }
    Check(rejected && File.ReadAllText(path)=="{invalid","Corrupt settings must not be silently overwritten");
    Console.WriteLine("PASS: settings and password survived process restart; replacement and corruption checks passed");
}
else throw new ArgumentException("Unknown test mode.");
