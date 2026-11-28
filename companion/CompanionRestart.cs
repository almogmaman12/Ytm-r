using System.Security.Principal;
using System.Text;
using Windows.ApplicationModel;

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
        string script=Script.Replace("@@FAMILY@@",family).Replace("@@VERSION@@",target.ToString())
            .Replace("@@TASK@@",name).Replace("@@PID@@",Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Replace("@@ARGS@@",Convert.ToBase64String(Encoding.UTF8.GetBytes(activationArgs)));
        string encoded=Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
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
        action.Path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
        action.Arguments="-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand "+encoded;
        // Register before requesting deployment. If policy prevents this, do not terminate the companion.
        folder.RegisterTaskDefinition(name,def,2,sid,null,3,null);
    }

    private const string Script = """
$ErrorActionPreference='Stop'
$family='@@FAMILY@@'
$target=[version]'@@VERSION@@'
$task='@@TASK@@'
$oldPid=@@PID@@
$arguments=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@ARGS@@'))
function Log([string]$message) {
    try {
        $dir=Join-Path $env:LOCALAPPDATA 'YTM Remote Companion'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'restart.log') -Value ((Get-Date -Format o)+' '+$message)
    } catch {}
}
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IYtmActivation {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
public static class YtmRestartActivation {
    public static uint Launch(string aumid,string args) {
        var instance=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        try {
            uint pid;
            int hr=((IYtmActivation)instance).ActivateApplication(aumid,args,0,out pid);
            Marshal.ThrowExceptionForHR(hr);
            return pid;
        } finally { Marshal.ReleaseComObject(instance); }
    }
}
'@
    $deadline=(Get-Date).AddMinutes(6)
    $end=(Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $end) {
        try {
            $pkg=Get-AppxPackage -Name 'YtmRemote.Companion' | Where-Object { $_.PackageFamilyName -eq $family } | Sort-Object Version -Descending | Select-Object -First 1
            if ($pkg) {
                $exe=Join-Path $pkg.InstallLocation 'YtmCompanion.exe'
                $running=@(Get-Process -Name 'YtmCompanion' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
                $upgraded=([version]$pkg.Version -ge $target)
                if ($upgraded -and $running.Count -gt 0) { Log 'Updated companion already running.'; return }
                $old=Get-Process -Id $oldPid -ErrorAction SilentlyContinue
                $oldAlive=($old -and $old.ProcessName -eq 'YtmCompanion')
                if (($upgraded -or (Get-Date) -ge $deadline) -and !$oldAlive) {
                    if ($running.Count -gt 0) { Log 'Existing companion still running.'; return }
                    $launched=[YtmRestartActivation]::Launch($family+'!Companion',$arguments)
                    if ($arguments -eq '--background') {
                        Start-Sleep -Seconds 3
                        if (!(Get-Process -Id $launched -ErrorAction SilentlyContinue)) { throw 'Companion exited before startup completed.' }
                    }
                    Log ('Activated companion '+$pkg.Version+' (PID '+$launched+').')
                    return
                }
                if ((Get-Date) -ge $deadline -and $oldAlive -and !$upgraded) { Log 'Update did not complete; original companion still running.'; return }
            }
        } catch { Log ('Restart retry: '+$_.Exception.GetType().Name) }
        Start-Sleep -Seconds 3
    }
    Log 'Restart timed out; open YTM Remote Companion from Start.'
} catch { Log ('Restart failed: '+$_.Exception.GetType().Name) }
finally {
    try { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop } catch {}
}
""";
}
