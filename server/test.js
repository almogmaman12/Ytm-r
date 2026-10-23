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

  console.log('All relay tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
