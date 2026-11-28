using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace YtmCompanion;

// The relay receives only an authenticated encrypted envelope. Never send DPAPI blobs,
// local password hashes, or the recovery password. One latest backup per room.
internal sealed record CloudPreferences(int Schema,string ExtensionFolder,bool AutomaticUpdates,bool StartWithWindows);
internal sealed record CloudAutoState(string Relay,string Token,string RecoveryPassword,string Fingerprint,long Updated)
{
    internal string Protect()=>Convert.ToBase64String(ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(this),null,DataProtectionScope.CurrentUser));
    internal static CloudAutoState Open(string data)=>JsonSerializer.Deserialize<CloudAutoState>(ProtectedData.Unprotect(Convert.FromBase64String(data),null,DataProtectionScope.CurrentUser))??throw new InvalidDataException("Invalid cloud preferences.");
    internal bool Matches(NativeCredentials credentials)=>Relay==NativeCredentials.NormalizeRelay(credentials.RelayUrl)&&Token==credentials.Token;
}
internal static class CloudBackup
{
    internal static CloudPreferences Preferences(Settings s)=>new(1,s.ExtensionFolder,s.AutomaticUpdates,s.StartWithWindows);
    internal static string Fingerprint(CloudPreferences p)=>Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(p)));
    private static readonly HttpClient Http=new(new HttpClientHandler { AllowAutoRedirect=false }) { Timeout=TimeSpan.FromSeconds(30) };
    private static readonly byte[] Context=Encoding.UTF8.GetBytes("ytmr-companion-backup-v1");
    internal static string Encrypt(CloudPreferences prefs,string password)
    {
        if(password.Length<12||password.Length>256)throw new ArgumentException("Use a recovery password of 12–256 characters.");
        byte[] salt=RandomNumberGenerator.GetBytes(16),nonce=RandomNumberGenerator.GetBytes(12),tag=new byte[16];
        byte[] plain=JsonSerializer.SerializeToUtf8Bytes(prefs),cipher=new byte[plain.Length];
        byte[] key=Rfc2898DeriveBytes.Pbkdf2(password,salt,600000,HashAlgorithmName.SHA256,32);
        try { using var aes=new AesGcm(key,16);aes.Encrypt(nonce,plain,cipher,tag,Context);
            return Convert.ToBase64String(new byte[]{1}.Concat(salt).Concat(nonce).Concat(tag).Concat(cipher).ToArray()); }
        finally { CryptographicOperations.ZeroMemory(key);CryptographicOperations.ZeroMemory(plain); }
    }
    internal static CloudPreferences Decrypt(string envelope,string password)
    {
        if(password.Length<12||password.Length>256||envelope.Length>12000)throw new InvalidDataException("Invalid backup.");
        byte[] data=Convert.FromBase64String(envelope);
        if(data.Length<46||data[0]!=1)throw new InvalidDataException("Unsupported backup version.");
        byte[] key=Rfc2898DeriveBytes.Pbkdf2(password,data.AsSpan(1,16),600000,HashAlgorithmName.SHA256,32),plain=new byte[data.Length-45];
        try { using var aes=new AesGcm(key,16);aes.Decrypt(data.AsSpan(17,12),data.AsSpan(45),data.AsSpan(29,16),plain,Context);
            var prefs=JsonSerializer.Deserialize<CloudPreferences>(plain)??throw new InvalidDataException("Invalid backup.");
            if(prefs.Schema!=1||prefs.ExtensionFolder==null||prefs.ExtensionFolder.Length>4096)throw new InvalidDataException("Invalid backup preferences.");
            return prefs; }
        finally { CryptographicOperations.ZeroMemory(key);CryptographicOperations.ZeroMemory(plain); }
    }
    internal static async Task<JsonElement> Request(NativeCredentials config,string action,string? envelope=null)
    {
        config.Validate();
        var body=JsonSerializer.SerializeToUtf8Bytes(new {token=config.Token,action,envelope});
        string time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        string nonce=Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        string hash=Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        string proof=Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(config.PcCode),Encoding.UTF8.GetBytes("companion-backup|"+time+"|"+nonce+"|"+hash))).ToLowerInvariant();
        using var req=new HttpRequestMessage(HttpMethod.Post,NativeCredentials.NormalizeRelay(config.RelayUrl)+"/companion-backup/v1");
        req.Content=new ByteArrayContent(body);req.Content.Headers.ContentType=new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        req.Headers.Add("X-Ytmr-Time",time);req.Headers.Add("X-Ytmr-Nonce",nonce);req.Headers.Add("X-Ytmr-Proof",proof);
        using var res=await Http.SendAsync(req,HttpCompletionOption.ResponseHeadersRead);
        res.EnsureSuccessStatusCode();
        using var stream=await res.Content.ReadAsStreamAsync();using var buffer=new MemoryStream();
        byte[] chunk=new byte[4096];int n;using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while((n=await stream.ReadAsync(chunk.AsMemory(),timeout.Token))>0){if(buffer.Length+n>16384)throw new InvalidDataException("Backup response too large.");buffer.Write(chunk,0,n);}
        using var doc=JsonDocument.Parse(buffer.ToArray());return doc.RootElement.Clone();
    }
}
