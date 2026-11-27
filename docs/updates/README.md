# OTA, extension and Windows companion updates

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

## Updating (the point of all this)
Change anything under `server/` (including `server/public/ota/`), commit and push. Your host redeploys. Phone-only changes are delivered by the web app and can be detected by System Center. Server-only changes (including Neon schema and device administration) require no extension reload. The extension checks the relay about every 10 minutes and whenever a YouTube Music tab loads, or press **Check for update now** in its settings. A new version is applied to the open tab without reloading it.

What the extension checks before it runs anything:
- the file list comes from your relay's `/ota/manifest.json` (a SHA-256 for every file, computed by the server);
- each downloaded file must match its hash and begin with the `// ytmr-payload` marker (so an error page or captive portal can never be run);
- only `https` relays are accepted (plain `http` only for localhost, or if you tick the advanced box);
- if the relay is down or an update is refused, the last good copy keeps running.

**Site selectors update live.** The page elements the PC script presses and reads (like, shuffle, repeat, skip-ad, titles) have built-in defaults. `server/public/ota/selectors.json` can override any of them (see the note inside the file): edit it, push, and open YouTube Music tabs pick it up within 10 minutes, or at once when you press the refresh arrow on the phone. No extension update, no tab reload. Bad entries are ignored.

**What cannot be over the air.** Everything the phone shows, the relay, and everything that runs on the YouTube and YouTube Music pages is already updated this way. What stays in `extension/` is the part that uses Chrome's own tab, window and storage APIs (opening and waking tabs, the settings page, the update checker itself). Chrome does not allow downloaded code to run there, so changing it needs a reload.

If you change the extension shell itself (anything in `extension/`), reload it in `chrome://extensions`. A payload can declare `"requiresShell": N` in `ota.json`; a shell older than that holds the update back and tells you to update the extension folder.

## Signed extension updates (Windows companion)

Configure the actual unpacked extension directory and trusted P-256 publisher key in the companion. A normal automatic check runs only when Chrome is fully closed (six-hour interval; retry after two minutes when Chrome runs). It verifies signed metadata, archive hash, paths, versions and manifest compatibility. An automatic check never closes Chrome or grants new permissions.

For a phone-initiated update, enable Windows status, remote controls, and **Allow owner phone to review and install signed extension updates** in the tray settings. On the owner phone's PC page:

1. Press **Check / review update**. The companion reads its local manifest and the signed GitHub release, even while Chrome is open.
2. Review installed and latest versions and permission additions/removals. The approval is tied to the verified archive and installed manifest; reviews expire after ten minutes.
3. Press **Approve & update extension**. The companion re-verifies the release, requests graceful Chrome closure, waits for all Chrome processes to stop, and replaces the same directory with a backup retained. It attempts to reopen Chrome if it was open before installation.
4. Verify the displayed installed version and loaded shell. Chrome may still require manual permission approval or a manual reload.

No force-kill is used. If background Chrome processes or dialogs prevent closure, close Chrome fully and check again. Non-permission capability or identity changes and oversized reviews cannot be approved remotely. A missing release or invalid signature never authorizes installation.

## Signed companion MSIX updates

The companion app itself is independent of the extension. Install the signed MSIX through the fixed [App Installer channel](https://github.com/almogmaman12/Ytm-r/releases/tag/companion-channel). Windows checks for updates at launch and through its background update mechanism.

In a build supporting the companion update manager, enable **Allow owner phone to update the Windows companion itself** in the password-protected Windows status connection settings. This is a separate opt-in. In the PC page, use **Check companion update**, compare the installed package version with the version in the App Installer descriptor, then **Approve & update companion**. Review the release channel before approval. The app validates the fixed descriptor and package identity, rechecks the version and asks Windows to process the App Installer update. Windows validates the package signature; a version shown in the descriptor is not proof the package is already installed.

Chrome is not closed by this update. The companion may disconnect while Windows replaces it; it requests restart registration, but Windows may defer the update or not restart it automatically. Reopen it manually if necessary and verify the new version. The underlying App Installer feed may advance between review and actual Windows deployment; the OS manages the final package selection. The standalone development EXE and unrelated MSIX installations are not supported by this remote manager.

## Recovery

Exit Chrome fully before restoring a trusted extension backup to the original folder path. Preserve the original backup and never delete the Chrome profile. For Windows companion issues, check App Installer/Windows logs and the signed release channel; do not downgrade using an untrusted package. Keep a backup of settings before migration. A release request or successful commit is not a guarantee of a completed CI run or runtime update.

[Install companion](../../companion/README.md) · [Maintainer signing](../../companion/release/README.md).
