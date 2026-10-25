// Integration test: fake PC + fake phone against the relay.
const assert = require('assert');
const WebSocket = require('ws');
// The relay's log lines are collected (and checked) instead of flooding the test output.
const logLines = [];
const realLog = console.log;
console.log = (...a) => { logLines.push(a.join(' ')); };
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
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_reorder', value: '2:CCCCCCCCCC3:0' }));
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_reorder', value: '2:CCCCCCCCCC3:x' }));
  jmPhone.send(JSON.stringify({ type: 'cmd', cmd: 'yt_reorder', value: '2:CCCCCCCCCC3' }));
  await wait(200);
  const jm = jmPc.msgs.filter((m) => m.type === 'cmd' && m.cmd !== 'get_state');
  assert.deepStrictEqual(jm.map((m) => m.cmd + ' ' + m.value), ['yt_jump 3:AAAAAAAAAA1', 'yt_remove 0:BBBBBBBBBB2', 'yt_reorder 2:CCCCCCCCCC3:0'], 'only well-formed queue commands pass');
  jmPc.close(); jmPhone.close();

  // Albums, playlists, artists, library: only well-formed ids pass
  const kTok = 'kindskindskindskindskind_12';
  const kPc = await open('pc', kTok);
  const kPhone = await open('phone', kTok);
  const sendCmd = (cmd, value) => kPhone.send(JSON.stringify({ type: 'cmd', cmd, value }));
  sendCmd('play_collection', 'OLAK5uy_albumAAAA');
  sendCmd('collection_next', 'LM');
  sendCmd('collection_end', 'PL abc; drop');       // bad
  sendCmd('collection_end', 'x');                  // too short
  sendCmd('open', 'UCartistAAAAAAAAAAAAAAAA');
  sendCmd('open', 'https://evil.example');         // bad
  sendCmd('library', 'playlists');
  sendCmd('library', 'secrets');                   // not offered
  await wait(1100);                                // (the relay allows 10 commands a second per phone)
  sendCmd('queue_end', 'AAAAAAAAAA1');
  sendCmd('queue_end', 'short');                   // bad
  sendCmd('queue_clear');
  sendCmd('search', 'album|neon harbor');
  await wait(250);
  const gotK = kPc.msgs.filter((m) => m.type === 'cmd' && m.cmd !== 'get_state').map((m) => m.cmd + ' ' + (m.value ?? ''));
  assert.deepStrictEqual(gotK, [
    'play_collection OLAK5uy_albumAAAA', 'collection_next LM', 'open UCartistAAAAAAAAAAAAAAAA',
    'library playlists', 'queue_end AAAAAAAAAA1', 'queue_clear ', 'search album|neon harbor',
  ], 'only well-formed new commands pass');
  // Results of every kind are cleaned; library is forwarded
  kPc.send(JSON.stringify({ type: 'results', query: 'album|neon', results: [
    { kind: 'album', playlistId: 'OLAK5uy_albumAAAA', title: 'A', subtitle: 'B', thumb: 'https://x.test/a.png' },
    { kind: 'artist', browseId: 'UCartistAAAAAAAAAAAAAAAA', title: 'Art' },
    { kind: 'playlist', playlistId: 'bad id!', title: 'Nope' },
    { kind: 'song', videoId: 'AAAAAAAAAA1', title: 'S', thumb: 'javascript:1' },
    { kind: 'weird', videoId: 'AAAAAAAAAA2', title: 'Defaults to song' } ] }));
  kPc.send(JSON.stringify({ type: 'library', section: 'albums', items: [{ kind: 'album', playlistId: 'OLAK5uy_savedAAAA', title: 'Saved' }] }));
  kPc.send(JSON.stringify({ type: 'library', section: 'secrets', items: [] }));
  await wait(250);
  const kr = kPhone.msgs.find((m) => m.type === 'results');
  assert.deepStrictEqual(kr.results.map((r) => r.kind), ['album', 'artist', 'song', 'song'], 'bad ids dropped, unknown kind treated as song');
  assert.strictEqual(kr.results[3].thumb, '', 'unsafe thumbnail removed');
  const kl = kPhone.msgs.filter((m) => m.type === 'library');
  assert.strictEqual(kl.length, 1, 'only known library sections forwarded');
  assert.strictEqual(kl[0].items[0].playlistId, 'OLAK5uy_savedAAAA');
  kPc.close(); kPhone.close();

  // The log says which device did what, and never contains the token
  logLines.length = 0;
  const lgTok = 'logginglogginglogging_001';
  const lgPc = await open('pc', lgTok);
  const lgPhone = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://localhost:${port}/ws?role=phone&token=${lgTok}`, { headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    w.on('open', () => resolve(w)); w.on('error', reject);
  });
  lgPhone.send(JSON.stringify({ type: 'cmd', cmd: 'play_video', value: 'AAAAAAAAAA1' }));
  lgPhone.send(JSON.stringify({ type: 'cmd', cmd: 'volume', value: 30 }));
  lgPhone.send(JSON.stringify({ type: 'cmd', cmd: 'rm_rf', value: 'x' }));
  await wait(200);
  lgPhone.close(); lgPc.close();
  await wait(150);
  const logText = logLines.join('\n');
  assert.ok(/phone connected: Android Chrome, 203\.0\.113\.7/.test(logText), 'phone connection logged with device and address');
  assert.ok(/command play_video AAAAAAAAAA1\s+from Android Chrome, 203\.0\.113\.7/.test(logText), 'command logged with device');
  assert.ok(!/command volume/.test(logText), 'noisy commands stay out of the log');
  assert.ok(/unknown command rm_rf refused/.test(logText), 'refused commands logged');
  assert.ok(/PC connected/.test(logText) && /phone disconnected/.test(logText), 'PC connection and disconnection logged');
  assert.ok(!logText.includes(lgTok), 'token never appears in the log');

  // ---- Access codes: a token alone is not enough ----
  const crypto2 = require('crypto');
  process.env.ACCESS_CODE = 'open-sesame-123';
  process.env.PC_CODE = 'pc-secret-456';
  const cTok = 'codecodecodecodecodecode_77';
  const proof = (code, role, nonce) => crypto2.createHmac('sha256', code).update(`${cTok}|${role}|${nonce}`).digest('hex');
  // Connects, answers the challenge with `code` (or not at all), resolves once authed or closed.
  const connectCoded = (role, code, { name, ip = '198.51.100.1', answer = true } = {}) => new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://localhost:${port}/ws?role=${role}&token=${cTok}`, { headers: { 'x-forwarded-for': ip } });
    w.msgs = [];
    w.on('message', (d) => {
      const m = JSON.parse(d.toString());
      w.msgs.push(m);
      if (m.type === 'challenge' && answer) w.send(JSON.stringify({ type: 'auth', proof: proof(code, role, m.nonce), name }));
      if (m.type === 'authed') resolve({ w, closed: false });
    });
    w.on('close', (c) => resolve({ w, closed: true, code: c }));
    w.on('error', reject);
  });
  const pcOk = await connectCoded('pc', 'pc-secret-456');
  assert.ok(!pcOk.closed && pcOk.w.msgs.some((m) => m.type === 'authed' && m.guarded === true), 'PC with the right code gets in');
  const phoneOk = await connectCoded('phone', 'open-sesame-123', { name: 'Almog’s phone' });
  assert.ok(!phoneOk.closed, 'phone with the right code gets in');
  assert.ok(!phoneOk.w.msgs.some((m) => m.type === 'state' || m.type === 'pc_status') || phoneOk.w.msgs.findIndex((m) => m.type === 'challenge') < phoneOk.w.msgs.findIndex((m) => m.type === 'pc_status'), 'nothing is sent before the code is verified');

  // Token only (wrong code): refused, and gets nothing
  const bad = await connectCoded('phone', 'wrong-code');
  assert.ok(bad.closed && bad.code === 4003, 'wrong phone code refused with 4003');
  assert.ok(!bad.w.msgs.some((m) => m.type === 'pc_status' || m.type === 'state'), 'a refused phone learns nothing');
  // The phone's code does not open the PC slot, and the real PC is not kicked off
  const badPc = await connectCoded('pc', 'open-sesame-123');
  assert.ok(badPc.closed && badPc.code === 4003, 'PC slot needs the PC code');
  assert.strictEqual(pcOk.w.readyState, 1, 'the real PC was not replaced');
  // A connection that never answers cannot send commands
  const mute = await new Promise((resolve) => {
    const w = new WebSocket(`ws://localhost:${port}/ws?role=phone&token=${cTok}`, { headers: { 'x-forwarded-for': '198.51.100.2' } });
    w.on('open', () => { w.send(JSON.stringify({ type: 'cmd', cmd: 'toggle' })); setTimeout(() => { w.close(); resolve(); }, 300); });
  });
  pcOk.w.msgs.length = 0;
  await wait(100);
  assert.ok(!pcOk.w.msgs.some((m) => m.type === 'cmd' && m.cmd === 'toggle'), 'commands before the code are ignored');

  // Names: the PC is told who added a song; unnamed devices fall back to the device label
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'play_next', value: 'AAAAAAAAAA1' }));
  phoneOk.w.send(JSON.stringify({ type: 'name', name: '  Dana <b>phone</b>  ' }));
  await wait(80);
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'queue_end', value: 'BBBBBBBBBB2' }));
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'radio', value: 'current' }));
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'radio', value: 'AAAAAAAAAA1' }));
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'radio', value: 'nope nope' }));
  phoneOk.w.send(JSON.stringify({ type: 'cmd', cmd: 'health' }));
  await wait(300);
  const cmds = pcOk.w.msgs.filter((m) => m.type === 'cmd' && m.cmd !== 'get_state');
  assert.strictEqual(cmds[0].by, 'Almog’s phone', 'name given at login is used');
  assert.strictEqual(cmds[1].by, 'Dana bphoneb', 'renamed, and markup characters stripped');
  assert.deepStrictEqual(cmds.slice(2).map((m) => m.cmd + ' ' + (m.value ?? '')), ['radio current', 'radio AAAAAAAAAA1', 'health quick'], 'radio and health pass, a bad radio id does not');
  // Health results and "added by" labels reach phones, cleaned
  pcOk.w.send(JSON.stringify({ type: 'health', checks: [{ name: 'Queue', ok: true, detail: 'ok\n<script>' }, { name: 'Volume', ok: false, detail: 'no setVolume' }] }));
  pcOk.w.send(JSON.stringify({ type: 'ytqueue', items: [{ kind: 'song', videoId: 'AAAAAAAAAA1', title: 'T', by: 'Dana <i>' }] }));
  await wait(200);
  const hm = phoneOk.w.msgs.find((m) => m.type === 'health');
  assert.deepStrictEqual(hm.checks.map((c) => [c.name, c.ok]), [['Queue', true], ['Volume', false]]);
  assert.ok(!/[\n\r]/.test(hm.checks[0].detail), 'health text has no control characters');
  assert.strictEqual(phoneOk.w.msgs.find((m) => m.type === 'ytqueue').items[0].by, 'Dana i', 'added-by label cleaned');

  // Five wrong codes from one address block it for a while (the blocked address can't even connect)
  for (let i = 0; i < 5; i++) await connectCoded('phone', 'nope', { ip: '203.0.113.99' });
  const blocked = await new Promise((resolve) => {
    const w = new WebSocket(`ws://localhost:${port}/ws?role=phone&token=${cTok}`, { headers: { 'x-forwarded-for': '203.0.113.99' } });
    w.on('open', () => resolve('connected')); w.on('error', (e) => resolve(String(e.message)));
  });
  assert.ok(/429/.test(blocked), 'address blocked after repeated wrong codes: ' + blocked);
  const elsewhere = await connectCoded('phone', 'open-sesame-123', { ip: '203.0.113.50' });
  assert.ok(!elsewhere.closed, 'other addresses are not affected');
  assert.ok(logLines.some((l) => /WRONG code/.test(l)) && !logLines.some((l) => l.includes('open-sesame-123') || l.includes('pc-secret-456')), 'wrong codes are logged, codes never are');
  elsewhere.w.close(); phoneOk.w.close(); pcOk.w.close();
  delete process.env.ACCESS_CODE; delete process.env.PC_CODE;
  await wait(100);

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

  console.log = realLog;
  console.log('All relay tests passed');
  process.exit(0);
})().catch((e) => { console.log = realLog; console.error('FAIL:', e.message); process.exit(1); });
