// Integration test: fake PC + fake phone against the relay.
const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('./server');

const TOKEN = 'abcdefghijklmnopqrstuvwx_1234';
const WRONG = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function open(role, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?role=${role}&token=${token}`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let port;

(async () => {
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;

  // Short token rejected
  await assert.rejects(open('pc', 'short'));

  const pc = await open('pc', TOKEN);
  const phone = await open('phone', TOKEN);
  const other = await open('phone', WRONG);
  await wait(100);

  assert(phone.msgs.some((m) => m.type === 'pc_status' && m.online), 'phone sees pc online');
  assert(pc.msgs.some((m) => m.cmd === 'get_state'), 'pc asked for state when phone joined');

  // Valid command is forwarded
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'next' }));
  await wait(100);
  assert(pc.msgs.some((m) => m.cmd === 'next'), 'next forwarded');

  // Volume clamped
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'volume', value: 500 }));
  await wait(100);
  assert.strictEqual(pc.msgs.find((m) => m.cmd === 'volume').value, 100, 'volume clamped');

  // Non-whitelisted command dropped
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'eval', value: 'alert(1)' }));
  await wait(100);
  assert(!pc.msgs.some((m) => m.cmd === 'eval'), 'unknown command dropped');

  // State relayed to the right phone only
  pc.send(JSON.stringify({ type: 'state', state: { title: 'Song', artist: 'Band', playing: true } }));
  await wait(100);
  assert(phone.msgs.some((m) => m.type === 'state' && m.state.title === 'Song'), 'state reached phone');
  assert(!other.msgs.some((m) => m.type === 'state'), 'other room isolated');

  // Phone cannot spoof state, pc cannot send commands to itself
  phone.send(JSON.stringify({ type: 'state', state: { title: 'FAKE' } }));
  await wait(100);
  assert(!phone.msgs.some((m) => m.state && m.state.title === 'FAKE'), 'phone cannot spoof state');

  // Search: query trimmed and forwarded; empty query dropped
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'search', value: '  daft punk  ' }));
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'search', value: '   ' }));
  await wait(100);
  const searches = pc.msgs.filter((m) => m.cmd === 'search');
  assert.strictEqual(searches.length, 1, 'only the non-empty search forwarded');
  assert.strictEqual(searches[0].value, 'daft punk', 'query trimmed');

  // play_video: only valid 11-char ids pass
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'play_video', value: '../../etc' }));
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'play_video', value: 'dQw4w9WgXcQ' }));
  await wait(100);
  const plays = pc.msgs.filter((m) => m.cmd === 'play_video');
  assert.strictEqual(plays.length, 1, 'invalid video id dropped');
  assert.strictEqual(plays[0].value, 'dQw4w9WgXcQ');

  // Results: sanitised and delivered only to the paired phone
  pc.send(JSON.stringify({
    type: 'results', query: 'daft punk',
    results: [
      { videoId: 'dQw4w9WgXcQ', title: 'Good', subtitle: 'Artist', thumb: 'http://insecure/x.jpg' },
      { videoId: 'bad', title: 'Bad id' },
    ],
  }));
  await wait(100);
  const res = phone.msgs.find((m) => m.type === 'results');
  assert(res, 'results reached phone');
  assert.strictEqual(res.results.length, 1, 'invalid result dropped');
  assert.strictEqual(res.results[0].thumb, '', 'non-https thumbnail removed');
  assert(!other.msgs.some((m) => m.type === 'results'), 'results isolated to room');

  // Phone cannot inject results
  phone.send(JSON.stringify({ type: 'results', results: [{ videoId: 'dQw4w9WgXcQ', title: 'X' }] }));
  await wait(100);
  assert.strictEqual(phone.msgs.filter((m) => m.type === 'results').length, 1, 'phone cannot spoof results');

  // Let the per-second command window reset so the next group isn't rate limited
  await wait(1100);

  // Up next: valid ids forwarded, invalid dropped
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'play_next', value: 'dQw4w9WgXcQ' }));
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'play_next', value: 'nope' }));
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'queue_remove', value: 'dQw4w9WgXcQ' }));
  phone.send(JSON.stringify({ type: 'cmd', cmd: 'queue_remove', value: '<script>' }));
  await wait(100);
  assert.strictEqual(pc.msgs.filter((m) => m.cmd === 'play_next').length, 1, 'only valid play_next forwarded');
  assert.strictEqual(pc.msgs.filter((m) => m.cmd === 'queue_remove').length, 1, 'only valid queue_remove forwarded');

  // Queue updates are sanitised and reach only the paired phone
  pc.send(JSON.stringify({
    type: 'queue',
    items: [
      { videoId: 'dQw4w9WgXcQ', title: 'Queued', subtitle: 'Artist', thumb: 'https://i.ytimg.com/x.jpg' },
      { videoId: 'bad', title: 'Nope' },
    ],
  }));
  await wait(100);
  const q = phone.msgs.find((m) => m.type === 'queue');
  assert(q, 'queue reached phone');
  assert.strictEqual(q.items.length, 1, 'invalid queue item dropped');
  assert.strictEqual(q.items[0].thumb, 'https://i.ytimg.com/x.jpg', 'https thumbnail kept');
  assert(!other.msgs.some((m) => m.type === 'queue'), 'queue isolated to room');
  phone.send(JSON.stringify({ type: 'queue', items: [{ videoId: 'dQw4w9WgXcQ', title: 'FAKE' }] }));
  await wait(100);
  assert.strictEqual(phone.msgs.filter((m) => m.type === 'queue').length, 1, 'phone cannot spoof queue');

  // Status messages relay from PC to phone, but not phone to phone
  pc.send(JSON.stringify({ type: 'status', message: 'Playing (via test)' }));
  await wait(100);
  assert(phone.msgs.some((m) => m.type === 'status' && m.message === 'Playing (via test)'), 'status reached phone');
  assert(!other.msgs.some((m) => m.type === 'status'), 'status isolated to room');
  phone.send(JSON.stringify({ type: 'status', message: 'FAKE' }));
  await wait(100);
  assert(!phone.msgs.some((m) => m.message === 'FAKE'), 'phone cannot spoof status');

  // Rate limit
  const before = pc.msgs.filter((m) => m.cmd === 'toggle').length;
  for (let i = 0; i < 30; i++) phone.send(JSON.stringify({ type: 'cmd', cmd: 'toggle' }));
  await wait(200);
  const got = pc.msgs.filter((m) => m.cmd === 'toggle').length - before;
  assert(got <= 10, `rate limited (got ${got})`);

  // Path traversal blocked
  const trav = await fetch(`http://localhost:${port}/..%2f..%2fserver.js`);
  assert.notStrictEqual(trav.status, 200, 'path traversal blocked');
  assert.strictEqual((await fetch(`http://localhost:${port}/`)).status, 200, 'index served');

  // ---- Robustness ----
  const http = require('http');
  const rawGet = (p, method = 'GET') => new Promise((resolve, reject) => {
    const r = http.request({ port, path: p, method }, (res) => {
      let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject); r.end();
  });

  // Malformed percent-encoding used to throw inside the request handler and kill the server
  assert.strictEqual((await rawGet('/%E0%A4%A')).status, 400, 'malformed URL answered, not crashed');
  assert.strictEqual((await rawGet('/healthz')).body, 'ok', 'server still alive after malformed URL');

  // ---- OTA: what the extension downloads ----
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const man = await rawGet('/ota/manifest.json');
  assert.strictEqual(man.status, 200, 'manifest served');
  assert.strictEqual(man.headers['access-control-allow-origin'], '*', 'manifest readable by the extension');
  const m = JSON.parse(man.body);
  assert.ok(/^[0-9a-f]{12}$/.test(m.version), 'version is 12 hex');
  assert.strictEqual(m.requiresShell, 1);
  assert.deepStrictEqual(m.files.map((f) => f.name).sort(), ['content.js', 'page.js']);
  for (const f of m.files) {
    assert.ok(['MAIN', 'USER_SCRIPT'].includes(f.world), 'world valid');
    const r = await rawGet('/ota/' + f.name);
    assert.strictEqual(r.status, 200, f.name + ' served');
    assert.strictEqual(r.headers['access-control-allow-origin'], '*', f.name + ' has CORS');
    assert.strictEqual(crypto.createHash('sha256').update(r.body).digest('hex'), f.sha256, f.name + ' hash matches what was served');
    assert.ok(r.body.startsWith('// ytmr-payload'), f.name + ' carries the payload marker');
  }
  assert.ok(!('access-control-allow-origin' in (await rawGet('/healthz')).headers), 'CORS only under /ota/');
  assert.ok(!('access-control-allow-origin' in (await rawGet('/')).headers), 'phone page has no CORS');
  assert.notStrictEqual((await rawGet('/ota/..%2fserver.js')).status, 200, 'no path traversal out of ota/');
  assert.notStrictEqual((await rawGet('/ota/%2e%2e/server.js')).status, 200, 'no path traversal (dots)');
  // Changing a payload file changes the version (that is how updates are noticed)
  const pf = path.join(__dirname, 'public', 'ota', 'content.js');
  const orig = fs.readFileSync(pf);
  try {
    fs.writeFileSync(pf, Buffer.concat([orig, Buffer.from('\n// tweak\n')]));
    await wait(2200); // manifest is memoised for 2s
    const m2 = JSON.parse((await rawGet('/ota/manifest.json')).body);
    assert.notStrictEqual(m2.version, m.version, 'version changes when a file changes');
  } finally { fs.writeFileSync(pf, orig); }
  assert.strictEqual((await rawGet('/', 'POST')).status, 405, 'POST rejected');
  const head = await rawGet('/', 'HEAD');
  assert.strictEqual(head.status, 200, 'HEAD works');
  assert.strictEqual(head.body, '', 'HEAD has no body');
  const home = await rawGet('/');
  assert(home.headers['content-security-policy'], 'CSP header set');
  assert.strictEqual(home.headers['x-frame-options'], 'DENY', 'framing denied');
  assert.strictEqual((await rawGet('/..%2f..%2fpackage.json')).status, 403, 'encoded traversal blocked');
  assert.strictEqual((await rawGet('/nope.txt')).status, 404, 'missing file 404');

  // Ping gets a pong, from both roles
  phone.send(JSON.stringify({ type: 'ping' }));
  pc.send(JSON.stringify({ type: 'ping' }));
  await wait(100);
  assert(phone.msgs.some((m) => m.type === 'pong'), 'phone gets pong');
  assert(pc.msgs.some((m) => m.type === 'pong'), 'pc gets pong');

  // Non-https and junk image URLs are removed
  pc.send(JSON.stringify({ type: 'state', state: { title: 'T', art: 'javascript:alert(1)' } }));
  await wait(100);
  const lastState = phone.msgs.filter((m) => m.type === 'state').pop();
  assert.strictEqual(lastState.state.art, '', 'javascript: art removed');

  // The site's own queue is forwarded, cleaned, and replayed to a phone that joins later
  const yqTok = 'ytqueueytqueueytqueue_1';
  const yqPc = await open('pc', yqTok);
  yqPc.send(JSON.stringify({ type: 'ytqueue', items: [
    { videoId: 'AAAAAAAAAA1', title: 'One', subtitle: 'Band', thumb: 'javascript:alert(1)' },
    { videoId: 'bad id', title: 'Nope' } ] }));
  await wait(100);
  const yqPhone = await open('phone', yqTok);
  await wait(150);
  const yq = yqPhone.msgs.find((m) => m.type === 'ytqueue');
  assert.ok(yq, 'late phone gets the cached site queue');
  assert.strictEqual(yq.items.length, 1, 'invalid ids dropped');
  assert.strictEqual(yq.items[0].thumb, '', 'unsafe thumbnail removed');
  yqPc.close(); yqPhone.close();

  // Jump/remove commands carry "position:videoId" and nothing else
  const jmTok = 'jumpjumpjumpjumpjump_1234';
  const jmPc = await open('pc', jmTok);
  const jmPhone = await open('phone', jmTok);
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_jump', value: '3:AAAAAAAAAA1' }));
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_remove', value: '0:BBBBBBBBBB2' }));
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_jump', value: '3;rm -rf' }));
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_remove', value: 'BBBBBBBBBB2' }));
  await wait(200);
  const jm = jmPc.msgs.filter((m) => m.type === 'cmd' && m.cmd !== 'get_state');
  assert.deepStrictEqual(jm.map((m) => m.cmd + ' ' + m.value), ['yt_jump 3:AAAAAAAAAA1', 'yt_remove 0:BBBBBBBBBB2'], 'only well-formed queue commands pass');
  jmPc.close(); jmPhone.close();

  // An oversized message used to crash the whole relay (unhandled socket error)
  const big = await open('phone', 'bigbigbigbigbigbigbigbig_1');
  const closed = new Promise((r) => big.on('close', r));
  big.send('x'.repeat(100 * 1024));
  await closed;
  assert.strictEqual((await rawGet('/healthz')).body, 'ok', 'server survived oversized message');

  // A second PC with the same token replaces the first one (close code 4000)
  const pcA = await open('pc', 'replaceme_replaceme_1234');
  const closeCode = new Promise((r) => pcA.on('close', (c) => r(c)));
  const pcB = await open('pc', 'replaceme_replaceme_1234');
  assert.strictEqual(await closeCode, 4000, 'old PC told it was replaced');
  pcB.close();

  // Phones per token are capped
  const tok = 'capcapcapcapcapcapcap_99';
  const phones = [];
  for (let i = 0; i < 10; i++) phones.push(await open('phone', tok));
  const eleventh = await open('phone', tok);
  const code11 = await new Promise((r) => eleventh.on('close', (c) => r(c)));
  assert.strictEqual(code11, 4001, '11th phone refused');
  phones.forEach((p) => p.close());

  console.log('All relay tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
