# Windows companion setup

[Project home](../README.md) · [Troubleshooting](../docs/troubleshooting/README.md)

The optional Windows tray companion is separate from Chrome. It provides a signed extension updater, Windows status, native controls and a phone-managed MSIX update mechanism. The source is experimental; check the release workflow and validate on your own PC.

## 1. Install the signed Windows package

1. Open the [companion-channel release](https://github.com/almogmaman12/Ytm-r/releases/tag/companion-channel).
2. **First installation only: trust the verified publisher certificate.** Download [publisher.cer](https://github.com/almogmaman12/Ytm-r/releases/download/companion-channel/publisher.cer) from the official companion release into your Downloads folder. Verify its fingerprint against the maintainer's trusted fingerprint before importing (adjust the command if your Downloads folder is redirected or the filename changes). Open **PowerShell as Administrator** and run:

   ```powershell
   Import-Certificate -FilePath "$env:USERPROFILE\Downloads\publisher.cer" -CertStoreLocation "Cert:\LocalMachine\TrustedPeople"
   ```

   This imports the public certificate into the machine's Trusted People store so Windows can validate the signed MSIX. Do not import an unverified certificate, a CI test certificate or the private PFX. This step is normally required only once per PC for the same publisher certificate; repeat verification and trust setup if the certificate changes.
3. Download and open [YtmCompanion.appinstaller](https://github.com/almogmaman12/Ytm-r/releases/download/companion-channel/YtmCompanion.appinstaller), rather than a random standalone executable, to associate the package with the update channel.
4. Open YTM Remote Companion from Start. Find its tray icon (including the hidden tray overflow), then open Settings.
5. Create a local password (at least six characters), select the exact unpacked extension folder used by Chrome, and optionally enable automatic signed extension updates. A production publisher-key build includes the verification key.
6. For startup, enable the packaged app in Windows Settings > Apps > Startup if desired.

If migrating from the unpackaged EXE, exit it, disable its old startup entry and back up the existing settings in LocalAppData. Verify the packaged app can read them before removing old files. Never run both editions together.

## 2. Connect the phone

Use your own trusted HTTPS relay running this branch. Both ACCESS_CODE and PC_CODE must have at least eight characters. Existing companion installations without a saved relay URL must enter the URL, token and PC code again after updating.

1. Right-click the tray icon, choose Windows status connection and unlock the local settings.
2. Enable Share Windows status with my owner phone. Enter the same HTTPS relay URL, room token and PC_CODE used for the extension. Save.
3. Optionally enable Windows audio/media/Chrome controls, remote signed extension updates, and remote companion updates. Each additional update feature requires its own local opt-in.
4. On the authenticated owner phone open the **PC** bottom navigation page or System Center > Windows status. Refresh to view the native snapshot.

The owner token and access code are required on the phone; paired guest phones cannot manage Windows. The native connection can remain active even when Chrome is closed.

## 3. PC capabilities

### Native status and controls

This feature is off by default. Configure your own HTTPS relay. Both ACCESS_CODE and PC_CODE must have at least eight characters. Follow the connection steps above. The credentials are protected with Windows DPAPI for the current user. Disabling the feature deletes the saved protected credentials and disconnects the session.

In the authenticated owner phone's System Center, open Windows status. The connection exposes companion version, PC uptime, physical memory, battery, AC power and Chrome window/process status. It sends a small snapshot once per minute while enabled, with no new Neon tables or queries and no server-side history. A separate local password-protected opt-in enables master volume, mute, default playback output selection, fixed Windows media keys (previous, play/pause, next, stop), and launch/close Chrome. Existing installations keep remote controls disabled until explicitly enabled. No arbitrary commands or executable paths are accepted. Chrome launches only from standard installation directories and closes visible main windows gracefully (no force-kill). A close request may leave confirmation dialogs or background processes. Media keys target the player chosen by Windows; apps tied to a fixed audio output may not follow a switch. Default endpoint selection uses a Windows compatibility COM interface that may fail on some builds; communications device routing is unchanged. Hardware and actual Chrome behavior require testing on the destination PC. A second native connection cannot replace an active one. Paired guest phones are not allowed to access status. The extra websocket may affect relay connection usage; no hosting plan change is required by the code.

## PC tab and Chrome tab controls

The owner phone has a dedicated PC bottom navigation page. The companion reads current Windows media session title, artist, app and playback state through Windows Global System Media Transport Controls when native controls are enabled; apps must publish a media session. Metadata is refreshed with status snapshots. Artwork is not transmitted. Chrome tabs require extension 2.4.6 and an explicit opt-in in the password-protected extension settings with Chrome's optional tabs permission. Only ordinary HTTP(S) non-incognito tabs can be listed, activated or closed. No browsing URLs, cookies, page content or history are transmitted or persisted. Tab titles can contain private information. Requests are routed only to the authenticated owner and only the explicitly approved configured HTTPS relay is accepted by the extension. Close actions require confirmation in the phone UI. No generic browser command or navigation URL is accepted.

## 4. Update managers

The [update guide](../docs/updates/README.md) explains both remote update workflows, review restrictions and recovery. The signed extension updater changes the unpacked Chrome folder. The companion MSIX updater updates only the Windows app through the fixed App Installer channel. Chrome remains open during a companion update. Reconnection and actual installed version must be checked after an update.

## 5. Development build

```powershell
cd companion
dotnet publish YtmCompanion.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o out
```

Requires Windows and .NET 8. Development EXEs are not signed MSIX installations and do not support the App Installer update manager. Use the separate [release maintainer guide](release/README.md) for CI, publisher setup and signing. Routine settings are stored under the current user's LocalAppData in YTM Remote Companion; native credentials are protected using current-user DPAPI. The settings password protects casual local access, not a Windows administrator.

## Security and limitations

The local password protects the settings UI from casual access, not against an administrator or a user
with full access to the Windows account and its files. It is separate from the existing extension
password, and the companion never reads or uploads the extension credentials. Verify all builds and
signed packages before using them on the production PC. The source and workflows are experimental,
and Windows runtime, package signing, Chrome restart behavior and settings preservation need actual
Windows integration testing before release.
