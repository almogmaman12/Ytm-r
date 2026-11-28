using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Windows.Management.Deployment;

internal static class Program
{
    // No console, UI, network requests, credentials, or arbitrary command execution.
    // Task runs as the same signed-in user, independently of the updated MSIX package.
    [STAThread]
    private static int Main(string[] args)
    {
        if(args.Length!=5 || !Regex.IsMatch(args[0],@"\AYtmRemote\.Companion_[a-z0-9]+\z") ||
            !Version.TryParse(args[1],out var target)||target.Revision<0 ||
            !Regex.IsMatch(args[2],@"\AYtmRemoteCompanion-Restart-[0-9a-f]{32}\z") ||
            !int.TryParse(args[3],out int oldPid)||oldPid<=0||args[4].Length>4096)return 1;
        string family=args[0],task=args[2];
        string activation;
        try{activation=Encoding.UTF8.GetString(Convert.FromBase64String(args[4]));}catch{return 1;}
        bool probe=false;
#if SETTINGS_UPGRADE_TEST
        probe=activation.StartsWith("--settings-upgrade-probe verify \"",StringComparison.Ordinal)&&activation.EndsWith('"');
#endif
        if(activation!="--background"&&!probe)return 1;
        var root=Path.GetDirectoryName(Path.GetDirectoryName(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))!)!;
        void Log(string message){try{File.WriteAllText(Path.Combine(root,"restart.log"),DateTimeOffset.Now.ToString("O")+" "+message);}catch{}}
        var fallback=DateTime.UtcNow.AddMinutes(6);
        var deadline=DateTime.UtcNow.AddMinutes(10);
        try
        {
            var manager=new PackageManager();
            while(DateTime.UtcNow<deadline)
            {
                try
                {
                    var pkg=manager.FindPackagesForUser("",family)
                        .Where(p=>p.Id.Name=="YtmRemote.Companion"&&p.Id.FamilyName==family&&
                            (p.Id.Publisher=="CN=YTM Remote Companion"||(probe&&p.Id.Publisher=="CN=YTM Remote Companion CI Test")))
                        .OrderByDescending(p=>VersionOf(p.Id.Version)).FirstOrDefault();
                    if(pkg!=null)
                    {
                        var version=VersionOf(pkg.Id.Version);
                        var exe=Path.Combine(pkg.InstalledLocation.Path,"YtmCompanion.exe");
                        bool running=RunningAt(exe),upgraded=version>=target,oldAlive=OldRunning(oldPid);
                        if(upgraded&&running){Log("Updated companion already running.");return 0;}
                        if((upgraded||DateTime.UtcNow>=fallback)&&!oldAlive)
                        {
                            if(running){Log("Existing companion still running.");return 0;}
                            uint pid=Activate(family+"!Companion",activation);
                            if(!probe){Thread.Sleep(3000);if(!RunningAt(exe))throw new InvalidOperationException("Startup incomplete");}
                            Log("Activated companion "+version+" (PID "+pid+").");return 0;
                        }
                        if(DateTime.UtcNow>=fallback&&oldAlive&&!upgraded){Log("Update not completed; original companion still running.");return 0;}
                    }
                }
                catch(Exception e){Log("Restart retry: "+e.GetType().Name);}
                Thread.Sleep(3000);
            }
            Log("Restart timed out; open YTM Remote Companion from Start.");return 2;
        }
        catch(Exception e){Log("Restart failed: "+e.GetType().Name);return 2;}
        finally
        {
            try
            {
                dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")!)!;
                service.Connect();dynamic folder=service.GetFolder("\\");folder.DeleteTask(task,0);
            }catch{}
        }
    }
    private static Version VersionOf(Windows.ApplicationModel.PackageVersion v)=>new(v.Major,v.Minor,v.Build,v.Revision);
    private static bool OldRunning(int pid)
    {
        try{using var p=Process.GetProcessById(pid);return !p.HasExited&&p.ProcessName.Equals("YtmCompanion",StringComparison.OrdinalIgnoreCase);}catch{return false;}
    }
    private static bool RunningAt(string exe)
    {
        var processes=Process.GetProcessesByName("YtmCompanion");
        try
        {
            foreach(var p in processes)
            {
                try{if(!p.HasExited&&string.Equals(p.MainModule?.FileName,exe,StringComparison.OrdinalIgnoreCase))return true;}catch{}
            }
            return false;
        }
        finally{foreach(var p in processes)p.Dispose();}
    }
    [ComImport,Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivation
    {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)]string appUserModelId,[MarshalAs(UnmanagedType.LPWStr)]string arguments,uint options,out uint processId);
    }
    private static uint Activate(string aumid,string args)
    {
        var instance=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"))!)!;
        try{Marshal.ThrowExceptionForHR(((IActivation)instance).ActivateApplication(aumid,args,0,out uint pid));return pid;}
        finally{Marshal.ReleaseComObject(instance);}
    }
}
