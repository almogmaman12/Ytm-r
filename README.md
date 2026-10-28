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
| `extension/` | The **shell**, installed once. It stores your relay address and token, downloads the files listed by your relay, checks them, and runs them on `music.youtube.com` (and on `www.youtube.com` only if you switch that on). |

## What you can do from the phone
- Play, pause, next, previous, seek and volume (the volume is the site's own player volume, shown live).
- **Search** songs, albums, artists or playlists (chips under the search box). Tap a song, album or playlist to play it; it starts the way a click on the site would, so the page, title and queue follow. Tap an artist to see their songs and albums, with a **Back** button.
- **Play next / add to end:** every song, album and playlist has two buttons. They put a song, or a whole album or playlist, into YouTube Music's own queue right after the current song, or at the very end. If the site refuses a single song, it goes into a short "Waiting to be queued" list on the phone and plays when the current song ends.
- **Library:** your playlists (with Liked songs first), saved albums and **Recently played** songs, from your own signed-in YouTube Music. Same tap and buttons as search results, so you can go back to a song from earlier.
- **Radio:** start a radio from the current song (button on the Playing screen) or from any song in search or your library (the radio icon on a row).
- **Device names:** name your phone in Settings ("Almog's phone"). The name shows in the relay log and next to songs you add to the queue ("added by …").
- **Connection check:** Settings → **Check** tests each part of the site integration (player, volume, navigation, queue, search, library) and shows which still work, with the reason for any that don't. **Deep check** also adds and removes a copy of the current song. When YouTube changes something you see exactly what broke; the fix is a push to `server/public/ota/page.js`.
- **Home:** the first tab in Library shows your YouTube Music home shelves ("Listen again", mixes and so on), each with the same tap and buttons as search results.
- **Similar songs** and **Artist page:** buttons on the Playing screen. Similar songs lists what the site's own radio would play next for the current song; Artist page opens the current artist's songs and albums. Album and playlist rows also have a **Show songs** button to see the tracks before playing.
- **Search suggestions and history:** suggestions appear as you type, and an empty search box lists your recent searches (kept on the phone only, with a clear button).
- **Update notice:** when the code on your PC changes after a push, the phone says so ("The PC picked up an update: version …"), and Settings shows the version running on the PC.
- **Repair note:** shortly after the PC connects (and when the version changes, or every 30 minutes), the phone quietly runs the quick connection check. If something fails it shows a plain-language note, for example that queue changes may not work while playback still does.
- **Force refresh:** the round arrow at the top of the Playing screen reconnects, clears what the phone remembered and asks the PC to resend everything (song, queue, volume, block list) and to look for a code update, without interrupting the music. Settings also has **Reload this page** and **Reload YouTube Music on the PC** (stops the music for a few seconds; use it after an update that asks for a reload).
- **Undo:** after removing a song, removing several, clearing the queue, or blocking a song or artist, a toast with an **Undo** button appears for a few seconds. (Undo for a very long queue brings back the first 60 songs.)
- **Queue editing:** in **Edit** mode each row also has **Move to top** and **Move to bottom** buttons. **Select** lets you tick up to 40 songs and then move them to the top or bottom, or remove them, in one go. Adding a song that is already coming up asks first, with **Add anyway**.
- **Explicit songs** show a small **E** in results, the library and the queue.
- **Waking-relay screen:** if the connection to the relay is lost for more than a few seconds (free hosting sleeps when idle), the phone shows "Waking up your relay" with a timer and keeps checking, then reconnects by itself. The phone page also keeps a copy of itself, so it still opens while the relay is asleep.
- **Do-not-play list:** **Never play…** on the Playing screen blocks the current song or its artist. Blocked songs are skipped automatically on the PC, even from autoplay or radio (if everything coming up is blocked it pauses instead of skipping forever). The list is in Settings, where each entry has **Allow again**. Songs you pick yourself on the phone still play. The list is kept in the PC's browser, not on the relay.
- **Regular YouTube (optional):** tick **Also control regular YouTube** in the extension's Advanced settings and approve Chrome's prompt. Then play, pause, seek, volume, next/previous, search for videos and tap-to-play work on `www.youtube.com`, and the phone shows what is playing there. The queue, library, home, radio and block list stay YouTube Music only. A YouTube tab only takes over the connection once a video plays in it, so it doesn't push out your YouTube Music tab.
- **Reopen YouTube Music:** if the tab was closed, the phone shows an **Open YouTube Music on the PC** button instead of leaving you at "PC offline". While no tab is open the extension keeps one idle connection to your relay (using the same PC code), and the button makes it open `music.youtube.com`. That connection can do nothing else. Chrome itself must still be running on the PC. You can turn it off with the checkbox in the extension's Advanced settings (reload the extension once after updating).
- **Up next:** shows YouTube Music's real queue. Tap a song to jump to it, press ✕ to remove it, press **Edit** to drag the handles and reorder, or **Clear** to remove everything coming up (the song playing stays). When the queue itself is empty, the songs YouTube Music will autoplay next are shown under an **Autoplay** heading (tap one to play it now).

## Setup (about 10 minutes)

### 1. Fork and deploy your relay
Fork this repo on GitHub. Any host with Node and WebSockets over HTTPS works (Render, Fly.io, Railway, a small VPS).

On Render: New → Web Service → connect **your fork**, **Root Directory** `server`, **Build Command** `npm install`, **Start Command** `npm start`. Auto-deploy on push is what makes updates automatic. Free instances sleep when idle, so the first connection can take a while.

Local test: `cd server && npm install && npm start`, then open http://localhost:3000.

### 2. Install the extension (once, on the PC)
Needs Chrome 135 or newer.
1. Clone or download your fork. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the `extension/` folder.
2. Open the extension's **Details** page and turn on **Allow User Scripts** (Chrome 138+; on older versions Developer mode is enough). The settings page tells you if this is still off.
3. The extension is named "Tab Helper" in Chrome (a deliberately plain name, so it doesn't stand out on your own machine). Clicking its toolbar icon does nothing on purpose; to change settings open `chrome://extensions` → **Details** → **Extension options**. The settings page opens by itself right after install. On that page enter your relay address (for example `https://my-relay.onrender.com`), press **Generate token**, then **Save & connect**. It should say the remote code is loaded.
   The first time the settings open they ask you to **set a password**; after that they stay locked (and lock again after the page sits in the background for a minute) until you enter it. Repeated wrong guesses are slowed down. A forgotten password can't be recovered: remove and reinstall the extension. This keeps other people who sit at your PC out of the settings; it does not encrypt what is stored, so it is not protection against someone with full control of the machine.
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

## If someone finds your token (access codes)
A token alone can be stolen (a screenshot, a shared link). Set two codes as **environment variables** on your host (on Render: your service → **Environment**). The codes are never sent over the wire: the relay and each device prove they know them with a one-time challenge (HMAC-SHA256), so a stolen token is useless without them.
- `ACCESS_CODE`: required by phones. The phone page asks for it once and remembers it.
- `PC_CODE`: required by the PC extension (Options → "PC code"; reload the extension once after updating). Without it nobody who has your token can take the PC's place on the relay.
- 6 or more characters, no spaces. Use random ones.
- After 5 wrong codes from one address in 10 minutes, that address is blocked for 15 minutes.
- **No PC needed to lock everyone out:** if a phone is lost or a token leaks, open your host's dashboard from any phone, change `ACCESS_CODE`, and redeploy. Every device that knew the old code is refused immediately. Then enter the new code on your own phone (Settings → Change access code).
- The relay log shows `refused` lines with the device and address for every failed attempt.

## Who is using it (relay logs)
The relay prints one line per event to its normal output (on Render: the service's **Logs** tab), for example:
```
2026-10-24T19:39:06Z [room 6b353d] phone connected: Android Chrome, 203.0.113.7  (1 phone)
2026-10-24T19:39:08Z [room 6b353d] command play_video AAAAAAAAAA1  from Android Chrome, 203.0.113.7
```
- Each line shows the device (system and browser, from its User-Agent) and the network address it connected from. Connections, disconnections, a PC being replaced, refused commands and rejected connection attempts are logged too.
- The token is never logged; `room` is a short fingerprint of it, so lines from one setup can be matched up. An address you don't recognise next to a `command` line means someone has your token: generate a new one.
- Volume, seek and state requests fire constantly, so they are left out. Set `LOG_ALL=1` to include them, or `LOG_COMMANDS=0` to log only connections.
- The address comes from your host's proxy header, so it is the real client address on Render, Fly and similar hosts. It can be faked by someone talking to the server directly, so treat it as a clue.

## Other security notes
- Without access codes the token is the only credential for the phone side (see above to add them). Use 20+ random characters and HTTPS. Anyone with it can control playback and see the current track title.
- The relay accepts only a fixed list of commands, clamps values, rate-limits and caps message sizes. Its CORS headers are open only under `/ota/` (public code, no secrets).
- The extension asks for access to `music.youtube.com`, plus `storage`, `alarms` and `userScripts`. Access to `www.youtube.com` is optional: it is requested only when you tick the box in the settings, and Chrome shows its own permission prompt. Token and relay address are kept on this PC (`storage.local`), not synced.

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
- Search, library, tap-to-play and the queue features rely on YT Music internals (its search and browse APIs, page router and queue store), which Google can change without notice. Fix it in `server/public/ota/page.js` and push; the extension picks it up by itself.
- Reordering moves a song by removing and re-adding it in the site's queue, one drag at a time.
- If the queue panel never shows your songs on the phone, open the PC's page console (F12): the script logs a warning there saying which step failed.
- Run tests with `cd server && npm test`.

## License
MIT
