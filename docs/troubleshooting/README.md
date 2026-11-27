# Troubleshooting

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

## If something goes wrong
- **Settings say "Chrome setting: Off":** turn on **Allow User Scripts** for the extension (see [extension setup](../../extension/README.md)).
- **"PC offline" on the phone:** Chrome must be running with a YouTube Music tab open, and both sides need the same token.
- **"PC offline" although Chrome and the tab are open (tab asleep):** Chrome's Memory Saver and background throttling can discard or freeze an idle tab until you focus it. Most reliable fix: Chrome Settings → Performance → Memory Saver → "Always keep these sites active" → add `music.youtube.com`. Extension 2.1.1 also marks the tab as non-discardable, holds a Web Lock (Chrome won't freeze pages that hold one), re-checks the connection when the tab resumes, and keeps its helper connected so the phone's **Wake YouTube Music on the PC** button can reload a discarded tab or briefly bring a frozen one to the front. This version changes `extension/`, so reload the extension once in `chrome://extensions`.
- **Why is the PC offline?** The phone shows when the tab was last connected and a likely reason: "Chrome is running, but the YouTube Music tab is closed or asleep" (the extension helper is still connected) or "Chrome itself is not reachable" (PC off or asleep, offline, or Chrome closed). Needs the helper switched on in the extension options (on by default).
- **"Another tab or computer took over":** two places can't share a token. Start music in the tab you want, or give the other its own token.
- **"Reload the YouTube Music tab":** shown once after the first install or when the tab was open before an update that needs it.
- **A relay on your home network:** Chrome blocks public pages from reaching local addresses, so use a public https relay.
- **Relay on a free plan:** it sleeps when idle; both sides reconnect on their own.

## Known limitations
- Search, library, tap-to-play and the queue features rely on YT Music internals (its search and browse APIs, page router and queue store), which Google can change without notice. Fix it in `server/public/ota/page.js` and push; the extension picks it up by itself.
- Reordering moves a song by removing and re-adding it in the site's queue, one drag at a time.
- If the queue panel never shows your songs on the phone, open the PC's page console (F12): the script logs a warning there saying which step failed.
- Run tests with `cd server && npm test`.

## Windows and updates

| Symptom | What to check |
|---|---|
| PC native status offline | Companion running, correct configured relay deployment, token and PC code, both relay codes strong, status sharing enabled |
| Controls disabled | Enable the separate Windows controls option in the tray connection settings |
| Remote tabs unavailable | Shell 2.4.6, tabs opt-in, Chrome optional permission, configured relay |
| Extension update waiting for Chrome | Close all Chrome windows and check for background Chrome processes; never force-kill unsaved work |
| Signed update unavailable | Latest extension release must include all three signed extension assets; companion-channel must not be Latest |
| Permission review required | Use phone review if enabled and supported, or the password-protected tray review; other capability/identity changes require manual Chrome review |
| Installed files changed but old worker runs | Use the startup reload opt-in or manually reload in chrome://extensions |
| First MSIX install fails because the publisher is not trusted | Verify the public publisher certificate and import it into LocalMachine\\TrustedPeople using elevated PowerShell; see [first installation](../../companion/README.md#1-install-the-signed-windows-package) |
| Companion update unsupported | Use the signed MSIX associated with the exact App Installer feed, not the standalone EXE |
| Companion disappears during update | Refresh after Windows completes the deployment; launch the companion manually if it does not restart |
| Build failed | Open GitHub Actions, select the failing job and inspect the exact test/build/signing error. Do not bypass failed checks or publish unsigned replacements. |

See the [update guide](../updates/README.md) and [release guide](../../companion/release/README.md). Version status in the phone is not proof of an installed update until the companion reconnects and reports its new version.
