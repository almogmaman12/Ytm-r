const assert = require('assert');
const WebSocket = require('ws');
const { server, wss } = require('./index');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const payloadResponse = await fetch(`${base}/extension-payload.js`);
    assert.strictEqual(payloadResponse.status, 200, 'OTA payload endpoint responds');
    assert((await payloadResponse.text()).includes('__YTM_REMOTE_RELAY_URL__'), 'payload supports configured relay URL');

    const first = await open(`ws://127.0.0.1:${port}`);
    const second = await open(`ws://127.0.0.1:${port}`);
    try {
      const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('relay broadcast timed out')), 1500);
        second.once('message', (message) => {
          clearTimeout(timeout);
          resolve(message.toString());
        });
      });
      first.send(JSON.stringify({ type: 'test', value: 'ota-relay-ok' }));
      assert.strictEqual(await received, JSON.stringify({ type: 'test', value: 'ota-relay-ok' }), 'relay forwards messages between clients');
    } finally {
      first.close();
      second.close();
      await wait(50);
    }

    console.log('OTA relay tests passed');
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});