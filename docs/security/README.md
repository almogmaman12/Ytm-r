# Security and trust model

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

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
A token alone can be stolen (a screenshot, a shared link). Set two codes as **environment variables** on your host (on Render: your service → **Environment**). The codes are not sent directly over the wire: connecting clients prove knowledge of the corresponding code using a one-time HMAC-SHA256 challenge. Use HTTPS and random, strong codes.
- `ACCESS_CODE`: required by phones. The phone page asks for it once and remembers it.
- `PC_CODE`: required by the PC extension (Options → "PC code"; reload the extension once after updating). Without it nobody who has your token can take the PC's place on the relay.
- Use at least 10 random characters without spaces. Calendar requires both codes to be at least 8 characters.
- After 5 wrong codes from one address in 10 minutes, that address is blocked for 15 minutes.
- **Lost phone or leaked credentials:** change `ACCESS_CODE` and redeploy to invalidate the old phone access code. Paired-device keys authenticate independently, so also remove or pause any lost/untrusted paired devices from the owner phone. If the token itself leaks, rotate it on the relay clients and PC. Changing the owner access code alone does not revoke existing paired keys.
- The relay log shows `refused` lines with the device and address for every failed attempt.

## Other security notes
- Without access codes the token is the only credential for the phone side (see access codes above). Use 20+ random characters and HTTPS. Anyone with it can control playback and see the current track title.
- The relay accepts only a fixed list of commands, clamps values, rate-limits and caps message sizes. Its CORS headers are open only under `/ota/` (public code, no secrets).
- The extension asks for access to `music.youtube.com`, plus `storage`, `alarms`, `userScripts` and the declared `debugger` permission for opt-in sound activation. Access to `www.youtube.com` and `calendar.google.com` is optional and requires the corresponding setting and Chrome permission prompt. Token and relay address are kept on this PC (`storage.local`), not synced.

## Work computers
Check your workplace's IT policy before installing extensions or sending traffic to an external server. This project does not try to hide itself from IT or monitoring tools.

## Windows companion

Native status and actions are owner-only and require a locally enabled, authenticated connection. Extension installation requires trusted signed metadata and archive hashes, an exact reviewed archive for phone approval and compatible manifest changes. Companion self-update uses the fixed App Installer channel, Windows package verification and a separate local opt-in. Neither feature accepts a shell command, arbitrary executable or download URL. Keep signing secrets separate from relay credentials. See [release signing](../../companion/release/README.md).
