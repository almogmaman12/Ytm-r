using System.Security.Principal;
using System.Text;
using Windows.ApplicationModel;
using ApplicationData = Windows.Storage.ApplicationData;

namespace YtmCompanion;

// An independent, time-limited, non-elevated task survives MSIX termination of the tray app.
internal static class CompanionRestart
{
    internal static void Schedule(Version target)
    {
        if (!CompanionUpdater.Supported()) throw new InvalidOperationException("App Installer association required.");
        ScheduleCore(target,"--background");
    }
#if SETTINGS_UPGRADE_TEST
    internal static void ScheduleTest(Version target,string result)
    {
        if (!Store.Packaged || Package.Current.Id.Publisher != "CN=YTM Remote Companion CI Test")
            throw new InvalidOperationException("CI package required.");
        ScheduleCore(target,"--settings-upgrade-probe verify \""+result+"\"");
    }
#endif
    private static void ScheduleCore(Version target,string activationArgs)
    {
        if (target<=CompanionUpdater.CurrentVersion()) throw new InvalidOperationException("Expected a newer package.");
        var family=Package.Current.Id.FamilyName;
        if (!System.Text.RegularExpressions.Regex.IsMatch(family,@"\AYtmRemote\.Companion_[a-z0-9]+\z"))
            throw new InvalidOperationException("Unexpected package family.");
        string name="YtmRemoteCompanion-Restart-"+Guid.NewGuid().ToString("N");
        // Copy the signed package's own windowless helper outside the versioned install directory.
        // LocalFolder survives in-place MSIX updates and is readable by the current user's task.
        string root=Path.Combine(ApplicationData.Current.LocalFolder.Path,"Restart");
        Directory.CreateDirectory(root);
        foreach(var old in Directory.EnumerateDirectories(root))
        {
            try { if(DateTime.UtcNow-Directory.GetCreationTimeUtc(old)>TimeSpan.FromDays(1) && (File.GetAttributes(old)&FileAttributes.ReparsePoint)==0) Directory.Delete(old,true); }
            catch {}
        }
        string work=Path.Combine(root,name);
        Directory.CreateDirectory(work);
        string source=Path.Combine(Package.Current.InstalledLocation.Path,"YtmRestartHelper.exe");
        string helper=Path.Combine(work,"YtmRestartHelper.exe");
        File.Copy(source,helper,false);
        string encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(activationArgs));
        var sid=WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Missing Windows user.");
        var scheduler=Type.GetTypeFromProgID("Schedule.Service") ?? throw new InvalidOperationException("Task Scheduler unavailable.");
        dynamic service=Activator.CreateInstance(scheduler)!;
        service.Connect();
        dynamic folder=service.GetFolder("\\");
        dynamic def=service.NewTask(0);
        def.RegistrationInfo.Description="One-time YTM Remote Companion restart after a signed package update.";
        def.Principal.UserId=sid;
        def.Principal.LogonType=3; // TASK_LOGON_INTERACTIVE_TOKEN, no stored password
        def.Principal.RunLevel=0; // least privilege
        def.Settings.Enabled=true;
        def.Settings.StartWhenAvailable=true;
        def.Settings.DisallowStartIfOnBatteries=false;
        def.Settings.StopIfGoingOnBatteries=false;
        def.Settings.ExecutionTimeLimit="PT12M";
        def.Settings.DeleteExpiredTaskAfter="PT1M";
        def.Settings.MultipleInstances=2; // ignore duplicate starts
        dynamic trigger=def.Triggers.Create(1); // one-time trigger
        trigger.StartBoundary=DateTime.Now.AddSeconds(8).ToString("yyyy-MM-dd'T'HH:mm:ss");
        trigger.EndBoundary=DateTime.Now.AddMinutes(12).ToString("yyyy-MM-dd'T'HH:mm:ss");
        dynamic action=def.Actions.Create(0);
        action.Path=helper;
        action.Arguments=family+" "+target+" "+name+" "+Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)+" "+encoded;
        action.WorkingDirectory=work;
        // Register before requesting deployment. If policy prevents this, do not terminate the companion.
        try { folder.RegisterTaskDefinition(name,def,2,sid,null,3,null); }
        catch { try { Directory.Delete(work,true); } catch {} throw; }
    }

}
