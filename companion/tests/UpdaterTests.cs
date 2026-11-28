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
        Task<string> Run(string folder,Dictionary<string,byte[]> data,Func<bool>? chrome=null,Func<PermissionReview,bool>? review=null)
            =>ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>
            {
                var bytes=data[name];if(bytes.Length>limit)throw new InvalidDataException("fixture too large");
                return Task.FromResult(bytes);
            },chrome??(()=>false),review);
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
            PermissionReview? preview=null;
            var previewResult=await ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>Task.FromResult(valid[name]),()=>true,preview:r=>preview=r);
            Check(previewResult.Contains("available")&&preview!=null&&preview.ReleaseVersion=="2.4.4"&&File.ReadAllText(Path.Combine(folder,"background.js"))=="old fixture","Preview works while Chrome is open without installing");
            // Different signed release must never use an older approval.
            var other=Release("2.4.5");
            var changedApproval=await ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>Task.FromResult(other[name]),()=>false,expectedReview:preview);
            Check(changedApproval.Contains("check and review again")&&File.ReadAllText(Path.Combine(folder,"background.js"))=="old fixture","Approval cannot install a different signed release");
            var approvedFolder=MakeFolder("remote-approval");
            var approvalRelease=Release(changed:true);
            PermissionReview? approval=null;
            bool browserRunning=true;
            await ExtensionUpdater.CheckCoreAsync(approvedFolder,pub,(name,limit)=>Task.FromResult(approvalRelease[name]),()=>browserRunning,preview:r=>approval=r);
            Check(approval!=null&&approval.Details.Contains("ADD \"tabs\""),"Remote preview includes added permissions");
            var remoteInstalled=await ExtensionUpdater.CheckCoreAsync(approvedFolder,pub,(name,limit)=>Task.FromResult(approvalRelease[name]),
                ()=>browserRunning,review:_=>true,expectedReview:approval,beforeInstall:()=>{browserRunning=false;return Task.FromResult(true);});
            Check(remoteInstalled.StartsWith("Extension 2.4.4 installed")&&File.ReadAllText(Path.Combine(approvedFolder,"background.js"))=="new fixture","Approved release installs after graceful browser closure");
            var missing=await ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>
                Task.FromException<byte[]>(new HttpRequestException("Fixture missing",null,System.Net.HttpStatusCode.NotFound)),()=>false);
            Check(missing==ExtensionUpdater.NoRelease&&File.ReadAllText(Path.Combine(folder,"background.js"))=="old fixture","Unavailable release metadata reports no accessible release");
            bool missingSignature=false;
            try
            {
                await ExtensionUpdater.CheckCoreAsync(folder,pub,(name,limit)=>name=="extension-release.sig"
                    ?Task.FromException<byte[]>(new HttpRequestException("Fixture missing",null,System.Net.HttpStatusCode.NotFound))
                    :Task.FromResult(valid[name]),()=>false);
            }
            catch(HttpRequestException){missingSignature=true;}
            Check(missingSignature&&File.ReadAllText(Path.Combine(folder,"background.js"))=="old fixture","Incomplete release is not treated as a valid update");
            var installed=await Run(folder,valid);
            Check(installed.StartsWith("Extension 2.4.4 installed")&&File.ReadAllText(Path.Combine(folder,"background.js"))=="new fixture","Signed archive replaces same extension directory");
            Check(Directory.GetDirectories(root,"extension.ytmr-backup-*").Length==1,"Previous version backup retained");
            Check((await Run(folder,valid)).StartsWith("Extension up to date"),"Equal version ignored");
            Check((await Run(folder,Release("2.4.2"))).StartsWith("Extension up to date"),"Older version ignored");
            var rollbackFolder=MakeFolder("rollback");
            var older=Release("2.4.2");
            PermissionReview? rollbackReview=null;
            await ExtensionUpdater.CheckCoreAsync(rollbackFolder,pub,(name,limit)=>Task.FromResult(older[name]),()=>true,preview:r=>rollbackReview=r,rollbackTarget:new Version(2,4,2));
            Check(rollbackReview?.ReleaseVersion=="2.4.2","Older signed release preview available");
            var rollbackResult=await ExtensionUpdater.CheckCoreAsync(rollbackFolder,pub,(name,limit)=>Task.FromResult(older[name]),()=>false,review:_=>true,expectedReview:rollbackReview,beforeInstall:()=>Task.FromResult(true),rollbackTarget:new Version(2,4,2));
            Check(rollbackResult.StartsWith("Extension 2.4.2 installed"),"Explicit signed rollback preserves extension path");
            bool wrongTarget=false;
            try{await ExtensionUpdater.CheckCoreAsync(rollbackFolder,pub,(name,limit)=>Task.FromResult(older[name]),()=>false,rollbackTarget:new Version(2,4,1));}catch(InvalidDataException){wrongTarget=true;}
            Check(wrongTarget,"Rollback rejects a different signed version");
            var prefs=new CloudPreferences(1,@"C:\Example\Extension",true,true);
            var encrypted=CloudBackup.Encrypt(prefs,"test-recovery-password");
            Check(CloudBackup.Decrypt(encrypted,"test-recovery-password")==prefs&&!encrypted.Contains("Example"),"Cloud preferences encrypted and restored");
            bool badPassword=false;try{CloudBackup.Decrypt(encrypted,"wrong-recovery-password");}catch(CryptographicException){badPassword=true;}
            Check(badPassword,"Incorrect cloud recovery password rejected");
            var tampered=Convert.FromBase64String(encrypted);tampered[^1]^=1;
            bool badCipher=false;try{CloudBackup.Decrypt(Convert.ToBase64String(tampered),"test-recovery-password");}catch(CryptographicException){badCipher=true;}
            Check(badCipher,"Tampered cloud backup rejected");
            var cstate=new CloudAutoState("https://relay.example.com","abcdefghijklmnopqrstuvwx_1234","test-recovery-password",CloudBackup.Fingerprint(prefs),12345);
            var cprotected=cstate.Protect();
            Check(!cprotected.Contains(cstate.RecoveryPassword)&&CloudAutoState.Open(cprotected)==cstate,"Automatic recovery key protected by local DPAPI");
            Check(cstate.Matches(new NativeCredentials(cstate.Token,"test-pc-code",cstate.Relay))&&!cstate.Matches(new NativeCredentials(cstate.Token,"test-pc-code","https://other.example.com")),"Automatic backup bound to selected room and origin");
            Check(CloudBackup.Fingerprint(prefs)!=CloudBackup.Fingerprint(prefs with{AutomaticUpdates=false}),"Preference changes invalidate saved backup fingerprint");
            var badSignature=Release();badSignature["extension-release.sig"][0]^=1;
            await Reject("Invalid signature rejected",badSignature);
            var badHash=Release();badHash["extension.zip"][0]^=1;
            await Reject("Archive hash mismatch rejected",badHash);
            await Reject("Archive traversal rejected",Release(traversal:true));
            Check(!File.Exists(Path.Combine(root,"outside.txt")),"No file escaped staging folder");
            var cosmeticFolder=MakeFolder("cosmetic");
            File.WriteAllText(Path.Combine(cosmeticFolder,"manifest.json"),
                """{"background":{"service_worker":"background.js"},"permissions":["storage"],"version":"2.4.3","name":"Tab Helper","manifest_version":3,"description":"Old description","short_name":"Old label","icons":{"16":"old.png"}}""");
            Check((await Run(cosmeticFolder,valid)).StartsWith("Extension 2.4.4 installed"),"Cosmetic metadata and reordered fields allow signed update");
            string[] Diff(string left,string right)
            {
                using var x=JsonDocument.Parse(left);using var y=JsonDocument.Parse(right);
                return ExtensionUpdater.ManifestChanges(x.RootElement,y.RootElement);
            }
            Check(Diff(
                """{"permissions":["storage","alarms"],"background":{"service_worker":"background.js","type":"module"},"action":{"default_title":"Old","default_icon":{"16":"old.png"}}}""",
                """{"action":{"default_icon":{"16":"new.png"},"default_title":"New"},"background":{"type":"module","service_worker":"background.js"},"permissions":["alarms","storage"],"optional_permissions":[]}""").Length==0,"Reordered permission sets, nested objects and cosmetic action metadata are equivalent");
            Check(Diff("""{"permissions":["storage"]}""","""{"permissions":["storage","debugger"]}""").SequenceEqual(new[]{"permissions"}),"New API permissions require review");
            Check(Diff("""{"host_permissions":["https://music.youtube.com/*"]}""","""{"host_permissions":["<all_urls>"]}""").SequenceEqual(new[]{"host_permissions"}),"Broader host access requires review");
            Check(Diff("""{"key":"old","action":{"default_popup":"old.html"}}""","""{"key":"new","action":{"default_popup":"new.html"}}""").SequenceEqual(new[]{"action","key"}),"Identity and action behavior changes require review");
            Check(Diff("""{"content_scripts":[{"js":["a.js","b.js"]}]}""","""{"content_scripts":[{"js":["b.js","a.js"]}]}""").SequenceEqual(new[]{"content_scripts"}),"Execution order changes require review");
            var changedFolder=MakeFolder("changed");
            Check((await Run(changedFolder,Release(changed:true))).StartsWith("Manifest capabilities changed: permissions")&&File.ReadAllText(Path.Combine(changedFolder,"background.js"))=="old fixture","Permission changes require manual review");
            var reviewedRelease=Release(changed:true);
            int reviewCount=0;
            Check((await Run(changedFolder,reviewedRelease,review:r=>{reviewCount++;return false;})).StartsWith("Update declined")&&reviewCount==1&&File.ReadAllText(Path.Combine(changedFolder,"background.js"))=="old fixture","Declined permission review makes no change");
            Check((await Run(changedFolder,reviewedRelease,review:r=>{
                reviewCount++;
                Check(r.InstalledVersion=="2.4.3"&&r.ReleaseVersion=="2.4.4"&&r.Details.Contains("ADD \"tabs\"")&&r.ArchiveSha256==Convert.ToHexString(SHA256.HashData(reviewedRelease["extension.zip"])),"Review identifies precise permission addition and signed archive");
                return true;
            })).StartsWith("Extension 2.4.4 installed")&&reviewCount==2,"Explicit permission approval installs exact verified release");
            var identityFolder=MakeFolder("identity");
            File.WriteAllText(Path.Combine(identityFolder,"manifest.json"),"""{"manifest_version":3,"name":"Tab Helper","version":"2.4.3","permissions":["storage"],"key":"fixture","background":{"service_worker":"background.js"}}""");
            Check((await Run(identityFolder,valid,review:r=>throw new Exception("Identity change must never be offered for approval"))).Contains("Review in Chrome required")&&File.ReadAllText(Path.Combine(identityFolder,"background.js"))=="old fixture","Identity changes remain blocked");
            var invalidFolder=MakeFolder("invalid-review");bool invalidRejected=false;
            try { await Run(invalidFolder,badSignature,review:r=>throw new Exception("Invalid signature must never be offered for approval")); }
            catch(InvalidDataException){invalidRejected=true;}
            Check(invalidRejected&&File.ReadAllText(Path.Combine(invalidFolder,"background.js"))=="old fixture","Invalid signature cannot reach review");
            var reviewRace=MakeFolder("review-race");bool reopened=false;
            Check(await Run(reviewRace,reviewedRelease,()=>reopened,r=>{reopened=true;return true;})==ExtensionUpdater.Waiting&&File.ReadAllText(Path.Combine(reviewRace,"background.js"))=="old fixture","Chrome reopening during review prevents replacement");
            var raceFolder=MakeFolder("race");int checks=0;
            Check(await Run(raceFolder,valid,()=>++checks>1)==ExtensionUpdater.Waiting&&File.ReadAllText(Path.Combine(raceFolder,"background.js"))=="old fixture","Chrome opening during check defers replacement");
            Console.WriteLine($"Passed {passed} isolated updater checks.");
        }
        finally{Directory.Delete(root,true);}
    }
}
