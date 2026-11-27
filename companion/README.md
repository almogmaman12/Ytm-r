# YTM Remote Windows Companion (experimental)

This is a separate, opt-in Windows tray application. The existing Render deployment,
Neon database, phone interface and Chrome extension are unchanged by this branch.

## Current scope

- Password-protected local configuration (PBKDF2-SHA256, random salt, 600,000 iterations).
- Identifiable tray icon, normal Exit action and standard Windows startup setting.
- Quiet startup with Windows at user sign-in, with no settings window or routine notification balloons. Setup on first manual launch and explicit settings actions may show dialogs; Windows security and installation prompts remain under Windows control.
- Settings persist in the current Windows user's LocalAppData, using an atomic replacement after flushing the file. Existing password hashes and options are retained. Unreadable settings disable updates without overwriting the original file.
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

A Windows CI workflow is provided in `.github/workflows/companion-build.yml`. Ordinary commits do not trigger it. When a development batch is complete, commit or update `companion/build-request.json` on `feature/windows-companion` to request a single build of the finished source. A newer explicit build request cancels an older in-progress build for that branch. Manual workflow dispatch also works where GitHub exposes it. Test artifacts are unsigned
development builds, not production installers. CI tests password and settings persistence across two separate Windows processes, and tests signed extension archives against isolated temporary fixtures (successful replacement, backup, invalid signature/hash, archive traversal, version checks, permissions, Chrome-open deferral). The tests never access the user's actual Chrome profile or publish releases. Do not enable automatic updates until the signer and
the initial signed release have been verified.

Open the companion once, create a local password (minimum six characters; a longer unique password is recommended), and choose the exact unpacked extension directory already loaded in Chrome. In a publisher-key build, verification is built in and no public key entry appears. Enable updates and startup only if desired.

Unsigned development builds without a bundled key still allow initial setup, but automatic extension updates remain disabled until a trusted public key is configured in Advanced settings. A bundled key takes precedence over an older locally configured key. If the trust anchor changes, automatic updates are disabled until the owner explicitly enables them again. Existing passwords and the selected extension folder are retained.

### One-time publisher setup

Generate the release signing key pair on your own trusted signing machine, outside the repository (see below). Keep an offline backup of the private key, and never add it to repository variables, commits, build artifacts, or the companion. For automated releases, only the protected environment secret described below should contain the signing key. For GitHub Actions test builds, add the contents of the **public** PEM file as the repository Actions variable `YTM_EXTENSION_PUBLIC_KEY_PEM` (Settings > Secrets and variables > Actions > Variables). The next build validates the P-256 public key and embeds it as an assembly resource. Without that variable, CI builds the development edition.

For the production MSIX package, the public PEM file is required by the packaging script. This is a release-maintainer step, not an installation step on the companion PC. All future releases should use the same trusted publisher key unless a reviewed key rotation is needed.

The tray status distinguishes a missing or inaccessible release manifest (HTTP 404), download errors, timeouts, validation failures, and local file errors. A 404 can also mean GitHub access is restricted. Missing releases and transient download errors are retried after 30 minutes. No routine notification is displayed.

The tray's Check for extension update action does not require the settings password. Opening settings and approving new permissions still require it. All checks retain signature, archive integrity, manifest compatibility and Chrome-closed safeguards.

Routine checks occur every six hours when Chrome is closed. If Chrome is running, the updater waits
locally and checks again in two minutes, without downloading anything. Chrome can keep running after
all its windows are closed, so this may require a full Chrome exit. Do not close or terminate Chrome
automatically. The update can be deferred indefinitely when Chrome never fully stops.

## Publish an extension release (trusted maintainer)

