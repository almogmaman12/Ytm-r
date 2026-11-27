using System.Runtime.InteropServices;
using System.Xml;
using System.Xml.Linq;
using Windows.ApplicationModel;
using Windows.Management.Deployment;

namespace YtmCompanion;

internal static class CompanionUpdater
{
    internal const string BaseUrl = "https://github.com/almogmaman12/Ytm-r/releases/download/companion-channel/";
    internal const string Feed = BaseUrl + "YtmCompanion.appinstaller";
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(25) };
    internal static Version CurrentVersion()
    {
        if (Store.Packaged)
        {
            var v = Package.Current.Id.Version;
            return new(v.Major,v.Minor,v.Build,v.Revision);
        }
        return typeof(Program).Assembly.GetName().Version ?? new Version(0,0,0,0);
    }
    internal static bool Supported()
    {
        try { return Store.Packaged && Package.Current.Id.Name == "YtmRemote.Companion" &&
            Package.Current.Id.Publisher == "CN=YTM Remote Companion" &&
            Package.Current.GetAppInstallerInfo()?.Uri?.AbsoluteUri == Feed; }
        catch { return false; }
    }
    internal static bool ParseVersion(string? text, out Version? version)
    {
        version=null;
        if (text == null || !System.Text.RegularExpressions.Regex.IsMatch(text, @"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z") ||
            !Version.TryParse(text,out var parsed) || parsed.Major>65535 || parsed.Minor>65535 || parsed.Build>65535 || parsed.Revision>65535)
            return false;
        version=parsed;
        return true;
    }
    internal static Version ParseFeed(string xml)
    {
        using var reader=XmlReader.Create(new StringReader(xml),new XmlReaderSettings { DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=16384 });
        var root=XDocument.Load(reader).Root ?? throw new InvalidDataException("Missing update descriptor.");
        XNamespace ns="http://schemas.microsoft.com/appx/appinstaller/2018";
        if(root.Name!=ns+"AppInstaller" || (string?)root.Attribute("Uri")!=Feed ||
            !ParseVersion((string?)root.Attribute("Version"),out var version) ||
            root.Elements(ns+"MainPackage").Count()!=1 ||
            root.Elements().Any(e=>e.Name!=ns+"MainPackage" && e.Name!=ns+"UpdateSettings"))
            throw new InvalidDataException("Unexpected companion descriptor.");
        var package=root.Element(ns+"MainPackage")!;
        if((string?)package.Attribute("Name")!="YtmRemote.Companion" ||
           (string?)package.Attribute("Publisher")!="CN=YTM Remote Companion" ||
           (string?)package.Attribute("ProcessorArchitecture")!="x64" ||
           (string?)package.Attribute("Version")!=version!.ToString() ||
           (string?)package.Attribute("Uri")!=BaseUrl+"YtmCompanion-"+version+".msix")
            throw new InvalidDataException("Unexpected companion package.");
        return version!;
    }
    internal static async Task<Version> LatestAsync(CancellationToken ct)
    {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(35));
        var uri=new Uri(Feed);
        for(int i=0;i<5;i++)
        {
            if(uri.Scheme!="https" || !uri.IsDefaultPort || uri.UserInfo.Length!=0 ||
                !(uri.AbsoluteUri==Feed || uri.Host=="release-assets.githubusercontent.com" || uri.Host=="objects.githubusercontent.com"))
                throw new InvalidDataException("Untrusted companion feed redirect.");
            using var res=await Http.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead,timeout.Token);
            if((int)res.StatusCode is >=300 and <400)
            {
                var location=res.Headers.Location ?? throw new InvalidDataException("Missing redirect.");
                uri=location.IsAbsoluteUri?location:new Uri(uri,location);
                continue;
            }
            res.EnsureSuccessStatusCode();
            using var stream=await res.Content.ReadAsStreamAsync(timeout.Token);
            using var output=new MemoryStream();
            var buffer=new byte[4096];
            int n;
            while((n=await stream.ReadAsync(buffer.AsMemory(),timeout.Token))>0)
            {
                if(output.Length+n>16384)throw new InvalidDataException("Descriptor too large.");
                output.Write(buffer,0,n);
            }
            using var xmlReader=new StreamReader(new MemoryStream(output.ToArray()),detectEncodingFromByteOrderMarks:true);
            return ParseFeed(await xmlReader.ReadToEndAsync(timeout.Token));
        }
        throw new InvalidDataException("Too many redirects.");
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]
    private static extern int RegisterApplicationRestart(string commandLine,uint flags);

    internal static async Task InstallAsync()
    {
        if(!Supported())throw new InvalidOperationException("App Installer association required.");
        // Register only this companion for restart. Windows verifies the MSIX signature and publisher.
        if(RegisterApplicationRestart("--background",3)!=0)
            throw new InvalidOperationException("Could not register for restart.");
        var manager=new PackageManager();
        var result=await manager.AddPackageByAppInstallerFileAsync(new Uri(Feed),AddPackageByAppInstallerOptions.ForceTargetAppShutdown,manager.GetDefaultPackageVolume());
        if(result.ExtendedErrorCode!=null)throw result.ExtendedErrorCode;
    }
}
