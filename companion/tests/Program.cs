using YtmCompanion;

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