If you already generated a P-256 key pair, reuse it. Do not rotate the existing companion's public key unnecessarily. Keep the private key out of repository files and off the companion PC. For a new publisher only, run the following outside the repository on a trusted signing machine.
For example, on a trusted signing machine:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out extension-signing-private.pem
openssl ec -in extension-signing-private.pem -pubout -out extension-signing-public.pem
```

### Automated signing and publishing (recommended for convenience)

Create a GitHub Actions environment named `extension-signing` under repository Settings > Environments.
Restrict its deployment branches to the exact branch `feature/windows-companion` (selected branches
and tags, branch rule). Add an **environment secret**, not a variable, called
`YTM_EXTENSION_PRIVATE_KEY_PEM` containing the entire existing private PEM file. Keep the existing
repository Actions variable `YTM_EXTENSION_PUBLIC_KEY_PEM` unchanged. Protect write access to the
release branch and signing workflow; anyone who can modify trusted signing workflow code may be able
to misuse the secret. Required reviewers provide extra protection but would require an approval for
each release. Never paste the private key into chat, repository files, command arguments or logs.
Using an Actions secret is a convenience/security tradeoff compared with offline signing.

The new `.github/workflows/extension-release.yml` runs only when a release maintainer commits
`companion/release/request.json` on `feature/windows-companion`. The file must contain the exact
reviewed source commit SHA and its existing extension manifest version, for example:

```json
{"source":"<40-character reviewed OTA commit SHA>","version":"2.4.4"}
```

Replace the example with actual reviewed values. A phone-only change or an ordinary companion build
does not create a release. The workflow normally verifies the commit belongs to the OTA branch history. The explicitly reviewed experimental 2.4.4 shell commit has a narrow exception that checks its branch ancestry, exact changed extension files and unchanged manifest permissions. The workflow checks its extension version, archives only the extension directory without executing its contents,
verifies the signing key matches the public key, signs the archive, verifies its signature and hash
again, and publishes a new GitHub Release. It refuses to overwrite existing release tags with
published releases. The signing job has read-only repository access and the publish job has no
private key. No Render/Neon calls or changes to main/OTA branches are needed for signing.
To avoid GitHub's restriction on creating tags for some older commits, the release workflow uses the triggering commit as the tag target only when its complete extension tree is identical to the reviewed source tree. Release notes record both commits; the signed archive is still built from the reviewed source.

This workflow does not sign the companion's MSIX package; that requires a separate Windows
code-signing certificate. Do not create a request until the version is reviewed and approved.
A first signed release and Windows update test are still required before relying on unattended updates.

### Offline signing alternative

Increment the existing manifest version in a reviewed extension release. ZIP the contents of the
extension directory (manifest.json at the root), not the parent directory. Put the input ZIP outside
the output directory. Sign the archive with:

```sh
node release/sign-extension.mjs /path/to/input.zip 2.4.4 /secure/private.pem /path/to/output-directory
```

Upload the resulting `extension.zip`, `extension-release.json` and `extension-release.sig` to a reviewed
GitHub Release marked Latest. The companion requires an authentic signature, exact archive hash,
increasing version, safe archive paths and unchanged manifest capabilities. Cosmetic metadata, JSON formatting, reordered object properties and reordered permission sets do not prevent automatic installation. Changes to actual permissions or host access require explicit local approval: close Chrome completely, select **Review signed update** in the companion tray menu, enter the settings password and review the exact additions and removals. Approve only access you intend to grant. The approval applies only to the currently verified signed archive and is not saved as a general override. Chrome may still require its own permission approval. Changes to extension identity, executable entry points or unrecognized manifest fields require manual review in Chrome and cannot be approved using the companion. Background checks never open the review dialog.
A latest release without those three files will fail safely. Keep the dedicated companion-channel release marked non-latest.

The updater replaces only the selected source directory and retains a timestamped sibling backup.
To roll back, exit Chrome completely and restore a verified backup to the original directory path.
Do not delete the only known-good backup. Inspect backup disk usage occasionally. A power loss or Chrome
starting during the directory swap can still require manual recovery. No guarantee of uninterrupted
updates is made.

## Experimental extension startup activation

The companion branch has an experimental shell 2.4.4 with a loaded worker build identifier
and an opt-in startup reload setting in the password-protected extension options.
Chrome's supported runtime.reload() is called only when the owner has enabled the setting
and Chrome reports a newer manifest version than the running worker. The extension stores
one attempted reload per target version to avoid reload loops. It does not force Chrome to
close, change Chrome settings, grant permissions or accept remote reload commands.
The options page also shows the loaded shell build/API and has a manual Reload extension now button.

This feature requires an initial installation/reload of the experimental shell and explicit
opt-in. Increment both manifest.version and SHELL_BUILD on every subsequent shell release.
If Chrome caches both the manifest and the worker, or the reload attempt fails, use Chrome's
normal extension reload UI. Actual startup behavior must be tested in Chrome.
The signed-release workflow permits the exact reviewed experimental 2.4.4 source commit as a one-time exception to its OTA-source rule. The release is requested separately, and is not triggered by ordinary commits. The companion can download it without a new Windows build. Keep the original extension folder path and do not uninstall the extension. Once loaded, opt in via the extension settings. Actual Chrome activation still requires testing; a manual reload may remain necessary.

## Companion auto-update (signed package)

The Windows build workflow smoke-tests packaging with a disposable CI-only code-signing certificate. It verifies the package signature and the App Installer descriptor without installing the app or distributing that test package.

A separate `.github/workflows/companion-release.yml` is reserved for explicit signed Windows releases. It is triggered only by `companion/release/companion-request.json` on `feature/windows-companion`, with a four-part increasing package version. Before requesting a release, the maintainer must configure the separate GitHub environment `companion-signing`, restricted to this exact branch, with secrets `YTM_MSIX_PFX_BASE64` and `YTM_MSIX_PFX_PASSWORD`, and a pinned SHA-256 certificate fingerprint in the environment variable `YTM_MSIX_CERT_SHA256`. The signing certificate must have the subject `CN=YTM Remote Companion` and be trusted by the intended Windows computer. Keep the original certificate and private key securely backed up. Never upload the PFX as a build artifact or commit it. The existing extension PEM keys remain separate and unchanged.

The release job tests the companion, checks the certificate fingerprint, signs and verifies a versioned MSIX, and publishes it before updating the App Installer descriptor. The private certificate is never passed to the publishing job. The companion channel remains non-latest so extension downloads continue to use the extension release.

For personal testing, a dedicated self-signed code-signing certificate can be created at no cost. Trusting that certificate on the destination PC is a one-time, explicit Windows administrator action; do not trust the disposable CI certificate. Windows can defer updates while the companion is running. The unpackaged EXE is not an App Installer installation, so one initial migration is needed. Stop the old companion and disable its old startup entry before installing the packaged edition, back up settings, verify the packaged app can read them, then enable the packaged startup entry if desired. Do not remove the old files until migration is verified.

On a trusted Windows signing machine, with .NET 8, Node.js, the Windows SDK (makeappx and signtool on PATH) and a
legitimate, trusted code-signing certificate already installed, run:

```powershell
.\release\package-msix.ps1 -Publisher 'CN=Your actual publisher' -CertificateThumbprint 'YOUR_CERT_THUMBPRINT' -Version '0.1.0.0' -OutputDirectory .\signed-release -ExtensionPublicKeyPath C:\path\to\extension-signing-public.pem
```

Use the exact same publisher and package identity for every release. Increment the four-part MSIX
version each time. Maintain a separate GitHub Release with tag `companion-channel`, marked non-latest.
Upload the versioned signed package (e.g. `YtmCompanion-0.1.0.0.msix`) first; publish the updated
`YtmCompanion.appinstaller` only after the package is available. Do not replace older package assets.
This prevents companion updates from changing the extension's Latest release feed. Install initially
using the App Installer file only after validating the publisher. The existing unpackaged EXE requires
one initial migration to the package; do not run both editions or assume settings migrate without testing.
A trusted Windows signing certificate and package installation/update verification remain prerequisites. Windows checks for later updates at every launch (zero-hour interval) and through the
supported background mechanism; it may defer installation or show required OS prompts.
The tray menu displays the running companion version and whether it is the MSIX or test EXE edition. A Windows update installed in the background may require restarting the app to see the new running version. In the MSIX
edition, startup is managed in Windows Settings > Apps > Startup. The unpackaged test EXE does not
self-update.

See Microsoft's documentation:
https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings

## Experimental Windows status connection

This feature is off by default. It is pinned to the test relay at https://ytm-r.onrender.com/; deploy the companion branch to that test relay only. The production OTA deployment must remain unchanged. Both ACCESS_CODE and PC_CODE must have at least eight characters. From the tray, select Windows status connection, unlock settings, explicitly opt in, then enter the test relay token and PC code. The credentials are protected with Windows DPAPI for the current user. Disabling the feature deletes the saved protected credentials and disconnects the session.

In the authenticated owner phone's System Center, open Windows status. The connection exposes only companion version, PC uptime, physical memory, battery and AC power. It sends a small snapshot once per minute while enabled, with no new Neon tables or queries, no server-side history, and no remote commands. A second native connection cannot replace an active one. Paired guest phones are not allowed to access status. The extra websocket may affect test-relay connection usage; no hosting plan change is required by the code.

## Security and limitations

The local password protects the settings UI from casual access, not against an administrator or a user
with full access to the Windows account and its files. It is separate from the existing extension
password, and the companion never reads or uploads the extension credentials. Verify all builds and
signed packages before using them on the production PC. The source and workflows are experimental,
and Windows runtime, package signing, Chrome restart behavior and settings preservation need actual
Windows integration testing before release.
