# Neon PostgreSQL setup

[Project home](../../README.md) · [Troubleshooting](../../docs/troubleshooting/README.md)

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

For setup of the relay itself, see [server](../../server/README.md). For usage and diagnostic metrics, see [System Center](../system-center/README.md).

The companion encrypted preferences backup adds `ytmr_companion_backup_v1` automatically at relay startup. Existing DATABASE_URL is sufficient. One encrypted envelope per room is stored; backup requests are authenticated with timestamped, replay-limited HMAC using PC_CODE and room token. The recovery password and plaintext preferences never reach the relay. Automatic backups, if explicitly enabled, write only when settings change and before phone-requested companion updates; there are no periodic database reads. See [companion guide](../../companion/README.md).
