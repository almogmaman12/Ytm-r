// Run on a trusted release machine. Never commit the private signing key.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey,createHash,sign,verify} from 'node:crypto';
import {join} from 'node:path';
const [zipPath,version,keyPath,outDir]=process.argv.slice(2);
if(!zipPath||!/^\d+(\.\d+){1,3}$/.test(version||'')||!keyPath||!outDir)
  throw Error('Usage: node sign-extension.mjs extension.zip 2.4.4 private.pem output-directory');
const privateKey=createPrivateKey(readFileSync(keyPath));
if(privateKey.asymmetricKeyType!=='ec'||privateKey.asymmetricKeyDetails.namedCurve!=='prime256v1')
  throw Error('Expected P-256 signing key');
const zip=readFileSync(zipPath);
if(zip.length>8*1024*1024)throw Error('Archive exceeds updater size limit');
const manifest=Buffer.from(JSON.stringify({format:1,product:'YTM Remote extension',version,sha256:createHash('sha256').update(zip).digest('hex')}));
const signature=sign('sha256',manifest,{key:privateKey,dsaEncoding:'ieee-p1363'});
if(!verify('sha256',manifest,{key:createPublicKey(privateKey),dsaEncoding:'ieee-p1363'},signature))throw Error('Self-verification failed');
writeFileSync(join(outDir,'extension-release.json'),manifest);
writeFileSync(join(outDir,'extension-release.sig'),signature);
writeFileSync(join(outDir,'extension.zip'),zip);
console.log('Signed release manifest and archive ready. Review before publishing.');
