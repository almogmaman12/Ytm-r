'use strict';

// Neon SQL-over-HTTPS. No connection is held open while the relay is idle.
// Use a private DATABASE_URL environment variable; never log it or a DB response.
function neonQuery(connectionString, fetchImpl = globalThis.fetch) {
  let parsed;
  try { parsed = new URL(connectionString); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol) ||
      !/^[a-z0-9.-]+\.neon\.tech$/i.test(parsed.hostname) ||
      !parsed.username || !parsed.password || parsed.pathname.length < 2 ||
      (parsed.port && parsed.port !== '5432')) throw new Error('DATABASE_URL must be a Neon Postgres connection string');
  const endpoint = 'https://' + parsed.hostname + '/sql';
  // HTTP transport already uses TLS. Direct Postgres negotiation options are
  // not needed by the Neon HTTP proxy (including channel_binding).
  parsed.search = '';
  parsed.hash = '';
  const auth = parsed.toString();
  return async (query, params = []) => {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': auth,
          'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'false' },
        body: JSON.stringify({ query, params }),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data.rows)) throw new Error('Invalid result');
      return data.rows;
    } catch {
      throw new Error('Neon database request failed');
    }
  };
}
const validDevice = d => !!d && /^[0-9a-f]{16}$/.test(d.id) &&
  /^[0-9a-f]{64}$/.test(d.hash) && typeof d.token === 'string' &&
  /^[A-Za-z0-9_-]{20,200}$/.test(d.token) && Number.isFinite(d.created) && Number.isFinite(d.lastSeen);
const cleanDevices = rows => (Array.isArray(rows) ? rows : []).filter(validDevice);
function createDeviceStore(query) {
  async function init(existing = []) {
    await query('CREATE TABLE IF NOT EXISTS ytmr_devices_v1 (id text PRIMARY KEY, data jsonb NOT NULL)');
    await query('CREATE TABLE IF NOT EXISTS ytmr_migrations_v1 (name text PRIMARY KEY)');
    // Import the old file once, transactionally. A later restart cannot bring
    // back a revoked device from an old disk file.
    await query(`WITH migration AS (
      INSERT INTO ytmr_migrations_v1 (name) VALUES ('paired-devices-file-v1')
      ON CONFLICT DO NOTHING RETURNING name
    ) INSERT INTO ytmr_devices_v1 (id,data)
      SELECT item->>'id',item FROM jsonb_array_elements($1::jsonb) AS t(item)
      WHERE EXISTS (SELECT 1 FROM migration) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(cleanDevices(existing))]);
    const rows = await query('SELECT data::text AS data FROM ytmr_devices_v1');
    return cleanDevices(rows.map(row => JSON.parse(row.data)));
  }
  async function insert(device) {
    if (!validDevice(device)) throw new Error('Invalid device');
    await query('INSERT INTO ytmr_devices_v1 (id,data) VALUES ($1,$2::jsonb)', [device.id, JSON.stringify(device)]);
  }
  async function remove(id) {
    await query('DELETE FROM ytmr_devices_v1 WHERE id=$1', [id]);
  }
  async function rename(id, name, lastSeen) {
    // Update only existing rows. A delayed rename never resurrects a revoked key.
    await query("UPDATE ytmr_devices_v1 SET data=data || jsonb_build_object('name',$2::text,'lastSeen',$3::bigint) WHERE id=$1",
      [id, name, String(lastSeen)]);
  }
  async function setAccess(id, field, enabled) {
    if (!['paused','calendar'].includes(field) || typeof enabled !== 'boolean') throw new Error('Invalid device permission');
    await query('UPDATE ytmr_devices_v1 SET data=data || jsonb_build_object($2::text,$3::boolean) WHERE id=$1',
      [id, field, String(enabled)]);
  }
  return { init, insert, remove, rename, setAccess };
}
module.exports = { neonQuery, createDeviceStore, validDevice, cleanDevices };
