# Relay server setup

[Project home](../README.md) · [Troubleshooting](../docs/troubleshooting/README.md)

The relay serves the phone app and OTA payloads and forwards authenticated messages. It does not replace YouTube Music: the signed-in PC browser performs playback.

## Deploy to Render

1. Fork the repo and create a Render Web Service connected to your fork.
2. Choose your intended branch. Use the OTA branch for ordinary playback, or the Windows companion branch for the Windows companion deployment. Native controls use the HTTPS relay configured on the PC.
3. Set Root Directory to `server`, Build Command to `npm install`, Start Command to `npm start`. Enable auto-deploy if desired.
4. Set environment variables below before connecting any client. Open the resulting HTTPS URL; use that same origin on the phone and Chrome.

| Variable | Purpose |
|---|---|
| `ACCESS_CODE` | Owner phone authentication |
| `PC_CODE` | PC extension/native authentication |
| `DATABASE_URL` | Optional Neon connection string |
| `DEVICES_FILE` | Optional persistent device file without Neon |
| `CALENDAR_CACHE_FILE` | Optional persistent calendar file without Neon |
| `VAPID_PRIVATE_JWK` | Optional stable Web Push identity |
| `LOG_COMMANDS`, `LOG_ALL` | Optional command logging controls |

Use distinct random codes (at least 10 characters, no spaces). Both must be at least eight characters for calendar and native features. Never commit credentials. Free hosting may sleep and lose local files; use [Neon](../docs/neon/README.md) if needed.

## Local development

```sh
cd server
npm install
npm start
```

Open http://localhost:3000 on the same computer. For remote phone and signed-in browser use, prefer a trusted HTTPS relay. Run `npm test` from this folder for integration and calendar tests.

## Verify

Open the relay URL, confirm the phone page loads, check `/healthz`, and review host logs. Then connect the [extension](../extension/README.md) and [phone](../docs/phone/README.md). A free host may need time to wake. Deploying a different branch can change which UI features are available.

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
