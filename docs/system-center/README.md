# System Center and diagnostics

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

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

The dedicated PC page is documented in [Windows companion](../../companion/README.md). Raw host logs are documented in [server setup](../../server/README.md).
