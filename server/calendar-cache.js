// Private server-side snapshot store. Never served from public/.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const TTL=14*86400000, MAX_ROOMS=100;
function createCalendarCache(file,{now=Date.now,io=fs,warn=()=>console.warn('Calendar cache write failed; retaining memory copy.'),cloud=null,onStatus=()=>{}}={}){
  const data=new Map();
  const key=token=>crypto.createHash('sha256').update('ytmr-calendar-v1\0'+token).digest('hex');
  const valid=c=>c&&Number.isFinite(c.at)&&c.at>0&&now()-c.at<TTL&&c.at<=now()+60000&&Array.isArray(c.items);
  function prune(){let dirty=false;for(const [k,c] of data)if(!valid(c)){data.delete(k);dirty=true;}while(data.size>MAX_ROOMS){data.delete(data.keys().next().value);dirty=true;}return dirty;}
  if(!cloud)try{const rows=JSON.parse(io.readFileSync(file,'utf8'));for(const row of Array.isArray(rows)?rows:[]){if(!Array.isArray(row))continue;const [k,c]=row;if(/^[0-9a-f]{64}$/.test(k)&&valid(c))data.set(k,{...c,items:c.items.slice(0,80)});}prune();}catch{}
  let lastWriteOk=true;
  const dirty=new Map(),saved=new Map(),failedKeys=new Set();
  let inflight=null;
  // Only write changed content or refresh the durable timestamp every hour.
  // Queue changes per room; retry on failure without falling back to a temporary disk.
  function cloudDirty(){
    for(const [k,c] of data){
      const old=saved.get(k);
      if(!old||JSON.stringify([old.items,old.emptyConfirmed])!==JSON.stringify([c.items,c.emptyConfirmed])||c.at-old.at>=3600000)dirty.set(k,c);
      else if(dirty.has(k))dirty.set(k,c);
    }
    for(const k of new Set([...saved.keys(),...dirty.keys()]))if(!data.has(k))dirty.set(k,null);
  }
  function flush(){
    if(!cloud)return Promise.resolve(true);
    if(inflight)return inflight;
    if(!dirty.size)return Promise.resolve(true);
    inflight=(async()=>{
      while(dirty.size){
        const [k,c]=dirty.entries().next().value;
        try{await cloud.writeSnapshot(k,c);}
        catch{if(lastWriteOk)warn();lastWriteOk=false;if(!failedKeys.has(k)){failedKeys.add(k);onStatus(k,false);}return false;}
        if(failedKeys.delete(k))onStatus(k,true);
        if(c)saved.set(k,c);else saved.delete(k);
        if(dirty.get(k)===c)dirty.delete(k);
        lastWriteOk=true;
      }
      return true;
    })().finally(()=>{inflight=null;});
    return inflight;
  }
  async function init(){
    if(!cloud)return;
    const rows=await cloud.loadSnapshots(now());
    for(const [k,c] of rows)if(/^[0-9a-f]{64}$/.test(k)&&valid(c)){data.set(k,c);saved.set(k,c);}
    prune();cloudDirty();
  }
  function persist(){
    if(cloud){cloudDirty();void flush();return;}
    try{io.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});io.writeFileSync(file+'.tmp',JSON.stringify([...data]),{mode:0o600});io.renameSync(file+'.tmp',file);lastWriteOk=true;}
    catch{if(lastWriteOk)warn();lastWriteOk=false;}
  }
  function get(token){
    const k=key(token),c=data.get(k);
    if(!valid(c)){if(data.delete(k))persist();return null;}
    return {...c,type:'calendar',status:'cached',items:c.items.map(x=>({...x,live:false}))};
  }
  function put(token,value){
    const k=key(token),previous=data.get(k);
    if(!valid(value))return false;
    if(valid(previous)&&(previous.at>value.at||(!value.items.length&&previous.items.length&&value.emptyConfirmed!==true)))return false;
    const snapshot={type:'calendar',status:'cached',at:value.at,items:value.items.slice(0,80).map(x=>({...x,live:false})),emptyConfirmed:value.emptyConfirmed===true};
    if(JSON.stringify(previous)===JSON.stringify(snapshot)){if(!lastWriteOk)persist();return true;}
    data.delete(k);data.set(k,snapshot);prune();persist();return true;
  }
  function remove(token){const k=key(token);if(cloud){data.delete(k);dirty.set(k,null);persist();}else if(data.delete(k))persist();}
  function sweep(){if(prune()||!lastWriteOk||dirty.size)persist();}
  function diagnostics(token){
    const k=key(token),current=get(token),durable=saved.get(k);
    return {mode:cloud?'neon':'file',at:current?.at||null,count:current?.items.length||0,
      savedAt:cloud?(valid(durable)?durable.at:null):(lastWriteOk?current?.at||null:null),
      pending:!!cloud&&dirty.has(k),writeFailed:cloud?failedKeys.has(k):!lastWriteOk};
  }
  return {get,put,remove,sweep,init,flush,diagnostics};
}
module.exports={createCalendarCache,TTL};
