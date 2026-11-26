# YTM Remote

**Self-hosted YouTube Music and YouTube remote, with over-the-air PC updates and an installable phone web app.** Control playback, browse your library, manage paired devices, view your Google Calendar, and monitor your own relay. No shared Google account is needed on the phone.

[OTA branch](https://github.com/almogmaman12/Ytm-r/tree/feature/ota-remote-loader) · Chrome extension shell 2.4.3 · Node.js 18+ · Optional Neon PostgreSQL

## Quick navigation

- [Features](#features)
- [Setup](#setup-about-10-minutes)
- [Persistent storage with Neon](#persistent-storage-with-neon)
- [Calendar and reminders](#optional-google-calendar-website-grabber-and-push-reminders)
- [Paired phones](#pair-a-second-phone-with-a-short-code)
- [System Center](#phone-system-center)
- [Updating and extension reloads](#updating-the-point-of-all-this)
- [Security](#trust-model-read-this)
- [Troubleshooting](#if-something-goes-wrong)

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

## Features

| Area | Capabilities |
|---|---|
| Now playing | Artwork, live playback state, seek, volume, play/pause, skip, like, shuffle, repeat, speed, radio, similar songs, artist pages, ad status and available skip-ad action. |
| Playback studio | Speed 0.25x–2x, boost 100–500%, sleep timer 1–720 minutes or end of song. PC-side sleep timer continues when the phone disconnects. |
| Search and library | Songs, albums, artists and playlists; suggestions, local search history, home shelves, Liked songs, saved albums, recently played, grid/list layouts, pinned collections and browsable album/playlist/artist pages. |
| Queue | Real site queue, play next, add to end, jump, drag reorder, multi-select, remove, clear, undo, duplicate warning, autoplay suggestions, save queue as a playlist. |
| Phone experience | Installable web app, mini player, gestures, dark/AMOLED themes, accents, density, haptics, optional lock-screen controls, screen-on setting, volume limit and home-screen shortcuts. |
| Paired phones | Single-use pairing codes, online/offline status, individual calendar permission, pause/resume without re-pairing, permanent removal and private activity history. |
| Calendar | Read-only Google Calendar website grabber, week/month/day views, timed events and end times, remaining-event filter, server cache and optional owner reminders. |
| Reliability | Automatic reconnect, cached phone shell, PC wake/open/switch, quick and deep PC checks, relay diagnostics, automatic phone update detection and System Center. |
| Persistent storage | Optional Neon database for devices, calendar snapshots, notification configuration, activity history, connection history and application usage metrics. |

### Playback details

- Play next / add to end supports songs and whole collections. If YouTube Music refuses a single song, it can enter the waiting queue. Up next edits the site's own queue; undo restores at most the first 60 removed songs, and multi-select supports up to 40.
- Browse artist, album and playlist pages before playing. Pin favorite collections locally and add the current or selected song directly to a playlist. YouTube Music library features require the signed-in PC session.
- The do-not-play list is stored in the PC browser. It skips blocked autoplay/radio tracks; explicitly selected tracks can still play.
- Sleep timers run on the PC and fade out near the end. Boost uses dynamic audio processing; reduce speaker volume before using high levels.
- Optional Android lock-screen controls use silent audio on the phone, which can interrupt other phone audio. They are off by default.
- Press and hold an icon to see a hint, or a truncated song title to read the full title. The long press does not activate the item.
- Regular YouTube support is optional. It has playback, search, video queue, similar videos, radio and ads; YouTube Music library and block-list features remain site-specific.
- The helper can wake a tab and open/switch between YouTube Music and regular YouTube while Chrome is running. This cannot power on an offline PC. See [sound activation](#sound-in-a-tab-you-havent-clicked) for the optional Tap PC feature.

### Phone settings

| Page | Purpose |
|---|---|
| Appearance & feel | Theme, accent, list density, haptics and gestures. |
| Do-not-play list | Manage blocked songs and artists. |
| On this phone | Lock-screen controls, screen-on behavior and phone volume limit. |
| Connection & diagnostics | Live relay and Neon check, PC/helper status, calendar backup timestamp, notification registration, quick/deep PC checks and repair tools. |
| Paired phones | Pair, pause, resume, remove, grant calendar access and inspect device activity. |
| Security | Access code and connection token. |
| System Center | Phone updates, notifications, connection history and analytics, database usage and optimization, sanitized relay logs, security, and diagnostic reports. |

Settings that administer the relay or other devices are owner-only. The full System Center history and usage views additionally require a configured phone access code.

## Setup (about 10 minutes)

### 1. Fork and deploy your relay
Fork this repo on GitHub and select the OTA branch (`feature/ota-remote-loader`) or the equivalent branch in your fork. Any host with Node.js 18+ and WebSockets over HTTPS works.

On Render: New → Web Service → connect **your fork**, select the OTA branch, set **Root Directory** to `server`, **Build Command** to `npm install`, and **Start Command** to `npm start`. Enable auto-deploy. Free instances may sleep when idle, so the first connection can take a while. Set random `ACCESS_CODE` and `PC_CODE` environment variables before connecting devices.

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

## Persistent storage with Neon

Neon PostgreSQL is optional but recommended for hosts with an ephemeral filesystem. It uses SQL over HTTPS and the existing Node runtime; no additional package or database service is needed.

1. Create a private Neon project and PostgreSQL database (prefer a region near your relay).
2. Copy the Neon connection string, including the generated credentials, into a private Render environment variable named `DATABASE_URL`.
3. Redeploy the relay. Tables are created automatically; no manual SQL setup is required.
4. Verify the startup logs: `Neon paired-phone persistence ready`, `Neon calendar cache and notification persistence ready`, `Device activity history ready (neon)`, and `System Center ready (Neon)`.

| Data | Storage / retention |
|---|---|
| Paired devices, names, pause state and calendar grants | Neon; until revoked. |
| Calendar snapshots | Neon + RAM; 14 days, up to 80 events per snapshot. |
| Push subscriptions and VAPID identity | Neon; existing private VAPID environment override takes precedence. |
| Device activity | Neon; last 30 days, up to 200 entries shown. |
| Relay/PC connection history and SQL metrics | Neon; 30-day retention, recent activity and seven-day usage view. |
| Playback state, one-time pairing codes | RAM; not persistent. |
| Appearance settings, pins, phone credentials | Local phone browser storage. |

Without Neon, devices and calendar use private local files, and activity/history use process memory. Free Render storage may disappear on restart. Never commit `DATABASE_URL`, private keys, access codes or room tokens. The database contains private calendar titles and times and device authentication records. Treat it accordingly. Consult the provider's actual quota dashboard; this app's metrics are not a billing guarantee.

## Optional Google Calendar website grabber and push reminders

No Calendar API, OAuth or credentials. Enable Calendar access under extension Options → Advanced and approve Chrome's optional site permission. Any open Google Calendar tab can sync automatically, including Agenda and Week. Keep the Calendar display timezone equal to the PC timezone. Hebrew and English time ranges are supported when the displayed date and time are readable. Only rendered events are fetched; browse additional dates to cache them. Google markup changes may need OTA fixes.

The phone Calendar button requires strong existing `ACCESS_CODE` and `PC_CODE` (both at least 8 characters). The owner can grant paired phones read-only calendar access individually. The PC helper uploads up to 80 events. The relay serves snapshots from RAM and persists them to Neon when `DATABASE_URL` is configured, or to a private JSON file otherwise (14-day retention, hashed room keys, no event titles logged). Older, offline and unconfirmed empty snapshots cannot overwrite good cached data. Disabling Calendar clears the server snapshot.

With `DATABASE_URL`, the relay creates its calendar tables automatically, restores snapshots before accepting connections, writes changed events immediately, refreshes unchanged timestamps at most hourly, and retries failed writes. Existing PC snapshots repopulate an initially empty database after reconnecting. No PC extension reload is needed. Without Neon, set `CALENDAR_CACHE_FILE` to a persistent disk path; Render's free filesystem may lose the cache. The database contains private event titles and times, so keep its connection string private.

Enable notifications on the phone for generic reminders 10 minutes before readable timed events. Cached events remain visible after tab closure; reminders still require a live, fresh snapshot so cancelled events are less likely to trigger alerts.

With Neon, push subscription endpoints, recent successful reminder markers and the VAPID private key are saved in the database. Existing `VAPID_PRIVATE_JWK` takes precedence; otherwise a persistent key is created automatically. Never expose either secret. Open the owner phone once after the first deploy so its existing subscription can register again (a mismatched key is renewed if permission is granted). Reminders remain owner-only and require fresh live calendar data and an awake relay; persistence does not turn cached events into guaranteed offline notifications. Without Neon, set `VAPID_PRIVATE_JWK` from `node server/calendar-push.js` for stable keys; subscriptions then last only for the running process. Android Chrome is the primary target; iOS requires an installed web app.

The calendar grabber and end-time support require extension shell 2.4.3. If you already have that shell installed, the newer server-side cache, sharing and diagnostics features require no extension reload. Event end times are preserved where the site shows a readable range; no duration is guessed. Subsequent changes to `server/public/ota/calendar.js`, the phone interface and relay are OTA. The calendar payload is isolated from music scripts and only registered on the explicitly permitted Calendar origin.

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

## Sound in a tab you haven't clicked
Chrome keeps a tab silent until it has had a real click or key press, so a YouTube or YouTube Music tab opened from the phone used to stay silent until you clicked it on the PC. A script cannot fake that click (Chrome ignores those), so the extension sends a real one. In the extension settings turn on **Let my phone start sound** (extension version 2.4.1; reload it once in `chrome://extensions` and approve the required debugging permission if prompted). Chrome does not support optional debugger permission requests, so the permission is declared in the manifest. The feature remains off until you turn on the setting; switching it off stops the feature but does not revoke the manifest permission. From then on, when a tab connects to your phone and has had no click yet, the extension sends one real click to a blank spot of the page, never on a button, link or the player, and starts playing if you had just asked for it. Chrome shows its "started debugging this browser" bar for a fraction of a second. It happens at most once per 30 seconds per tab, only on music.youtube.com and www.youtube.com, and only when asked by the extension's own page script. If DevTools is open on that tab Chrome refuses and nothing happens. Without the setting nothing changes. The phone also has a **Tap PC / unlock sound** button below the volume slider while the PC tab is connected. It requests the same safe-spot activation manually, respects the existing extension setting and 30-second debugger cooldown, and reports whether the tap could be sent. Alternatives that need no extension permission: start Chrome with `--autoplay-policy=no-user-gesture-required`, or allow the two sites with Chrome's `AutoplayAllowlist` policy.

## Volume boost and artist radio
**Boost** (button next to Like/Shuffle/Repeat) plays louder than the site's 100%: 125, 150, 200 or 300%. The first version only added gain and a limiter, which barely helps on loud modern recordings because they already peak near full scale. It is now a real boost: gain, a compressor that lifts the quiet parts, make-up gain, a soft clipper and a hard limiter, with the processing getting stronger as you go up (125% to 500%). On a quiet recording 200% is about 20 dB louder; on a loud, already-compressed one it is about 6 dB louder (roughly twice as loud to the ear) and nothing goes past full scale. The price is a squashed, denser sound at the high levels. Lower your phone and speakers first. Boost is one setting for everything you play: it stays on across songs, tabs, YouTube and YouTube Music, and the relay re-applies it whenever a PC tab connects. If Chrome has not yet allowed sound effects on that tab, the button shows the level with `…` and the boost switches on by itself as soon as Chrome allows it (or on your next click or key press in that tab); nothing needs a click when Chrome already allows the tab to play sound.

**Artist radio**: tap **Radio** on Now Playing and choose Artist radio (it uses the artist of the playing song), or open an artist from Search and tap **Start artist radio**. It starts the artist's own Radio from their YouTube Music page. YouTube Music only.

## Pair a second phone with a short code
On the main (token-authenticated) phone: **Settings → Paired phones → Pair another phone**. It shows a code like `ABCD-EFGH` that works once and lasts 2 minutes. On the other phone open your relay's address, tap **I have a pairing code** and type it. That phone gets its own key, so it never needs the token or the access code. The list shows whether a device is connected, offline or paused. **Pause access** blocks its music and calendar access while retaining its key; **Resume access** lets it reconnect automatically. **Remove** permanently revokes its key. **Calendar access** is off by default for each paired phone and can be granted or revoked by the owner. Paired phones cannot manage other devices or enable calendar reminders. Up to 8 phones; wrong codes count towards the same address block as wrong access codes.

With `DATABASE_URL`, paired phones, pause status and calendar permissions are persisted in Neon. Otherwise they are stored in `devices.json`; set `DEVICES_FILE` on a persistent disk to keep them across redeploys. The database and file contain private room tokens and hashed device keys; never expose them.

### Device activity

Open **Settings → Paired phones → View device activity**, or use the Activity history button on an individual device. The owner can filter access changes and music requests, including records for removed devices. History records pairing, connections, disconnections, renaming, pause/resume, calendar grants/revocations, removals and selected remote command categories. Music requests are grouped over 30 seconds; a request is not proof that the PC executed it. Song titles, search terms, IP addresses and credentials are not stored in this history. Entries begin with the deployment that introduced history; they are not reconstructed from older logs.

## If someone finds your token (access codes)
A token alone can be stolen (a screenshot, a shared link). Set two codes as **environment variables** on your host (on Render: your service → **Environment**). The codes are not sent directly over the wire: connecting clients prove knowledge of the corresponding code using a one-time HMAC-SHA256 challenge. Use HTTPS and random, strong codes.
- `ACCESS_CODE`: required by phones. The phone page asks for it once and remembers it.
- `PC_CODE`: required by the PC extension (Options → "PC code"; reload the extension once after updating). Without it nobody who has your token can take the PC's place on the relay.
- Use at least 10 random characters without spaces. Calendar requires both codes to be at least 8 characters.
- After 5 wrong codes from one address in 10 minutes, that address is blocked for 15 minutes.
- **Lost phone or leaked credentials:** change `ACCESS_CODE` and redeploy to invalidate the old phone access code. Paired-device keys authenticate independently, so also remove or pause any lost/untrusted paired devices from the owner phone. If the token itself leaks, rotate it on the relay clients and PC. Changing the owner access code alone does not revoke existing paired keys.
- The relay log shows `refused` lines with the device and address for every failed attempt.

## Who is using it (relay logs)
The relay prints connection and command information to its normal output (on Render: the service's **Logs** tab), for example:
```
2026-10-24T19:39:06Z [room 6b353d] phone connected: Android Chrome, 203.0.113.7  (1 phone)
2026-10-24T19:39:08Z [room 6b353d] command play_video AAAAAAAAAA1  from Android Chrome, 203.0.113.7
```
- Each line shows the device (system and browser, from its User-Agent) and the network address it connected from. Connections, disconnections, a PC being replaced, refused commands and rejected connection attempts are logged too.
- The token is never logged; `room` is a short fingerprint of it, so lines from one setup can be matched up. An unfamiliar address next to a command is worth investigating; it may be a legitimate paired device, a changed network or an unauthorized client. Revoke suspicious devices and rotate leaked credentials.
- Volume, seek and state requests fire constantly, so they are left out. Set `LOG_ALL=1` to include them, or `LOG_COMMANDS=0` to log only connections.
- The address comes from your host's proxy header, so it is the real client address on Render, Fly and similar hosts. It can be faked by someone talking to the server directly, so treat it as a clue.

## Other security notes
- Without access codes the token is the only credential for the phone side (see above to add them). Use 20+ random characters and HTTPS. Anyone with it can control playback and see the current track title.
- The relay accepts only a fixed list of commands, clamps values, rate-limits and caps message sizes. Its CORS headers are open only under `/ota/` (public code, no secrets).
- The extension asks for access to `music.youtube.com`, plus `storage`, `alarms`, `userScripts` and the declared `debugger` permission for opt-in sound activation. Access to `www.youtube.com` and `calendar.google.com` is optional and requires the corresponding setting and Chrome permission prompt. Token and relay address are kept on this PC (`storage.local`), not synced.

## Work computers
Check your workplace's IT policy before installing extensions or sending traffic to an external server. This project does not try to hide itself from IT or monitoring tools.

## If something goes wrong
- **Settings say "Chrome setting: Off":** turn on **Allow User Scripts** for the extension (steps above).
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

## Phone System Center

Open Settings → System Center. All paired phones can check the phone app build; a code-authenticated owner can also view connection history and database usage. The relay computes a fingerprint from the phone HTML and service worker at startup, exposes only the build and release notes at `/app-version.json`, and embeds the build into the served HTML. Update release notes in `APP_RELEASE` in `server/server.js` when shipping a new phone feature. A user-approved update fetches the current phone page without reloading the PC extension or deleting local settings. Update checks run only while the phone is visible and already connected.

Connection history starts with the first System Center deployment and keeps 30 days of room-scoped PC/helper transitions and relay-wide start/stop and database error/recovery events. A relay heartbeat is recorded at most every 30 minutes while clients are connected. Unobserved gaps are not measured downtime; no external monitor or idle keep-alive is installed.

The database dashboard shows relay-wide app SQL-over-HTTPS request counts, failed requests and average response times by UTC day, plus the allocated PostgreSQL table/index storage for this application's tables. Storage measurements are cached for five minutes. Internal System Center SQL is excluded from request counts to avoid self-counting; metrics are batched, and a sudden stop can lose unflushed metrics. This is not a Neon billing, compute or account-wide usage meter. No new environment variables or dependencies are required.

### System Center 2.0

The owner-only System Center now includes:

| Section | What it measures or displays |
|---|---|
| Notifications | Database error/recovery, failed calendar backup/retry recovery, new pairing, rate-limit blocks, observed PC playback disconnects lasting at least 15 minutes and recovery. Includes persistent mark-all-read and optional system push alerts. |
| Connection analytics | Sampled WebSocket round-trip latency by PC, helper and phone, average and 95th percentile, observed connect events and estimated observed relay session spans for the last 24 hours. |
| Neon optimization | UTC-day measured application SQL calls, failures and average response time by feature, storage allocation and rule-based recommendations. No automatic database tuning or deletion. |
| Live relay logs | Sanitized structured application events, search and severity filters. Initial history is read from Neon; visible live refreshes read memory, not Neon. This is not the raw Render stdout stream. |
| Security | Grouped rejected authentication, invalid pairing and device keys, rate-limit blocks and paired-device administration events. Relay-wide security events contain no IP addresses or attempted credentials; repeat failures are grouped over one minute. |
| Diagnostic report | Download or copy sanitized JSON with build, connection status, calendar backup metadata, measured database usage and recent events. Partial reports are available if the database cannot be queried. |

System alerts arrive in the authenticated owner phone when connected. Enable optional push alerts under System Center → Notifications after setting up calendar notifications on the owner phone. Both use the same existing subscription and generic privacy-preserving Web Push message. Push alerts are opt-in and grouped to avoid frequent notifications; they are not guaranteed during Render sleep, relay crashes, or network/provider failures.

Telemetry is retained for 30 days with Neon, sampled from existing heartbeat traffic at most once per five minutes per room and connection type, and batched for storage about every five minutes. The latency values are WebSocket round-trip samples, not direct internet speed measurements or PC execution times. System Center telemetry queries are excluded from application usage counters. Failed writes are retried while the relay remains alive; a sudden process termination can lose unflushed records. Security counts are grouped observations, not exact attack counts. No raw SQL, IP addresses, room tokens, device keys, search terms, track titles or calendar event text are included in these new logs or reports. The existing Render logs remain separate.

All of these features use the existing server and phone web app; the extension shell and OTA payloads are unchanged.

## License
MIT
