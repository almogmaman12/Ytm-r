# YT Music Remote

Control YouTube Music playing on a PC from your phone, with no shared Google account.

```
Phone page  <--wss-->  Relay server  <--wss-->  Chrome extension  -->  music.youtube.com
```

Both the phone and the extension connect **outbound** to the relay, so no port forwarding is needed. They are paired by a long secret token. The relay stores nothing on disk and only forwards a fixed list of commands (play, pause, toggle, next, previous, volume, seek, search, play a specific song by ID, add or remove an "up next" song).

## Parts

| Folder | What it is |
|---|---|
| `server/` | Node relay (`ws`). Also serves the phone web page (`server/public/`), installable as a PWA. |
| `extension/` | Chrome (Manifest V3) extension. Runs only on `music.youtube.com`, no UI besides a settings page. |

## Setup

### 1. Deploy the relay
Any host that supports Node and WebSockets over HTTPS works (Render, Fly.io, Railway, a small VPS).

On Render: New → Web Service → connect this repo, set **Root Directory** to `server`, **Build Command** `npm install`, **Start Command** `npm start`. Free instances sleep when idle, so the first connection can take a few seconds.

Local test: `cd server && npm install && npm start`, then open http://localhost:3000.

### 2. Install the extension
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder.
3. Click the extension icon, enter your relay URL (for example `https://your-relay.onrender.com`), click **Generate token**, then **Save & connect**. The status should turn green.
4. Keep a `music.youtube.com` tab open.

### 3. Open the phone page
Visit your relay URL on your phone, paste the same token, and tap Connect. Use "Add to Home screen" to install it.

## Security notes
- The token is the only credential. Treat it like a password and use at least 20 random characters. Use HTTPS only.
- Anyone with the token can control playback and see the current track title. Nothing else is exposed.
- The server rejects unknown commands, clamps values, rate-limits commands, and caps message size.
- The extension only requests access to `music.youtube.com` plus `storage`, `tabs` (to find the YT Music tab) and `alarms` (reconnect).

## Work computers
Check your workplace's IT policy before installing extensions or sending traffic to an external server. This project does not try to hide itself from IT or monitoring tools.

## Searching and picking songs
Type in the search box on the phone page and tap a result to play it. Tap the ⏭ button on a result to play it next; queued songs show in an "Up next" list with ✕ to remove. The search runs inside the YT Music tab on the PC using your own signed-in session there, so it respects your region and account. Both the extension (v1.4.0 or newer) and the relay need updating for this to work.

## Updating
1. The relay redeploys itself when you push to GitHub (Render). Update it first.
2. Replace the `extension` folder with the new one and press the reload icon on the extension in `chrome://extensions`. It loads itself into any open YouTube Music tab, so you normally do not need to reload the tab. If something still does not respond, reload the tab once.
3. The phone page updates the next time you open it.

## If something goes wrong
- **"PC offline" on the phone:** Chrome must be running on the PC with the extension enabled, and both sides must use the same token. The extension's settings page shows its connection status.
- **"Another computer connected with this token":** two computers cannot share a token. Click Save & connect on the one you want to use, and give the other one its own token.
- **"YouTube Music is not open on the PC":** open `music.youtube.com` in Chrome.
- **Relay on a free plan:** it sleeps after about 15 minutes idle, so the first connection can take up to a minute. Both sides reconnect on their own.

## Known limitations
- Needs Chrome 116 or newer on the PC.
- YT Music's page structure changes occasionally. If a button stops working, the selectors in `extension/content.js` may need updating.
- Search and tap-to-play rely on YT Music internals (its search API and page router), which Google can change without notice.
- "Play next" first tries YT Music's own queue (it sends the same command as the site's menu and checks that the queue grew). If that does not work, the song goes into a fallback "Up next" list kept by this extension; that list does not appear in YT Music's own queue, is cleared if the tab is reloaded, and plays when the current song ends or when you press next on the phone. The phone's status line says which one was used.
- Chrome may suspend the extension's service worker. It reconnects automatically within about a minute.
- Run tests with `cd server && npm test`.

## License
MIT
