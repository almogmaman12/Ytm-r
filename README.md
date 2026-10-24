# YT Music Remote (self-hosted, updates over the air)

Control YouTube Music playing on a PC from your phone, with no shared Google account.

> **This is the self-updating version.** If you would rather install an extension once and update it by hand, use the simpler version on the [`main` branch](https://github.com/almogmaman12/Ytm-r/tree/main).

**Everyone runs their own copy.** You fork or clone this repo, deploy your own relay server from it, and install the small Chrome extension once. From then on the extension downloads its working code from *your* relay, so a `git push` to your repo updates the PC by itself. There are no secrets in this repo: your relay address and token are typed into the extension and the phone page.

```
your git repo --push--> your relay server <--wss--> phone page
                              |   ^
                  code + wss  v   |
                  Chrome extension  -->  music.youtube.com
```

## Parts

| Folder | What it is |
|---|---|
| `server/` | Node relay (`ws`). Forwards commands by secret token, serves the phone page (`server/public/`) and serves the extension's code from `server/public/ota/`. |
| `server/public/ota/` | **The part that updates over the air.** `page.js` and `content.js` (the code that runs on music.youtube.com) and `ota.json` (which files, and where they run). |
| `extension/` | The **shell**, installed once. It stores your relay address and token, downloads the files listed by your relay, checks them, and runs them on `music.youtube.com` only. |

## What you can do from the phone
- Play, pause, next, previous, seek and volume (the volume is the site's own player volume, shown live).
- Search for songs and tap one to play it. It starts the way a click on the site would, so the page, title and queue follow.
- **Play next:** adds a song straight into YouTube Music's own queue, right after the current song. If the site refuses, it goes into a short "Waiting to be queued" list on the phone and plays when the current song ends.
- **Up next:** shows YouTube Music's real queue. Tap a song to jump to it, press ✕ to remove it, or press **Edit** and drag the handles to reorder.

## Setup (about 10 minutes)

### 1. Fork and deploy your relay
Fork this repo on GitHub. Any host with Node and WebSockets over HTTPS works (Render, Fly.io, Railway, a small VPS).

On Render: New → Web Service → connect **your fork**, **Root Directory** `server`, **Build Command** `npm install`, **Start Command** `npm start`. Auto-deploy on push is what makes updates automatic. Free instances sleep when idle, so the first connection can take a while.

Local test: `cd server && npm install && npm start`, then open http://localhost:3000.

### 2. Install the extension (once, on the PC)
Needs Chrome 135 or newer.
1. Clone or download your fork. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the `extension/` folder.
2. Open the extension's **Details** page and turn on **Allow User Scripts** (Chrome 138+; on older versions Developer mode is enough). The settings page tells you if this is still off.
3. The extension is named "Tab Helper" in Chrome (a deliberately plain name, so it doesn't stand out on your own machine). Click its icon, or open `chrome://extensions` → **Details** → **Extension options**; the settings page also opens by itself right after install. On that page enter your relay address (for example `https://my-relay.onrender.com`), press **Generate token**, then **Save & connect**. It should say the remote code is loaded.
4. Open `music.youtube.com`. The settings page shows the tab as connected.

### 3. Open the phone page
Visit your relay address on your phone, paste the same token, and tap Connect. Use "Add to Home screen" to install it.

## Updating (the point of all this)
Change anything under `server/` (including `server/public/ota/`), commit and push. Your host redeploys. The extension checks the relay about every 10 minutes and whenever a YouTube Music tab loads, or press **Check for update now** in its settings. A new version is applied to the open tab without reloading it.

What the extension checks before it runs anything:
- the file list comes from your relay's `/ota/manifest.json` (a SHA-256 for every file, computed by the server);
- each downloaded file must match its hash and begin with the `// ytmr-payload` marker (so an error page or captive portal can never be run);
- only `https` relays are accepted (plain `http` only for localhost, or if you tick the advanced box);
- if the relay is down or an update is refused, the last good copy keeps running.

If you change the extension shell itself (anything in `extension/`), reload it in `chrome://extensions`. A payload can declare `"requiresShell": N` in `ota.json`; a shell older than that holds the update back and tells you to update the extension folder.

## Trust model: read this
The extension runs code downloaded from your relay on `music.youtube.com`, where you are signed in to Google. **Whoever can push to your repo or control your relay host can run code in that tab.** That is the price of over-the-air updates. So: use your own relay, turn on two-step verification for your git and hosting accounts, and never point the extension at someone else's relay. The hash checks protect against corruption and wrong files, not against a compromised relay.

Because of this, an extension like this is not suitable for the Chrome Web Store (it forbids remotely hosted code), which is why it is installed unpacked from your own clone.

## Protect your repo (it controls your PC's browser tab)
Anything pushed to the branch your relay deploys becomes code that runs in your YouTube Music tab, so treat the repo like a password:
- Turn on two-factor authentication (a passkey is best) on GitHub and on your hosting account.
- Add a branch rule (Settings → Rules → Rulesets) on your deploy branch that blocks force-pushes and deletion. Requiring signed commits is stronger still, but then your own commits must be signed too.
- Turn on Dependabot alerts and security updates, and keep secret scanning and push protection on.
- Make sure Render (or your host) deploys only the branch you trust.
- Git stores your email in every commit and the repo is public. Turn on "Keep my email addresses private" and "Block command line pushes that expose my email" in GitHub's email settings, and commit with your `…@users.noreply.github.com` address.

## Other security notes
- The token is the only credential for the phone side. Use 20+ random characters and HTTPS. Anyone with it can control playback and see the current track title.
- The relay accepts only a fixed list of commands, clamps values, rate-limits and caps message sizes. Its CORS headers are open only under `/ota/` (public code, no secrets).
- The extension asks for access to `music.youtube.com` only, plus `storage`, `alarms` and `userScripts`. Token and relay address are kept on this PC (`storage.local`), not synced.

## Work computers
Check your workplace's IT policy before installing extensions or sending traffic to an external server. This project does not try to hide itself from IT or monitoring tools.

## If something goes wrong
- **Settings say "Chrome setting: Off":** turn on **Allow User Scripts** for the extension (steps above).
- **"PC offline" on the phone:** Chrome must be running with a YouTube Music tab open, and both sides need the same token.
- **"Another tab or computer took over":** two places can't share a token. Start music in the tab you want, or give the other its own token.
- **"Reload the YouTube Music tab":** shown once after the first install or when the tab was open before an update that needs it.
- **A relay on your home network:** Chrome blocks public pages from reaching local addresses, so use a public https relay.
- **Relay on a free plan:** it sleeps when idle; both sides reconnect on their own.

## Known limitations
- Search, tap-to-play and the queue features rely on YT Music internals (its search API, page router and queue store), which Google can change without notice. Fix it in `server/public/ota/page.js` and push; the extension picks it up by itself.
- Reordering moves a song by removing and re-adding it in the site's queue, one drag at a time.
- If the queue panel never shows your songs on the phone, open the PC's page console (F12): the script logs a warning there saying which step failed.
- Run tests with `cd server && npm test`.

## License
MIT
