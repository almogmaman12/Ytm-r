'use strict';
const crypto=require('crypto');
const MAX=16384;
function createCompanionBackup(query, code, secure) {
  const seen=new Map(), limits=new Map();
  const prune=()=>{const now=Date.now();for(const [k,v] of seen)if(v<now)seen.delete(k);for(const [k,v] of limits)if(v.until<now)limits.delete(k);};
  const reply=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
  async function init(){if(query)await query('CREATE TABLE IF NOT EXISTS ytmr_companion_backup_v1 (room text PRIMARY KEY, envelope text NOT NULL, updated bigint NOT NULL)');}
  async function handle(req,res){
    if(req.method!=='POST')return reply(res,405,{error:'method'});
    if(!query||!secure())return reply(res,503,{error:'Cloud backup unavailable'});
    let chunks=[],size=0;
    try{
      for await(const chunk of req){size+=chunk.length;if(size>MAX){reply(res,413,{error:'too large'});return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks),ts=String(req.headers['x-ytmr-time']||''),nonce=String(req.headers['x-ytmr-nonce']||''),proof=String(req.headers['x-ytmr-proof']||'');
      if(!/^\d{13}$/.test(ts)||Math.abs(Date.now()-Number(ts))>120000||! /^[a-f0-9]{32}$/.test(nonce)||! /^[a-f0-9]{64}$/.test(proof))return reply(res,401,{error:'authentication'});
      const hash=crypto.createHash('sha256').update(body).digest('hex');
      const expected=crypto.createHmac('sha256',code()).update('companion-backup|'+ts+'|'+nonce+'|'+hash).digest();
      if(!crypto.timingSafeEqual(expected,Buffer.from(proof,'hex')))return reply(res,401,{error:'authentication'});
      prune();if(seen.has(nonce)||seen.size>=4096)return reply(res,429,{error:'retry later'});seen.set(nonce,Date.now()+240000);
      const m=JSON.parse(body.toString('utf8'));
      if(!m||typeof m.token!=='string'||! /^[A-Za-z0-9_-]{20,200}$/.test(m.token)||!['put','get','delete'].includes(m.action))return reply(res,400,{error:'invalid request'});
      const room=crypto.createHash('sha256').update('companion-backup|'+m.token).digest('hex');
      const limit=limits.get(room)||{n:0,until:Date.now()+60000};if(limit.n>=10||(!limits.has(room)&&limits.size>=4096))return reply(res,429,{error:'retry later'});limit.n++;limits.set(room,limit);
      if(m.action==='put'){
        if(typeof m.envelope!=='string'||m.envelope.length>12000||! /^[A-Za-z0-9+/=]+$/.test(m.envelope))return reply(res,400,{error:'invalid envelope'});
        const updated=Date.now();await query('INSERT INTO ytmr_companion_backup_v1(room,envelope,updated) VALUES ($1,$2,$3) ON CONFLICT(room) DO UPDATE SET envelope=EXCLUDED.envelope,updated=EXCLUDED.updated',[room,m.envelope,updated]);return reply(res,200,{updated});
      }
      if(m.action==='delete'){await query('DELETE FROM ytmr_companion_backup_v1 WHERE room=$1',[room]);return reply(res,200,{deleted:true});}
      const rows=await query('SELECT envelope,updated FROM ytmr_companion_backup_v1 WHERE room=$1',[room]);if(!rows.length)return reply(res,404,{error:'No backup'});
      return reply(res,200,{envelope:rows[0].envelope,updated:Number(rows[0].updated)});
    }catch{return reply(res,400,{error:'Backup request failed'});}
  }
  return {init,handle};
}
module.exports={createCompanionBackup};
