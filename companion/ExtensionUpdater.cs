using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace YtmCompanion;

internal sealed class ExtensionUpdater
{
    public const string Waiting = "Waiting for Chrome to close fully";
    public const string NoRelease = "No accessible signed extension release yet";
    private const string Release = "https://github.com/almogmaman12/Ytm-r/releases/latest/download/";
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(60) };

    private static bool ChromeOpen()
    {
        var processes = Process.GetProcessesByName("chrome");
        try { return processes.Length > 0; }
        finally { foreach (var p in processes) p.Dispose(); }
    }

    private static void RejectLinks(string path)
    {
        for (DirectoryInfo? p = new DirectoryInfo(path); p != null; p = p.Parent)
            if (p.Exists && (p.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Linked or redirected directories are not supported.");
    }

    public static string ValidateFolder(string folder)
    {
        if (!Path.IsPathFullyQualified(folder)) throw new ArgumentException("Select an absolute extension folder.");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        RejectLinks(full);
        if (!Directory.Exists(full) || Path.GetDirectoryName(full) == null) throw new InvalidDataException("Extension folder not found.");
        var manifest = Path.Combine(full, "manifest.json");
        if (!File.Exists(manifest) || (File.GetAttributes(manifest) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Extension manifest not found.");
        using var doc = JsonDocument.Parse(File.ReadAllBytes(manifest));
        if (doc.RootElement.GetProperty("name").GetString() != "Tab Helper" || doc.RootElement.GetProperty("manifest_version").GetInt32() != 3)
            throw new InvalidDataException("Choose the existing YTM Remote Tab Helper extension folder.");
        return full;
    }

    private static bool AllowedDownload(Uri u) => u.Scheme == "https" && u.IsDefaultPort && string.IsNullOrEmpty(u.UserInfo) &&
        (u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) &&
         u.AbsolutePath.StartsWith("/almogmaman12/Ytm-r/releases/", StringComparison.OrdinalIgnoreCase) ||
         u.Host.Equals("release-assets.githubusercontent.com", StringComparison.OrdinalIgnoreCase) ||
         u.Host.Equals("objects.githubusercontent.com", StringComparison.OrdinalIgnoreCase));

    private static async Task<byte[]> Download(string file, int limit)
    {
        var uri = new Uri(Release + file);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        for (int i = 0; i < 5; i++)
        {
            if (!AllowedDownload(uri)) throw new InvalidDataException("Untrusted release URL.");
            using var res = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if ((int)res.StatusCode is >= 300 and < 400)
            {
                var location = res.Headers.Location ?? throw new InvalidDataException("Missing redirect.");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                continue;
            }
            res.EnsureSuccessStatusCode();
            if (res.Content.Headers.ContentLength > limit) throw new InvalidDataException("Release file too large.");
            using var input = await res.Content.ReadAsStreamAsync(timeout.Token);
            using var output = new MemoryStream();
            var buffer = new byte[16384];
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(), timeout.Token)) > 0)
            {
                if (output.Length + read > limit) throw new InvalidDataException("Release file too large.");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
        throw new InvalidDataException("Too many redirects.");
    }

    private static JsonElement Manifest(string folder)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(folder, "manifest.json")));
        return document.RootElement.Clone();
    }

    // Compare JSON values rather than serialization order. Only known cosmetic
    // fields and ordering of permission sets may differ without review.
    private static readonly HashSet<string> Cosmetic = new(StringComparer.Ordinal)
    { "version", "version_name", "description", "short_name", "icons" };
    private static readonly HashSet<string> PermissionSets = new(StringComparer.Ordinal)
    { "permissions", "optional_permissions", "host_permissions", "optional_host_permissions" };
    private static Dictionary<string,JsonElement> Properties(JsonElement value) =>
        value.EnumerateObject().ToDictionary(p => p.Name, p => p.Value, StringComparer.Ordinal);
    private static bool EqualJson(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind) return false;
        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
                var x = Properties(a); var y = Properties(b);
                return x.Count == y.Count && x.All(p => y.TryGetValue(p.Key, out var v) && EqualJson(p.Value,v));
            case JsonValueKind.Array:
                return a.GetArrayLength() == b.GetArrayLength() &&
                    a.EnumerateArray().Zip(b.EnumerateArray()).All(p => EqualJson(p.First,p.Second));
            case JsonValueKind.String: return a.GetString() == b.GetString();
            case JsonValueKind.Number: return a.GetRawText() == b.GetRawText();
            default: return a.GetRawText() == b.GetRawText();
        }
    }
    private static HashSet<string> ReadPermissionSet(Dictionary<string,JsonElement> fields,string name)
    {
        if (!fields.TryGetValue(name,out var value)) return new(StringComparer.Ordinal);
        if (value.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Invalid permission declaration.");
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in value.EnumerateArray())
            if (item.ValueKind != JsonValueKind.String || !result.Add(item.GetString()!))
                throw new InvalidDataException("Invalid or duplicate permission declaration.");
        return result;
    }
    private static bool EqualAction(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != JsonValueKind.Object || b.ValueKind != JsonValueKind.Object) return EqualJson(a,b);
        var x=Properties(a); var y=Properties(b);
        foreach(var cosmetic in new[]{"default_title","default_icon"}) { x.Remove(cosmetic);y.Remove(cosmetic); }
        return x.Count==y.Count && x.All(p=>y.TryGetValue(p.Key,out var v)&&EqualJson(p.Value,v));
    }
    internal static string[] ManifestChanges(JsonElement old, JsonElement candidate)
    {
        var a=Properties(old); var b=Properties(candidate);
        var changed=new List<string>();
        foreach(var field in a.Keys.Union(b.Keys,StringComparer.Ordinal).OrderBy(x=>x,StringComparer.Ordinal))
        {
            if(Cosmetic.Contains(field))continue;
            bool equal;
            if(PermissionSets.Contains(field))
                equal=ReadPermissionSet(a,field).SetEquals(ReadPermissionSet(b,field));
            else
                equal=a.TryGetValue(field,out var x)&&b.TryGetValue(field,out var y)&&
                    (field=="action"?EqualAction(x,y):EqualJson(x,y));
            if(!equal)changed.Add(field);
        }
        return changed.ToArray();
    }

    private static void Extract(byte[] data, string destination)
    {
        using var zip = new ZipArchive(new MemoryStream(data, false), ZipArchiveMode.Read);
        if (zip.Entries.Count > 500) throw new InvalidDataException("Too many release entries.");
        long total = 0;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries)
        {
            var name = e.FullName.Replace('\\', '/');
            if (name.EndsWith('/')) continue;
            if (name.Length > 200 || name.Split('/').Any(p => p.Length == 0 || p is "." or ".." ||
                p.EndsWith('.') || p.EndsWith(' ') || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                System.Text.RegularExpressions.Regex.IsMatch(p, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) ||
                !names.Add(name) || ((e.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                throw new InvalidDataException("Invalid archive entry.");
            var target = Path.GetFullPath(Path.Combine(destination, name));
            if (!target.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Archive entry escapes destination.");
            total += e.Length;
            if (total > 16 * 1024 * 1024 || e.Length > 8 * 1024 * 1024)
                throw new InvalidDataException("Unpacked release too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var input = e.Open();
            using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            var buf = new byte[16384]; long written = 0; int n;
            while ((n = input.Read(buf, 0, buf.Length)) > 0)
            {
                written += n;
                if (written > e.Length) throw new InvalidDataException("Unexpected archive length.");
                output.Write(buf, 0, n);
            }
            if (written != e.Length) throw new InvalidDataException("Incomplete archive entry.");
        }
    }

    public Task<string> CheckAsync(Settings settings) => CheckCoreAsync(settings.ExtensionFolder, settings.EffectivePublicKey, Download, ChromeOpen);

    // Internal test seam: production uses only the built-in release origin and real Chrome process check.
    internal static async Task<string> CheckCoreAsync(string extensionFolder, string publicKey,
        Func<string,int,Task<byte[]>> download, Func<bool> chromeOpen)
    {
        var folder = ValidateFolder(extensionFolder);
        if (chromeOpen()) return Waiting;
        using var key = ECDsa.Create();
        key.ImportFromPem(publicKey);
        if (key.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7") throw new InvalidDataException("Invalid publisher key.");
        byte[] manifestBytes;
        try { manifestBytes = await download("extension-release.json", 8192); }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        { return NoRelease; }
        var signature = await download("extension-release.sig", 128);
        if (!key.VerifyData(manifestBytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw new InvalidDataException("Release signature invalid.");
        using var release = JsonDocument.Parse(manifestBytes);
        var meta = release.RootElement;
        if (meta.GetProperty("format").GetInt32() != 1 || meta.GetProperty("product").GetString() != "YTM Remote extension")
            throw new InvalidDataException("Wrong release type.");
        var old = Manifest(folder);
        var installed = Version.Parse(old.GetProperty("version").GetString()!);
        var next = Version.Parse(meta.GetProperty("version").GetString()!);
        if (next <= installed) return "Extension up to date (" + installed + ")";
        var zip = await download("extension.zip", 8 * 1024 * 1024);
        var expected = Convert.FromHexString(meta.GetProperty("sha256").GetString()!);
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(zip), expected))
            throw new InvalidDataException("Release archive hash mismatch.");

        var parent = Path.GetDirectoryName(folder)!;
        var stage = Path.Combine(parent, ".ytmr-stage-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(parent, Path.GetFileName(folder) + ".ytmr-backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(stage);
        try
        {
            Extract(zip, stage);
            var candidate = Manifest(stage);
            if (Version.Parse(candidate.GetProperty("version").GetString()!) != next)
                throw new InvalidDataException("Archive manifest version does not match signed release.");
            var changes = ManifestChanges(old,candidate);
            if (changes.Length > 0)
            {
                // Display only known field names, never manifest contents or arbitrary text.
                var known = new HashSet<string>(StringComparer.Ordinal)
                { "permissions","optional_permissions","host_permissions","optional_host_permissions",
                  "key","name","manifest_version","background","content_scripts","action","options_ui",
                  "minimum_chrome_version","content_security_policy","externally_connectable",
                  "web_accessible_resources","update_url","incognito" };
                var labels = changes.Select(x=>known.Contains(x)?x:"other manifest field").Distinct().Take(4);
                return "Manifest capabilities changed: "+string.Join(", ",labels)+". Manual review required.";
            }
            if (chromeOpen()) return Waiting;
            if (ValidateFolder(folder) != folder || Manifest(folder).GetRawText() != old.GetRawText())
                return "Extension changed during check; retry later.";
            // Keep the existing unpacked extension path; do not modify Chrome profile/storage.
            Directory.Move(folder, backup);
            try { Directory.Move(stage, folder); }
            catch
            {
                if (!Directory.Exists(folder)) Directory.Move(backup, folder);
                throw;
            }
            return "Extension " + next + " installed; backup retained.";
        }
        finally
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
        }
    }
}
