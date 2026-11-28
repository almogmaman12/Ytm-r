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

Chrome is not closed by this update. Starting with companion 0.1.0.11, a phone-requested update first registers a temporary, non-elevated Windows Task Scheduler task running under the signed-in user. The task survives the companion shutdown, checks the installed package family and version, activates the updated app by its Windows application identity, retries for a bounded period and removes itself. If Windows refuses task registration, the update is cancelled before shutdown. Windows native restart registration is retained as a second path. If the update never completes, the task attempts to restore the running companion when possible. The user must stay signed in, and Task Scheduler must be available. From 0.1.0.13 the task launches a self-contained Windows GUI-subsystem restart helper copied from the signed package, not PowerShell or a console. It uses Windows package and activation APIs; no terminal is opened. The latest restart.log is kept in the package's LocalState folder and exposed in the diagnostic viewer. Temporary helper copies are cleaned up on later updates. Upgrade to 0.1.0.11 manually once if the old companion stops; the new restart mechanism can only protect updates initiated by the new version. Verify the new version and relay connection. The underlying App Installer feed may advance between review and actual Windows deployment; the OS manages the final package selection. The standalone development EXE and unrelated MSIX installations are not supported by this remote manager.

## Recovery

Exit Chrome fully before restoring a trusted extension backup to the original folder path. Preserve the original backup and never delete the Chrome profile. For Windows companion issues, check App Installer/Windows logs and the signed release channel; do not downgrade using an untrusted package. Keep a backup of settings before migration. A release request or successful commit is not a guarantee of a completed CI run or runtime update.

[Install companion](../../companion/README.md) · [Maintainer signing](../../companion/release/README.md).

## Migrating from the OTA branch

The companion branch now includes the newer OTA phone UI. Keep the same Render service, root directory, build/start commands, access codes, tokens and DATABASE_URL. No new Neon schema or manual migration is needed. Deploy the branch, verify the phone and calendar, then update the companion and extension. On existing companion installs re-enter your trusted HTTPS relay, token and PC code. Re-enable remote tabs after updating to 2.4.6. If deployment fails, switch back to your prior working branch or deploy its last successful commit.

## Companion settings backups

From companion 0.1.0.10, ordinary saves and startup maintain a validated settings mirror. A manually requested phone-side companion update creates a separate pre-update snapshot and refuses to start if that backup cannot be written. OS-scheduled App Installer updates cannot be intercepted, so their protection is the continuously maintained mirror. Corrupt or missing primary settings recover from the current mirror; unsupported schemas or two damaged copies fail closed. See [settings durability](../../companion/README.md#settings-durability-companion-01010-and-later).

## Signed extension rollback

In the phone PC tab, open Updates, enter an older published signed version (for example 2.4.5), and review the signed archive and permission changes. Approve the exact verified rollback within ten minutes. The companion downloads from the fixed versioned GitHub release, verifies the signature and hash, closes Chrome gracefully, retains the current extension folder as a backup and installs at the same path. Automatic extension shell updates are disabled before rollback so the older version is not immediately replaced. Re-enable them locally when ready. Rollback requires the existing remote extension update opt-in; unsupported manifest capability changes are rejected. It does not roll back the Render relay or OTA payload. Only signed historical releases are eligible, not arbitrary local backup directories.
