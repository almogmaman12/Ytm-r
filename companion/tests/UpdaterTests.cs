using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using YtmCompanion;

internal static class UpdaterTests
{
    public static async Task Run()
    {
        var root=Path.Combine(Path.GetTempPath(),"ytmr-updater-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var signer=ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var pub=signer.ExportSubjectPublicKeyInfoPem();
        int passed=0;
        void Check(bool ok,string label)
        {
            if(!ok)throw new Exception(label);
            Console.WriteLine("PASS: "+label);passed++;
        }
        string Manifest(string version,bool changed=false)=>JsonSerializer.Serialize(new
        {
            manifest_version=3,name="Tab Helper",version,
            permissions=changed?new[]{"storage","tabs"}:new[]{"storage"},
            background=new{service_worker="background.js"}
        });
        string MakeFolder(string name)
        {
            var folder=Path.Combine(root,name);
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder,"manifest.json"),Manifest("2.4.3"));
            File.WriteAllText(Path.Combine(folder,"background.js"),"old fixture");
            return folder;
        }
        Dictionary<string,byte[]> Release(string version="2.4.4",bool changed=false,bool traversal=false)
        {
            using var memory=new MemoryStream();
            using(var archive=new ZipArchive(memory,ZipArchiveMode.Create,true))
            {
                void Add(string name,string contents)
                {using var writer=new StreamWriter(archive.CreateEntry(name).Open());writer.Write(contents);}
                Add("manifest.json",Manifest(version,changed));
                Add("background.js","new fixture");
                if(traversal)Add("../outside.txt","unsafe fixture");
            }
            var zip=memory.ToArray();
            var meta=JsonSerializer.SerializeToUtf8Bytes(new{format=1,product="YTM Remote extension",version,sha256=Convert.ToHexString(SHA256.HashData(zip)).ToLowerInvariant()});
            return new(){["extension.zip"]=zip,["extension-release.json"]=meta,
                ["extension-release.sig"]=signer.SignData(meta,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation)};
        }
        Task<string> Run(string folder,Dictionary<string,byte[]> data,Func<bool>? chrome=null)
            =>ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>
            {
                var bytes=data[name];if(bytes.Length>limit)throw new InvalidDataException("fixture too large");
                return Task.FromResult(bytes);
            },chrome??(()=>false));
        async Task Reject(string label,Dictionary<string,byte[]> data)
        {
            var folder=MakeFolder("reject-"+Guid.NewGuid().ToString("N"));
            bool rejected=false;
            try{await Run(folder,data);}catch(InvalidDataException){rejected=true;}
            Check(rejected&&File.ReadAllText(Path.Combine(folder,"background.js"))=="old fixture",label);
        }
        try
        {
            var folder=MakeFolder("extension");
            var valid=Release();
            var downloads=0;
            var waiting=await ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>{downloads++;return Task.FromResult(valid[name]);},()=>true);
            Check(waiting==ExtensionUpdater.Waiting&&downloads==0,"Chrome open: no downloads or changes");
            var installed=await Run(folder,valid);
            Check(installed.StartsWith("Extension 2.4.4 installed")&&File.ReadAllText(Path.Combine(folder,"background.js"))=="new fixture","Signed archive replaces same extension directory");
            Check(Directory.GetDirectories(root,"extension.ytmr-backup-*").Length==1,"Previous version backup retained");
            Check((await Run(folder,valid)).StartsWith("Extension up to date"),"Equal version ignored");
            Check((await Run(folder,Release("2.4.2"))).StartsWith("Extension up to date"),"Older version ignored");
            var badSignature=Release();badSignature["extension-release.sig"][0]^=1;
            await Reject("Invalid signature rejected",badSignature);
            var badHash=Release();badHash["extension.zip"][0]^=1;
            await Reject("Archive hash mismatch rejected",badHash);
            await Reject("Archive traversal rejected",Release(traversal:true));
            Check(!File.Exists(Path.Combine(root,"outside.txt")),"No file escaped staging folder");
            var changedFolder=MakeFolder("changed");
            Check((await Run(changedFolder,Release(changed:true))).StartsWith("Manifest capabilities changed")&&File.ReadAllText(Path.Combine(changedFolder,"background.js"))=="old fixture","Permission changes require manual review");
            var raceFolder=MakeFolder("race");int checks=0;
            Check(await Run(raceFolder,valid,()=>++checks>1)==ExtensionUpdater.Waiting&&File.ReadAllText(Path.Combine(raceFolder,"background.js"))=="old fixture","Chrome opening during check defers replacement");
            Console.WriteLine($"Passed {passed} isolated updater checks.");
        }
        finally{Directory.Delete(root,true);}
    }
}
