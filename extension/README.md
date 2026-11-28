# Chrome extension setup

[Project home](../README.md) · [Troubleshooting](../docs/troubleshooting/README.md)

## Installation

Use Chrome 135 or newer. Download or clone the same trusted source branch as your relay. The Windows companion branch currently contains shell 2.4.6; the OTA branch can have a different version.

1. Extract or clone the repo to a permanent local folder, not a temporary Downloads archive.
2. Visit `chrome://extensions`, enable Developer mode and choose Load unpacked. Select the `extension/` folder (the one containing manifest.json).
3. Open Details and enable Allow User Scripts (Chrome 138+; older versions use Developer mode).
4. Open Extension options for **Tab Helper**, create a local settings password, enter your HTTPS relay address and PC code, generate a token and Save & connect.
5. Open music.youtube.com on the PC. Confirm the tab and relay are connected; enter the same token on the phone.

Do not uninstall an existing extension merely to update it. Keep its exact unpacked folder path and use Chrome's Reload action if needed. The local settings password is separate from relay codes and the companion password; it cannot be recovered by the app.

## Optional settings

| Setting | Why enable it |
|---|---|
| Wake YouTube Music | Helper can open, wake or switch tabs while Chrome is running |
| Regular YouTube | Control www.youtube.com; optional site access |
| Calendar | Read events displayed in open Google Calendar tabs; optional site access |
| Let my phone start sound | Opt-in sound activation using the declared debugger permission |
| Remote tabs | Owner can list, switch and close ordinary non-incognito HTTP(S) tabs; optional tabs permission and configured trusted HTTPS relay |
| Startup shell reload | Attempt one reload if the installed manifest is newer than the running worker; intended for companion users |

Grant only permissions you intend to use. Chrome may still ask for permission confirmation after updates.

## Sound in a tab you haven't clicked
Chrome keeps a tab silent until it has had a real click or key press, so a YouTube or YouTube Music tab opened from the phone used to stay silent until you clicked it on the PC. A script cannot fake that click (Chrome ignores those), so the extension sends a real one. In the extension settings turn on **Let my phone start sound** (extension version 2.4.1; reload it once in `chrome://extensions` and approve the required debugging permission if prompted). Chrome does not support optional debugger permission requests, so the permission is declared in the manifest. The feature remains off until you turn on the setting; switching it off stops the feature but does not revoke the manifest permission. From then on, when a tab connects to your phone and has had no click yet, the extension sends one real click to a blank spot of the page, never on a button, link or the player, and starts playing if you had just asked for it. Chrome shows its "started debugging this browser" bar for a fraction of a second. It happens at most once per 30 seconds per tab, only on music.youtube.com and www.youtube.com, and only when asked by the extension's own page script. If DevTools is open on that tab Chrome refuses and nothing happens. Without the setting nothing changes. The phone also has a **Tap PC / unlock sound** button below the volume slider while the PC tab is connected. It requests the same safe-spot activation manually, respects the existing extension setting and 30-second debugger cooldown, and reports whether the tap could be sent. Alternatives that need no extension permission: start Chrome with `--autoplay-policy=no-user-gesture-required`, or allow the two sites with Chrome's `AutoplayAllowlist` policy.

## Experimental extension startup activation

The companion branch has an startup reload introduced in shell 2.4.4 with a loaded worker build identifier
and an opt-in startup reload setting in the password-protected extension options.
Chrome's supported runtime.reload() is called only when the owner has enabled the setting
and Chrome reports a newer manifest version than the running worker. The extension stores
one attempted reload per target version to avoid reload loops. It does not force Chrome to
close, change Chrome settings, grant permissions or accept remote reload commands.
The options page also shows the loaded shell build/API and has a manual Reload extension now button.

This feature requires an initial installation/reload of the experimental shell and explicit
opt-in. Increment both manifest.version and SHELL_BUILD on every subsequent shell release.
If Chrome caches both the manifest and the worker, or the reload attempt fails, use Chrome's
normal extension reload UI. Actual startup behavior must be tested in Chrome.
The release workflow has narrow exceptions for the reviewed 2.4.4 and 2.4.5 source commits. The release is requested separately, and is not triggered by ordinary commits. The companion can download it without a new Windows build. Keep the original extension folder path and do not uninstall the extension. Once loaded, opt in via the extension settings. Actual Chrome activation still requires testing; a manual reload may remain necessary.

See [updates](../docs/updates/README.md), [calendar](../docs/calendar/README.md) and [security](../docs/security/README.md).

For remote tabs on a custom relay, save its HTTPS address and room token first, then enable Remote tabs and approve Chrome's permission. After upgrading from 2.4.5 or changing relay/token, re-enable the opt-in. The feature does not work over plain HTTP.

## Advanced browser tools (2.4.7+)

Enable remote tabs, then opt into Advanced browser tools locally in extension settings. Chrome requests optional sessions and management permissions. The owner phone can mute/unmute ordinary tabs, open an HTTP(S) URL in a regular window, list and restore recently closed individual non-private web tabs, and view installed extension names, versions and enabled status. No remote extension enable/disable/install/uninstall, private tabs, browser-internal URLs or URL credentials are supported. The opt-in is bound to the saved HTTPS relay and room; changing either revokes it. Recent session information depends on what Chrome exposes; no browser history database is uploaded.
