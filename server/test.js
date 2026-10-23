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

  // Rate limit
  const before = pc.msgs.filter((m) => m.cmd === 'toggle').length;
  for (let i = 0; i < 30; i++) phone.send(JSON.stringify({ type: 'cmd', cmd: 'toggle' }));
  await wait(200);
  const got = pc.msgs.filter((m) => m.cmd === 'toggle').length - before;
  assert(got <= 10, `rate limited (got ${got})`);

  // Path traversal blocked
  const res = await fetch(`http://localhost:${port}/..%2f..%2fserver.js`);
  assert.notStrictEqual(res.status, 200, 'path traversal blocked');
  assert.strictEqual((await fetch(`http://localhost:${port}/`)).status, 200, 'index served');

  console.log('All relay tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
