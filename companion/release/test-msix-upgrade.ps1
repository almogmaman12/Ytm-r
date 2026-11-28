# Real Windows MSIX install -> in-place upgrade -> launch, using only disposable test packages.
# Never run on a production PC. No production signing material or network credentials are used.
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:GITHUB_WORKSPACE ('ytmr-msix-upgrade-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$publisher = 'CN=YTM Remote Companion CI Test'
$cert = $null
$packageName = 'YtmRemote.Companion'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivation {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    [PreserveSig] int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);
    [PreserveSig] int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
}
public static class YtmTestActivation {
    public static uint Launch(string aumid,string args) {
        var instance=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        try {
            uint pid;
            int hr=((IActivation)instance).ActivateApplication(aumid,args,0,out pid);
            Marshal.ThrowExceptionForHR(hr);
            return pid;
        } finally { Marshal.ReleaseComObject(instance); }
    }
}
'@
function Get-TestPackage {
  Get-AppxPackage -Name $packageName | Where-Object { $_.Publisher -eq $publisher }
}
function Run-Probe($phase, $expectedVersion) {
  $pkg = Get-TestPackage
  if ($null -eq $pkg -or @($pkg).Count -ne 1 -or [version]$pkg.Version -ne [version]$expectedVersion) { throw "Expected package $expectedVersion" }
  $result = Join-Path $work "$phase-result.txt"
  $aumid = $pkg.PackageFamilyName + '!Companion'
  $arguments = '--settings-upgrade-probe ' + $phase + ' "' + $result + '"'
  $probePid = [YtmTestActivation]::Launch($aumid,$arguments)
  $deadline = (Get-Date).AddSeconds(60)
  while (!(Test-Path -LiteralPath $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (!(Test-Path -LiteralPath $result)) { throw "Packaged $phase probe did not report a result" }
  $message = Get-Content -LiteralPath $result -Raw
  Write-Host $message
  if ($message -ne "PASS $phase $expectedVersion") { throw "Packaged settings $phase failed" }
  $process = Get-Process -Id $probePid -ErrorAction SilentlyContinue
  if ($process -and !$process.WaitForExit(15000)) { throw "Packaged probe failed to exit" }
}
try {
  if (Get-AppxPackage -Name $packageName) { throw 'Refusing to test over an existing companion installation' }
  $key = Join-Path $work 'extension-public.pem'
  node -e "const k=require('node:crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'});require('node:fs').writeFileSync(process.argv[1],k.publicKey.export({type:'spki',format:'pem'}))" "$key"
  if ($LASTEXITCODE -ne 0) { throw 'Test key generation failed' }
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
  $cer = Join-Path $work 'test.cer'
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  foreach ($version in @('0.1.0.1','0.1.0.2')) {
    & "$PSScriptRoot/package-msix.ps1" -Publisher $publisher -CertificateThumbprint $cert.Thumbprint -Version $version -OutputDirectory $work -ExtensionPublicKeyPath $key -SettingsUpgradeTest
  }
  Add-AppxPackage -Path (Join-Path $work 'YtmCompanion-0.1.0.1.msix')
  $first = Get-TestPackage
  Run-Probe 'seed' '0.1.0.1'
  # Real in-place package upgrade. Do NOT uninstall or reset app data between versions.
  Add-AppxPackage -Path (Join-Path $work 'YtmCompanion-0.1.0.2.msix')
  $second = Get-TestPackage
  if ($first.PackageFamilyName -ne $second.PackageFamilyName -or $first.PackageFullName -eq $second.PackageFullName) { throw 'Package identity/version did not upgrade' }
  # Do not activate the second package from the test harness: only the independent restart task may do so.
  $result = Join-Path $work 'verify-result.txt'
  $deadline = (Get-Date).AddSeconds(120)
  while (!(Test-Path -LiteralPath $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (!(Test-Path -LiteralPath $result)) { throw 'Independent restart task did not activate upgraded package' }
  $message = Get-Content -LiteralPath $result -Raw
  Write-Host $message
  if ($message -ne 'PASS verify 0.1.0.2') { throw 'Automatic restart or settings verification failed' }
  Write-Host 'PASS: independent task activated the upgraded signed MSIX; settings, credentials and recovery succeeded'
} finally {
  Get-TestPackage | ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName -ErrorAction SilentlyContinue }
  if ($cert) {
    Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
