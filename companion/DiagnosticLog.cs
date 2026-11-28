using System.Text.Json;

namespace YtmCompanion;

// Bounded local-only history of fixed diagnostic events. No URLs, tokens, paths,
// tab titles, exception messages, or other personal data may be passed in.
internal static class DiagnosticLog
{
    private static readonly object Gate=new();
    private static string Pathname=>Path.Combine(Store.Folder,"diagnostics.json");
    private sealed record Entry(long At,string Event);
    private static List<Entry> Read()
    {
        if(!File.Exists(Pathname)||new FileInfo(Pathname).Length>16384)return new();
        return JsonSerializer.Deserialize<List<Entry>>(File.ReadAllBytes(Pathname))??new();
    }
    internal static void Add(string kind)
    {
        if(!System.Text.RegularExpressions.Regex.IsMatch(kind,@"\A[A-Za-z0-9 .:_-]{1,80}\z"))return;
        lock(Gate)
        {
            string? temp=null;
            try
            {
                List<Entry> entries;try{entries=Read();}catch{entries=new();}
                entries.Add(new(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind));
                entries=entries.TakeLast(60).ToList();
                Directory.CreateDirectory(Store.Folder);
                temp=Pathname+"."+Guid.NewGuid().ToString("N")+".tmp";
                File.WriteAllBytes(temp,JsonSerializer.SerializeToUtf8Bytes(entries));
                File.Move(temp,Pathname,true);
            }catch{}finally{if(temp!=null)try{File.Delete(temp);}catch{}}
        }
    }
    internal static object[] Recent()
    {
        lock(Gate)
        {
            try{return Read().TakeLast(6).Reverse().Select(e=>(object)new {at=e.At,eventName=e.Event}).ToArray();}
            catch{return Array.Empty<object>();}
        }
    }
    internal static string Report()
    {
        lock(Gate)
        {
            try{return string.Join(Environment.NewLine,Read().TakeLast(60).Reverse().Select(e=>DateTimeOffset.FromUnixTimeMilliseconds(e.At).ToLocalTime().ToString("g")+"  "+e.Event));}
            catch{return "No readable diagnostic history.";}
        }
    }
}
