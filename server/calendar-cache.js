// Private server-side snapshot store. Never served from public/.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const TTL=14*86400000, MAX_ROOMS=100;
function createCalendarCache(file,{now=Date.now,io=fs,warn=()=>console.warn('Calendar cache disk write failed; retaining memory copy.')}={}){
  const data=new Map();
  const key=token=>crypto.createHash('sha256').update('ytmr-calendar-v1\0'+token).digest('hex');
  const valid=c=>c&&Number.isFinite(c.at)&&c.at>0&&now()-c.at<TTL&&c.at<=now()+60000&&Array.isArray(c.items);
  function prune(){let dirty=false;for(const [k,c] of data)if(!valid(c)){data.delete(k);dirty=true;}while(data.size>MAX_ROOMS){data.delete(data.keys().next().value);dirty=true;}return dirty;}
  try{const rows=JSON.parse(io.readFileSync(file,'utf8'));for(const row of Array.isArray(rows)?rows:[]){if(!Array.isArray(row))continue;const [k,c]=row;if(/^[0-9a-f]{64}$/.test(k)&&valid(c))data.set(k,{...c,items:c.items.slice(0,80)});}prune();}catch{}
  let lastWriteOk=true;
  function persist(){
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
  function remove(token){if(data.delete(key(token)))persist();}
  function sweep(){if(prune()||!lastWriteOk)persist();}
  return {get,put,remove,sweep};
}
module.exports={createCalendarCache,TTL};
