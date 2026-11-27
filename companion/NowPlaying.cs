using Windows.Media.Control;

namespace YtmCompanion;

internal static class NowPlaying
{
    internal record Media(string title, string artist, string app, string status);
    private static string Limit(string? value,int max)
    {
        value ??= "";
        return value[..Math.Min(value.Length,max)];
    }
    internal static async Task<Media?> ReadAsync(CancellationToken ct)
    {
        try
        {
            return await ReadCore().WaitAsync(TimeSpan.FromSeconds(3),ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return null; }
    }
    private static async Task<Media?> ReadCore()
    {
        var manager=await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var session=manager.GetCurrentSession();
        if(session is null)return null;
        var info=await session.TryGetMediaPropertiesAsync();
        if(info is null)return null;
        var status=session.GetPlaybackInfo()?.PlaybackStatus.ToString() ?? "Unknown";
        return new Media(Limit(info.Title,160),Limit(info.Artist,160),Limit(session.SourceAppUserModelId,120),Limit(status,24));
    }
}
