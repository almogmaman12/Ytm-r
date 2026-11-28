'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {createCompanionBackup}=require('./companion-backup');
(async()=>{
  const db=new Map(),code='test-pc-code';
  const service=createCompanionBackup(async(sql,p=[])=>{
    if(sql.startsWith('CREATE'))return [];
    if(sql.startsWith('INSERT')){db.set(p[0],{envelope:p[1],updated:p[2]});return [];}
    if(sql.startsWith('DELETE')){db.delete(p[0]);return [];}
    if(sql.startsWith('SELECT'))return db.has(p[0])?[db.get(p[0])]:[];
    throw Error('unexpected query');
  },()=>code,()=>true);
  await service.init();
  const server=http.createServer((req,res)=>void service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const token='abcdefghijklmnopqrstuvwx_1234',other='zzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  function signed(action,room=token,envelope='YWJj',key=code){
    const body=JSON.stringify({token:room,action,envelope}),time=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
    const proof=crypto.createHmac('sha256',key).update('companion-backup|'+time+'|'+nonce+'|'+crypto.createHash('sha256').update(body).digest('hex')).digest('hex');
    return {method:'POST',body,headers:{'x-ytmr-time':time,'x-ytmr-nonce':nonce,'x-ytmr-proof':proof}};
  }
  try{
    assert.equal((await fetch(url,signed('get'))).status,404);
    assert.equal((await fetch(url,signed('put',token,'YWJj','wrong'))).status,401);
    const request=signed('put');assert.equal((await fetch(url,request)).status,200);
    assert.equal((await fetch(url,request)).status,429);
    assert.equal((await (await fetch(url,signed('get'))).json()).envelope,'YWJj');
    assert.equal((await fetch(url,signed('get',other))).status,404);
    assert(![...db.keys()].includes(token));
    assert.equal((await fetch(url,signed('delete'))).status,200);
    assert.equal((await fetch(url,signed('get'))).status,404);
    console.log('PASS: authenticated encrypted backup storage, replay prevention, room isolation and deletion');
  }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
