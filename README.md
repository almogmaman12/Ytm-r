# YTM Remote

Self-hosted remote for YouTube Music, YouTube and Windows. Use a phone web app to control music, browse your library, see Google Calendar events and manage your PC. No Google sign-in is needed on the phone.

**This branch: `feature/windows-companion`** · Chrome shell 2.4.5 in source · Node.js 18+ · optional Neon PostgreSQL

## Choose your setup

| What you want | Branch / setup |
|---|---|
| Basic manually updated extension | [main](https://github.com/almogmaman12/Ytm-r/tree/main) |
| Self-hosted remote with OTA updates | [feature/ota-remote-loader](https://github.com/almogmaman12/Ytm-r/tree/feature/ota-remote-loader) |
| Windows companion, PC controls and signed remote updates | [feature/windows-companion](https://github.com/almogmaman12/Ytm-r/tree/feature/windows-companion) (this branch; experimental native features) |

The ordinary playback relay and extension can be self-hosted. The experimental Windows connection and remote Chrome tab controls are currently pinned in source to `https://ytm-r.onrender.com`. A fork on another relay can use ordinary playback but cannot use those native features unchanged. Do not connect a personal PC to a relay you do not control.

## Quick start

1. Fork the repository and deploy the chosen branch's `server/` directory to your HTTPS WebSocket host. Set strong, separate `ACCESS_CODE` and `PC_CODE`. Follow [relay setup](server/README.md).
2. Load the `extension/` folder in Chrome developer mode. Enable Allow User Scripts, set your local settings password, enter your relay and PC code, generate a room token and save. Follow [extension setup](extension/README.md).
3. Open YouTube Music on the PC. Open your relay on the phone and connect with the same token and phone access code. Install the web app if desired. Follow [phone setup](docs/phone/README.md).
4. Optionally configure [Neon](docs/neon/README.md), [calendar and notifications](docs/calendar/README.md) and the [Windows companion](companion/README.md). Download the [public publisher certificate](https://github.com/almogmaman12/Ytm-r/releases/download/companion-channel/publisher.cer) into Downloads. First-time MSIX installation requires [trusting the verified publisher certificate](companion/README.md#1-install-the-signed-windows-package) on the PC.

```
Phone web app <---- HTTPS / WSS ----> Node relay <---- WSS ----> Chrome extension
                                          |
                                          +---- WSS ----> Windows companion (optional)
                                          |
                                          +---- HTTPS --> Neon database (optional)
```

## Documentation

| Guide | What it explains |
|---|---|
| [Relay server](server/README.md) | Render deployment, environment variables, local testing |
| [Chrome extension](extension/README.md) | Installation, permissions, settings, startup reload |
| [Phone web app](docs/phone/README.md) | Connection, playback, pairing and guest phones |
| [Windows companion](companion/README.md) | Signed MSIX installation, configuration, PC controls |
| [Update manager](docs/updates/README.md) | OTA vs extension vs companion updates, remote approvals, recovery |
| [Google Calendar & push](docs/calendar/README.md) | Calendar permissions, caching, reminders |
| [Neon database](docs/neon/README.md) | Persistence, retention and verification |
| [System Center](docs/system-center/README.md) | Diagnostics, telemetry and phone app updates |
| [Release maintainer](companion/release/README.md) | Signing keys, CI, MSIX and extension publishing |
| [Security](docs/security/README.md) | Trust model, credentials, repository protection |
| [Troubleshooting](docs/troubleshooting/README.md) | Connection, permissions, Chrome, updates and builds |

## What you can control

- Music: playback, queue, search, library, playlists, radio, volume boost and sleep timer.
- Phone: installable PWA, appearance, paired phones, diagnostics and notifications.
- Calendar: optional read-only website sync, cached events and live-data reminders.
- Windows: uptime, memory, power, master volume, mute, output device, media controls, Chrome launch/close and ordinary tab management with explicit permissions.
- Updates: review signed extension updates and request a companion MSIX update from the owner phone. The two update managers are independent.

## How updates differ

| Change | How it reaches your devices |
|---|---|
| Relay, web app or OTA payload | Deploy the server branch; phone/extension fetch the new code |
| Chrome extension shell | Reload the unpacked extension, or use the signed extension updater |
| Windows companion | Signed MSIX through the separate App Installer channel |

See the [update guide](docs/updates/README.md) for what can update while Chrome is open and what requires a restart. Source changes are not proof of a published package; check [GitHub Actions](https://github.com/almogmaman12/Ytm-r/actions) and the [companion channel](https://github.com/almogmaman12/Ytm-r/releases/tag/companion-channel).

## Security

Use your own trusted relay, strong access codes, protected GitHub and hosting accounts, and reviewed signed releases. OTA code runs on signed-in browser pages; its hashes do not protect against a compromised relay. Remote PC controls are owner-only and require local opt-in. Read [security](docs/security/README.md) before deployment.

## Repository layout

- `server/`: relay, phone PWA and OTA payloads (`public/ota/`).
- `extension/`: unpacked Chrome MV3 shell.
- `companion/`: Windows tray application and updater.
- `companion/release/`: release requests and signing/packaging scripts.
- `.github/workflows/`: build, test and signed release automation.

Run server tests with `cd server && npm install && npm test`. Windows build instructions are in the companion guide.

## License

MIT
