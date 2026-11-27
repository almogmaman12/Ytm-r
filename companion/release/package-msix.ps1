# Run on a trusted Windows release machine with .NET 8 and Windows SDK.
# Certificate must already exist in the signing certificate store.
param(
  [Parameter(Mandatory=$true)][string]$Publisher,
  [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$ExtensionPublicKeyPath,
  [switch]$SettingsUpgradeTest
)
$ErrorActionPreference = 'Stop'
if ($SettingsUpgradeTest -and $Publisher -ne 'CN=YTM Remote Companion CI Test') { throw 'Settings upgrade probe is permitted only in disposable CI test packages' }
if ($Version -notmatch '^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}$' -or ($Version.Split('.') | Where-Object { [int]$_ -gt 65535 })) { throw 'MSIX version must have four components from 0 to 65535' }
if ($CertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Invalid signing certificate thumbprint' }
$cert = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint"
if ($cert.Subject -ne $Publisher -or -not $cert.HasPrivateKey) { throw 'Publisher must match the signing certificate subject' }
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkBin -Directory | Where-Object {
  (Test-Path (Join-Path $_.FullName 'x64\makeappx.exe')) -and (Test-Path (Join-Path $_.FullName 'x64\signtool.exe'))
} | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK packaging tools not found' }
$makeappx = Join-Path $sdk.FullName 'x64\makeappx.exe'
$signtool = Join-Path $sdk.FullName 'x64\signtool.exe'
$root = Split-Path -Parent $PSScriptRoot
$publicKeyPath = (Resolve-Path -LiteralPath $ExtensionPublicKeyPath).Path
$pem = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
if ($pem -notmatch '(?s)\A-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\z') { throw 'Provide a public PEM key only, never the private signing key.' }
# Verify that the public resource is valid P-256 before packaging it.
node -e "const k=require('node:crypto').createPublicKey(require('node:fs').readFileSync(process.argv[1])); if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails.namedCurve!=='prime256v1')process.exit(1)" "$publicKeyPath"
if ($LASTEXITCODE -ne 0) { throw 'Invalid P-256 publisher key' }
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $out -Force | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ('ytmr-msix-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $testArgs = @()
  if ($SettingsUpgradeTest) { $testArgs += '-p:SettingsUpgradeTest=true' }
  dotnet publish (Join-Path $root 'YtmCompanion.csproj') -c Release -r win-x64 --self-contained true "-p:Version=$Version" -p:RequirePublisherKey=true "-p:ExtensionPublicKeyPath=$publicKeyPath" -o $stage @testArgs
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
  Add-Type -AssemblyName System.Drawing
  $assets = Join-Path $stage 'Assets'
  New-Item -ItemType Directory -Path $assets | Out-Null
  foreach ($size in @(44,50,150)) {
    $bmp = [System.Drawing.Bitmap]::new($size,$size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.Clear([System.Drawing.Color]::FromArgb(42,36,57))
      $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(184,165,255),[single]([Math]::Max(2,$size/12)))
      try { $g.DrawRectangle($pen,($size/5),($size/4),($size*3/5),($size/2)); $g.DrawLine($pen,($size/2),($size*3/4),($size/2),($size*7/8)) } finally { $pen.Dispose() }
      $bmp.Save((Join-Path $assets "Logo$size.png"),[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $g.Dispose(); $bmp.Dispose() }
  }
  $p = [Security.SecurityElement]::Escape($Publisher)
  $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:uap7="http://schemas.microsoft.com/appx/manifest/uap/windows10/7"
 xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap uap7 desktop rescap">
 <Identity Name="YtmRemote.Companion" Publisher="$p" Version="$Version" ProcessorArchitecture="x64"/>
 <Properties><DisplayName>YTM Remote Companion</DisplayName><PublisherDisplayName>YTM Remote</PublisherDisplayName><Logo>Assets\Logo50.png</Logo></Properties>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Resources><Resource Language="en-us"/></Resources>
 <Applications><Application Id="Companion" Executable="YtmCompanion.exe" EntryPoint="Windows.FullTrustApplication">
 <uap:VisualElements DisplayName="YTM Remote Companion" Description="YTM Remote extension update manager" Square150x150Logo="Assets\Logo150.png" Square44x44Logo="Assets\Logo44.png" BackgroundColor="transparent"/>
 <Extensions><desktop:Extension Category="windows.startupTask" Executable="YtmCompanion.exe" EntryPoint="Windows.FullTrustApplication"><desktop:StartupTask TaskId="YtmCompanionStartup" Enabled="false" DisplayName="YTM Remote Companion"/></desktop:Extension></Extensions>
 </Application></Applications>
 <Capabilities><uap7:Capability Name="globalMediaControl"/><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
"@
  Set-Content -Path (Join-Path $stage 'AppxManifest.xml') -Value $xml -Encoding UTF8
  $packageName = "YtmCompanion-$Version.msix"
  $package = Join-Path $out $packageName
  if (Test-Path -LiteralPath $package) { throw "Package already exists: $packageName" }
  & $makeappx pack /d $stage /p $package /o
  if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging failed' }
  & $signtool sign /sha1 $CertificateThumbprint /fd SHA256 $package
  if ($LASTEXITCODE -ne 0) { throw 'MSIX signing failed' }
  & $signtool verify /pa $package
  if ($LASTEXITCODE -ne 0) { throw 'MSIX signature verification failed' }
  $uri = 'https://github.com/almogmaman12/Ytm-r/releases/download/companion-channel'
  $installer = @"
<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2018" Version="$Version" Uri="$uri/YtmCompanion.appinstaller">
 <MainPackage Name="YtmRemote.Companion" Publisher="$p" Version="$Version" ProcessorArchitecture="x64" Uri="$uri/$packageName"/>
 <UpdateSettings><OnLaunch HoursBetweenUpdateChecks="0" ShowPrompt="false" UpdateBlocksActivation="false"/><AutomaticBackgroundTask/></UpdateSettings>
</AppInstaller>
"@
  Set-Content -Path (Join-Path $out 'YtmCompanion.appinstaller') -Value $installer -Encoding UTF8
} finally {
  Remove-Item $stage -Recurse -Force
}
