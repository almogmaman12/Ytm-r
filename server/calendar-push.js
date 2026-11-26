// Native Web Push, empty body (generic notification, no private event text).
const crypto = require('node:crypto');
const b64 = x => Buffer.from(x).toString('base64url');
function makeKeys() {
  if (process.env.VAPID_PRIVATE_JWK) {
    const privateKey = crypto.createPrivateKey({ key: JSON.parse(process.env.VAPID_PRIVATE_JWK), format: 'jwk' });
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  }
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
let keys=makeKeys();
function publicKey(){
  const pub=keys.publicKey.export({format:'jwk'});
  return b64(Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')]));
}
async function initPersistent(cloud){
  if(!cloud||process.env.VAPID_PRIVATE_JWK)return;
  const jwk=await cloud.vapid(keys.privateKey.export({format:'jwk'}));
  const privateKey=crypto.createPrivateKey({key:jwk,format:'jwk'});
  if(privateKey.asymmetricKeyType!=='ec'||privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Invalid persistent notification key');
  keys={privateKey,publicKey:crypto.createPublicKey(privateKey)};
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || u.search) return null;
    if (u.hostname === 'fcm.googleapis.com' && /^\/fcm\/send\/[A-Za-z0-9_:-]+$/.test(u.pathname)) return u;
    if (u.hostname === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/[A-Za-z0-9_-]+$/.test(u.pathname)) return u;
    if (u.hostname === 'web.push.apple.com' && /^\/[A-Za-z0-9_./-]+$/.test(u.pathname)) return u;
  } catch {}
  return null;
}
async function sendPush(value) {
  const u = endpoint(value);
  if (!u) return 410;
  const head = b64(JSON.stringify({ typ:'JWT', alg:'ES256' }));
  const body = b64(JSON.stringify({ aud:u.origin, exp: Math.floor(Date.now()/1000)+3600, sub: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  const msg = head + '.' + body;
  const sig = crypto.sign('sha256', Buffer.from(msg), { key:keys.privateKey, dsaEncoding:'ieee-p1363' }).toString('base64url');
  const response = await fetch(u, { method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
    headers:{ Authorization:'vapid t='+msg+'.'+sig+', k='+publicKey(), TTL:'60', Urgency:'normal', 'Content-Length':'0' } });
  return response.status;
}
module.exports = { get publicKey(){return publicKey();}, endpoint, sendPush, initPersistent };
if (require.main === module) console.log(JSON.stringify(crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'})));
