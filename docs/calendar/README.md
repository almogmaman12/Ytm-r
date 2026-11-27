# Google Calendar and push reminders

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

## Quick setup

1. Set strong ACCESS_CODE and PC_CODE on the relay and connect the owner phone.
2. Enable Calendar in the extension options and accept Chrome's optional site access.
3. Open any Google Calendar tab on the PC and display the dates you want to sync.
4. Open Calendar on your phone. To receive reminders, enable notifications there and grant browser permission.
5. Configure [Neon](../neon/README.md) to preserve cached events and push subscriptions across relay restarts.

## Optional Google Calendar website grabber and push reminders

No Calendar API, OAuth or credentials. Enable Calendar access under extension Options → Advanced and approve Chrome's optional site permission. Any open Google Calendar tab can sync automatically, including Agenda and Week. Keep the Calendar display timezone equal to the PC timezone. Hebrew and English time ranges are supported when the displayed date and time are readable. Only rendered events are fetched; browse additional dates to cache them. Google markup changes may need OTA fixes.

The phone Calendar button requires strong existing `ACCESS_CODE` and `PC_CODE` (both at least 8 characters). The owner can grant paired phones read-only calendar access individually. The PC helper uploads up to 80 events. The relay serves snapshots from RAM and persists them to Neon when `DATABASE_URL` is configured, or to a private JSON file otherwise (14-day retention, hashed room keys, no event titles logged). Older, offline and unconfirmed empty snapshots cannot overwrite good cached data. Disabling Calendar clears the server snapshot.

With `DATABASE_URL`, the relay creates its calendar tables automatically, restores snapshots before accepting connections, writes changed events immediately, refreshes unchanged timestamps at most hourly, and retries failed writes. Existing PC snapshots repopulate an initially empty database after reconnecting. No PC extension reload is needed. Without Neon, set `CALENDAR_CACHE_FILE` to a persistent disk path; Render's free filesystem may lose the cache. The database contains private event titles and times, so keep its connection string private.

Enable notifications on the phone for generic reminders 10 minutes before readable timed events. Cached events remain visible after tab closure; reminders still require a live, fresh snapshot so cancelled events are less likely to trigger alerts.

With Neon, push subscription endpoints, recent successful reminder markers and the VAPID private key are saved in the database. Existing `VAPID_PRIVATE_JWK` takes precedence; otherwise a persistent key is created automatically. Never expose either secret. Open the owner phone once after the first deploy so its existing subscription can register again (a mismatched key is renewed if permission is granted). Reminders remain owner-only and require fresh live calendar data and an awake relay; persistence does not turn cached events into guaranteed offline notifications. Without Neon, set `VAPID_PRIVATE_JWK` from `node server/calendar-push.js` for stable keys; subscriptions then last only for the running process. Android Chrome is the primary target; iOS requires an installed web app.

The calendar grabber and end-time support were introduced with extension shell 2.4.3; newer compatible shells include them. If you already have that shell installed, the newer server-side cache, sharing and diagnostics features require no extension reload. Event end times are preserved where the site shows a readable range; no duration is guessed. Subsequent changes to `server/public/ota/calendar.js`, the phone interface and relay are OTA. The calendar payload is isolated from music scripts and only registered on the explicitly permitted Calendar origin.
