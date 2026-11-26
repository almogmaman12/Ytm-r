# YTM Remote Windows Companion (experimental)

This is a separate, opt-in Windows tray application. The existing Render deployment,
Neon database, phone interface and Chrome extension are unchanged by this branch.

## Current scope

- Password-protected local configuration (PBKDF2-SHA256, random salt, 600,000 iterations).
- Identifiable tray icon, normal Exit action and standard Windows startup setting.
- No routine notifications or update balloons. Setup and explicit settings actions may show dialogs;
  Windows security and installation prompts remain under Windows control.
- Periodic release checks directly against the Ytm-r GitHub Releases page. No Render or Neon requests.
- Automatic signed **extension** updates, only after the owner enables them and when Chrome is fully closed.
- Same extension directory path and manifest identity, previous directory backed up. Never edits the Chrome
  profile, tokens, passwords, cookies or extension storage, and never uninstalls the extension.
- A signed MSIX packaging script and App Installer definition for companion updates using Windows'
  supported update system. They require a trusted publisher certificate and released packages.

Remote audio, PC power controls, PC monitoring and phone-side companion management are **not included**
in this initial updater prototype. There is no remote shell, inbound listener, arbitrary command execution
or access to Chrome profile data. This is not a hidden or tamper-resistant process.

## Build and try

Build from this folder on Windows with .NET 8:

```powershell
dotnet publish YtmCompanion.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o out
```

A Windows CI workflow is provided in `.github/workflows/companion-build.yml`. Test artifacts are unsigned
development builds, not production installers. Do not enable automatic updates until the signer and
the initial signed release have been verified.

Open the companion once, create a local password (minimum six characters; a longer unique password is recommended), choose the exact unpacked extension directory that
is already loaded in Chrome. You can save initial settings without a release key. Once a signed release is available, open Advanced: release verification key and paste the trusted P-256 release **public** key. Automatic extension updates stay disabled until a key is provided. Enable updates and startup only if desired. The public key is not a password; keep the private key offline.

Routine checks occur every six hours when Chrome is closed. If Chrome is running, the updater waits
locally and checks again in two minutes, without downloading anything. Chrome can keep running after
all its windows are closed, so this may require a full Chrome exit. Do not close or terminate Chrome
automatically. The update can be deferred indefinitely when Chrome never fully stops.

## Publish an extension release (trusted maintainer)

Use a separate P-256 key pair and keep the private key off GitHub and off the companion PC.
For example, on a trusted signing machine:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out extension-signing-private.pem
openssl ec -in extension-signing-private.pem -pubout -out extension-signing-public.pem
```

Increment the existing manifest version in a reviewed extension release. ZIP the contents of the
extension directory (manifest.json at the root), not the parent directory. Put the input ZIP outside
the output directory. Sign the archive with:

```sh
node release/sign-extension.mjs /path/to/input.zip 2.4.4 /secure/private.pem /path/to/output-directory
```

Upload the resulting `extension.zip`, `extension-release.json` and `extension-release.sig` to a reviewed
GitHub Release marked Latest. The companion requires an authentic signature, exact archive hash,
increasing version, safe archive paths and unchanged manifest capabilities. Changes to the permission
declarations, host access, identity or other manifest fields require a manual review and update.
A latest release without those three files will fail safely; include them on companion-only releases too.

The updater replaces only the selected source directory and retains a timestamped sibling backup.
To roll back, exit Chrome completely and restore a verified backup to the original directory path.
Do not delete the only known-good backup. Inspect backup disk usage occasionally. A power loss or Chrome
starting during the directory swap can still require manual recovery. No guarantee of uninterrupted
updates is made.

## Companion auto-update (signed package)

On a trusted Windows signing machine, with the Windows SDK (makeappx and signtool on PATH) and a
legitimate, trusted code-signing certificate already installed, run:

```powershell
.\release\package-msix.ps1 -Publisher 'CN=Your actual publisher' -CertificateThumbprint 'YOUR_CERT_THUMBPRINT' -Version '0.1.0.0' -OutputDirectory .\signed-release
```

Use the exact same publisher and package identity for every release. Increment the four-part MSIX
version each time. Publish both signed files, `YtmCompanion.msix` and `YtmCompanion.appinstaller`,
to the Latest GitHub Release alongside the extension assets. Install initially using the App Installer
file only after validating the publisher. Windows checks for later updates on launch and through the
supported background mechanism; it may defer installation or show required OS prompts. In the MSIX
edition, startup is managed in Windows Settings > Apps > Startup. The unpackaged test EXE does not
self-update.

See Microsoft's documentation:
https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings

## Security and limitations

The local password protects the settings UI from casual access, not against an administrator or a user
with full access to the Windows account and its files. It is separate from the existing extension
password, and the companion never reads or uploads the extension credentials. Verify all builds and
signed packages before using them on the production PC. The source and workflows are experimental,
and Windows runtime, package signing, Chrome restart behavior and settings preservation need actual
Windows integration testing before release.
