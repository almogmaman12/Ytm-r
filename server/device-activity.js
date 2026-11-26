'use strict';
const crypto=require('node:crypto');
const {roomKey}=require('./calendar-neon');
const TTL=30*86400000, LIMIT=200;
const TYPES=new Set(['paired','connected','disconnected','renamed','paused','resumed','calendar_allowed','calendar_denied','removed','signed_out','playback','queue','volume','playlist']);
function createActivity(query,{now=Date.now,id=()=>crypto.randomBytes(16).toString('hex'),warn=()=>console.warn('Device activity could not be saved; will retry.')}={}){
  let pending=[],memory=[],flight=null,lastPrune=0,failed=false;
  async function init(){
    if(!query)return;
    await query('CREATE TABLE IF NOT EXISTS ytmr_device_activity_v1 (id text PRIMARY KEY,room_key text NOT NULL,at_ms bigint NOT NULL,data jsonb NOT NULL)');
    await query('CREATE INDEX IF NOT EXISTS ytmr_activity_room_at_v1 ON ytmr_device_activity_v1 (room_key,at_ms DESC)');
    await query('DELETE FROM ytmr_device_activity_v1 WHERE at_ms <= $1::bigint',[String(now()-TTL)]);
    lastPrune=now();
  }
  function record(token,device,type){
    if(!device||!TYPES.has(type))return;
    const row={id:id(),room_key:roomKey(token),at:now(),deviceId:device.id,name:String(device.name||'Phone').slice(0,24),type};
    if(query){pending.push(row);if(pending.length>1000){pending.shift();if(!failed)warn();failed=true;}}
    else{memory.push(row);memory=memory.filter(r=>r.at>now()-TTL).slice(-1000);}
  }
  async function flush(){
    if(!query)return true;
    if(flight)return flight;
    if(!pending.length&&now()-lastPrune<86400000)return true;
    flight=(async()=>{
      const batch=pending.slice();
      try{
        if(batch.length)await query(`INSERT INTO ytmr_device_activity_v1 (id,room_key,at_ms,data)
          SELECT x->>'id',x->>'room_key',(x->>'at')::bigint,x - 'room_key' FROM jsonb_array_elements($1::jsonb) AS t(x)
          ON CONFLICT (id) DO NOTHING`,[JSON.stringify(batch)]);
        const done=new Set(batch.map(r=>r.id));pending=pending.filter(r=>!done.has(r.id));
        if(now()-lastPrune>=86400000){
          await query('DELETE FROM ytmr_device_activity_v1 WHERE at_ms <= $1::bigint',[String(now()-TTL)]);lastPrune=now();
        }
        failed=false;return true;
      }catch{if(!failed)warn();failed=true;return false;}
    })().finally(()=>{flight=null;});
    return flight;
  }
  async function list(token,deviceId=''){
    const key=roomKey(token),cutoff=now()-TTL;
    let rows=[];
    const before=query?pending.slice():[];
    if(query){
      const result=await query("SELECT data::text AS data FROM ytmr_device_activity_v1 WHERE room_key=$1 AND at_ms>$2::bigint AND ($3::text='' OR data->>'deviceId'=$3) ORDER BY at_ms DESC,id DESC LIMIT 200",[key,String(cutoff),deviceId]);
      rows=result.map(r=>JSON.parse(r.data));
    }
    for(const row of (query?[...before,...pending]:memory))if(row.room_key===key&&row.at>cutoff&&(!deviceId||row.deviceId===deviceId))rows.push(row);
    const unique=new Map(rows.map(r=>[r.id,r]));
    return [...unique.values()].sort((a,b)=>b.at-a.at).slice(0,LIMIT).map(({id,at,deviceId,name,type})=>({id,at,deviceId,name,type}));
  }
  return {init,record,flush,list,mode:query?'neon':'memory',pending:()=>pending.length};
}
module.exports={createActivity};
