using System.Reflection;
using System.Security.Cryptography;

namespace YtmCompanion;

// Production builds contain a public verification key, never a signing secret.
// The embedded key takes precedence over any old locally configured key.
internal static class PublisherTrust
{
    private const string ResourceName = "YtmCompanion.ReleasePublicKey.pem";
    public static string? PublicKey { get; } = Load();

    private static string? Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
        if (stream == null) return null;
        using var reader = new StreamReader(stream);
        var pem = reader.ReadToEnd().Trim();
        if (!pem.StartsWith("-----BEGIN PUBLIC KEY-----", StringComparison.Ordinal) ||
            !pem.EndsWith("-----END PUBLIC KEY-----", StringComparison.Ordinal))
            throw new InvalidDataException("Build must embed only a public verification key.");
        using var key = ECDsa.Create();
        key.ImportFromPem(pem);
        if (key.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7")
            throw new InvalidDataException("Publisher verification requires a P-256 key.");
        return key.ExportSubjectPublicKeyInfoPem();
    }
}
