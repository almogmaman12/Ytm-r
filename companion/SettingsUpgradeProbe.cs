#if SETTINGS_UPGRADE_TEST
using System.Text.Json;
using System.Text.Json.Nodes;
using Windows.ApplicationModel;

namespace YtmCompanion;

// Compiled only into disposable CI test packages, never production releases.
internal static class SettingsUpgradeProbe
{
    private const string Password = "test-only-msix-password";
    private static readonly NativeCredentials Credentials = new("abcdefghijklmnopqrstuvwx_1234",
        "test-only-pc-code","https://relay.example.com");
    internal static bool TryRun(string[] args)
    {
        if (args.Length!=3 || args[0]!="--settings-upgrade-probe") return false;
        if (!Store.Packaged || Package.Current.Id.Publisher!="CN=YTM Remote Companion CI Test")
            throw new InvalidOperationException("Probe requires the disposable CI package.");
        var result=Path.GetFullPath(args[2]);
        try
        {
            var version=CompanionUpdater.CurrentVersion();
            var path=Path.Combine(Store.Folder,"settings.json");
            if(args[1]=="seed")
            {
                if(version!=new Version(0,1,0,1)||Store.Exists)throw new InvalidOperationException("Unexpected seed environment.");
                var s=new Settings { ExtensionFolder=@"C:\CI\Extension",PublicKey=PublisherTrust.PublicKey ?? "",
                    AutomaticUpdates=true,StartWithWindows=true,NativeConfig=Credentials.Protect(),
                    NativeControls=true,NativeRemoteUpdates=true,NativeCompanionUpdates=true };
                Store.SetPassword(s,Password);
                Store.Save(s);
                // Recreate an actual pre-schema settings file with no backup, as shipped before this change.
                var legacy=JsonNode.Parse(File.ReadAllText(path))!.AsObject();
                legacy.Remove("SchemaVersion");
                File.WriteAllText(path,legacy.ToJsonString());
                File.Delete(Store.MirrorPath(path));
                File.WriteAllText(result,"PASS seed "+version);
            }
            else if(args[1]=="verify")
            {
                if(version!=new Version(0,1,0,2))throw new InvalidOperationException("Upgrade did not activate v2.");
                var s=Store.Load();
                if(s.SchemaVersion!=Store.CurrentSchema||s.ExtensionFolder!=@"C:\CI\Extension"||
                    !s.AutomaticUpdates||!s.StartWithWindows||!s.NativeControls||!s.NativeRemoteUpdates||
                    !s.NativeCompanionUpdates||!Store.Verify(s,Password)||NativeCredentials.Unprotect(s.NativeConfig)!=Credentials)
                    throw new InvalidDataException("Settings did not survive the actual package upgrade.");
                if(!File.Exists(Store.MirrorPath(path)))throw new InvalidDataException("Mirror missing after migration.");
                Store.BackupBeforeUpdate();
                if(!File.Exists(Store.UpdateBackupPath(path)))throw new InvalidDataException("Pre-update snapshot missing.");
                File.WriteAllText(path,"{corrupt");
                var recovered=Store.Load();
                if(!Store.RecoveredOnLoad||!Store.Verify(recovered,Password)||NativeCredentials.Unprotect(recovered.NativeConfig)!=Credentials)
                    throw new InvalidDataException("Packaged settings recovery failed.");
                File.WriteAllText(result,"PASS verify "+version);
            }
            else throw new InvalidOperationException("Unknown probe phase.");
        }
        catch(Exception e)
        {
            File.WriteAllText(result,"FAIL "+e.GetType().Name+": "+e.Message);
            Environment.ExitCode=1;
        }
        return true;
    }
}
#endif
