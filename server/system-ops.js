'use strict';
const crypto=require('node:crypto');
const {roomKey}=require('./calendar-neon');
const DAY=86400000,TTL=30*DAY;
const EVENTS={
 relay_started:['info','system','Relay started'],relay_stopped:['info','system','Relay stopped'],
 pc_connected:['info','connection','PC playback connected'],pc_disconnected:['info','connection','PC playback disconnected'],
 helper_connected:['info','connection','PC helper connected'],helper_disconnected:['info','connection','PC helper disconnected'],
 pc_long_offline:['warning','connection','PC playback disconnected for at least 15 minutes'],pc_recovered:['success','connection','PC playback recovered'],
 database_error:['error','database','Application database request failed'],database_recovered:['success','database','Application database responding again'],
 backup_failed:['error','calendar','Calendar backup write failed'],backup_recovered:['success','calendar','Calendar backup recovered'],
 auth_failed:['warning','security','Access code rejected'],pair_failed:['warning','security','Invalid or expired pairing code'],
 device_key_failed:['warning','security','Invalid or revoked device key'],blocked:['warning','security','Rate-limit block activated'],
 blocked_request:['info','security','Blocked connection refused'],paired:['info','device','New device paired'],
 paused:['info','device','Device paused'],resumed:['info','device','Device resumed'],removed:['info','device','Device removed'],
 calendar_allowed:['info','device','Calendar permission granted'],calendar_denied:['info','device','Calendar permission revoked']
};
const ALERTS=new Set(['pc_long_offline','pc_recovered','database_error','database_recovered','backup_failed','backup_recovered','blocked','paired']);
function feature(sql){const q=String(sql);if(/ytmr_device_activity_v1/.test(q))return 'Device activity';if(/ytmr_calendar_v1/.test(q))return 'Calendar';if(/ytmr_push_v1|ytmr_private_config_v1/.test(q))return 'Notifications';if(/ytmr_devices_v1|ytmr_migrations_v1/.test(q))return 'Paired devices';return 'Diagnostics / setup';}
function createOps(raw,{now=Date.now,id=()=>crypto.randomBytes(16).toString('hex'),warn=()=>console.warn('System Center telemetry write failed.')}={}){
 let pending=[],local=[],samples=[],metrics=new Map(),flight=null,ready=false,lastPrune=0,dbState=null,failed=false;
 const prefs=new Map(),states=new Map(),lastEvent=new Map(),lastSample=new Map(),boot=id();
 const scope=t=>t?roomKey(t):'*';
 function emit(token,kind){return emitScope(scope(token),kind);}
 function emitScope(key,kind){if(!EVENTS[kind]||!(key==='*'||/^[0-9a-f]{64}$/.test(key)))return;const at=now(),k=key+':'+kind;
  // Reduce attack/reconnect storms without storing addresses, names, secrets or input.
  const interval=['auth_failed','pair_failed','device_key_failed','blocked_request','blocked'].includes(kind)?60000:0;
  if(interval&&lastEvent.has(k)&&at-lastEvent.get(k)<interval)return;
  lastEvent.set(k,at);if(lastEvent.size>2000)lastEvent.delete(lastEvent.keys().next().value);
  const row={id:id(),scope:key,at,kind};local.push(row);if(local.length>1000)local.shift();
  if(raw){pending.push(row);if(pending.length>1000)pending.shift();}
 }
 function conn(token,role,online){if(!['pc','helper'].includes(role))return;const key=scope(token)+':'+role,prev=states.get(key);
  if(prev?.online===online)return;
  states.set(key,{token,role,online,at:now(),alerted:false});if(states.size>1000)states.delete(states.keys().next().value);
  emit(token,role+(online?'_connected':'_disconnected'));
  if(online&&prev?.alerted)emit(token,'pc_recovered');
 }
 function tick(){for(const s of states.values())if(s.role==='pc'&&!s.online&&!s.alerted&&now()-s.at>=900000){s.alerted=true;emit(s.token,'pc_long_offline');}}
 function sample(token,role,ms){if(!token||!['pc','helper','phone'].includes(role)||!Number.isFinite(ms)||ms<0||ms>60000)return;
  const key=scope(token),k=key+':'+role,at=now();if(lastSample.has(k)&&at-lastSample.get(k)<300000)return;
  lastSample.set(k,at);if(lastSample.size>2000)lastSample.delete(lastSample.keys().next().value);
  samples.push({id:id(),scope:key,at,role,ms:Math.round(ms)});if(samples.length>1000)samples.shift();
 }
 function measure(q,ms,ok){const day=new Date(now()).toISOString().slice(0,10),name=feature(q),key=day+'|'+name,d=metrics.get(key)||{day,name,calls:0,errors:0,ms:0};
  d.calls++;d.errors+=ok?0:1;d.ms+=Math.max(0,ms);metrics.set(key,d);
  if(!ok&&dbState!==false)emit(null,'database_error');if(ok&&dbState===false)emit(null,'database_recovered');dbState=ok;
 }
 async function init(){if(raw){
  await raw('CREATE TABLE IF NOT EXISTS ytmr_ops_events_v1 (id text PRIMARY KEY,scope text NOT NULL,at_ms bigint NOT NULL,kind text NOT NULL)');
  await raw('CREATE INDEX IF NOT EXISTS ytmr_ops_events_scope_at ON ytmr_ops_events_v1 (scope,at_ms DESC)');
  await raw('CREATE TABLE IF NOT EXISTS ytmr_ops_latency_v1 (id text PRIMARY KEY,scope text NOT NULL,at_ms bigint NOT NULL,role text NOT NULL,ms integer NOT NULL)');
  await raw('CREATE INDEX IF NOT EXISTS ytmr_ops_latency_scope_at ON ytmr_ops_latency_v1 (scope,at_ms DESC)');
  await raw('CREATE TABLE IF NOT EXISTS ytmr_ops_metrics_v1 (boot text NOT NULL,day text NOT NULL,name text NOT NULL,calls bigint NOT NULL,errors bigint NOT NULL,ms bigint NOT NULL,PRIMARY KEY(boot,day,name))');
  await raw('CREATE TABLE IF NOT EXISTS ytmr_ops_prefs_v1 (scope text PRIMARY KEY,data jsonb NOT NULL)');
  for(const r of await raw('SELECT scope,data::text AS data FROM ytmr_ops_prefs_v1')){try{const p=JSON.parse(r.data);prefs.set(r.scope,{readAt:Number(p.readAt)||0,push:p.push===true});}catch{}}
 }ready=true;emit(null,'relay_started');await flush();}
 async function flush(){if(!ready||!raw)return true;if(flight)return flight;
  const batch=pending.slice(),points=samples.slice(),counts=[...metrics.values()].filter(d=>d.saved!==d.calls||d.savedMs!==d.ms||d.savedErrors!==d.errors).map(d=>({day:d.day,name:d.name,calls:d.calls,errors:d.errors,ms:d.ms}));
  if(!batch.length&&!points.length&&!counts.length&&now()-lastPrune<DAY)return true;
  flight=(async()=>{try{
   if(batch.length){await raw("INSERT INTO ytmr_ops_events_v1 SELECT x->>'id',x->>'scope',(x->>'at')::bigint,x->>'kind' FROM jsonb_array_elements($1::jsonb) t(x) ON CONFLICT DO NOTHING",[JSON.stringify(batch)]);const ids=new Set(batch.map(r=>r.id));pending=pending.filter(r=>!ids.has(r.id));}
   if(points.length){await raw("INSERT INTO ytmr_ops_latency_v1 SELECT x->>'id',x->>'scope',(x->>'at')::bigint,x->>'role',(x->>'ms')::integer FROM jsonb_array_elements($1::jsonb) t(x) ON CONFLICT DO NOTHING",[JSON.stringify(points)]);const ids=new Set(points.map(r=>r.id));samples=samples.filter(r=>!ids.has(r.id));}
   if(counts.length){await raw("INSERT INTO ytmr_ops_metrics_v1 SELECT $1,x->>'day',x->>'name',(x->>'calls')::bigint,(x->>'errors')::bigint,(x->>'ms')::bigint FROM jsonb_array_elements($2::jsonb) t(x) ON CONFLICT(boot,day,name) DO UPDATE SET calls=EXCLUDED.calls,errors=EXCLUDED.errors,ms=EXCLUDED.ms",[boot,JSON.stringify(counts)]);for(const c of counts){const d=metrics.get(c.day+'|'+c.name);if(d){d.saved=c.calls;d.savedMs=c.ms;d.savedErrors=c.errors;}}}
   if(now()-lastPrune>=DAY){const cut=String(now()-TTL);await raw('DELETE FROM ytmr_ops_events_v1 WHERE at_ms<=$1::bigint',[cut]);await raw('DELETE FROM ytmr_ops_latency_v1 WHERE at_ms<=$1::bigint',[cut]);const day=new Date(now()-TTL).toISOString().slice(0,10);await raw('DELETE FROM ytmr_ops_metrics_v1 WHERE day<$1',[day]);for(const [k,d] of metrics)if(d.day<day)metrics.delete(k);lastPrune=now();}
   failed=false;return true;
  }catch{if(!failed)warn();failed=true;return false;}})().finally(()=>{flight=null;});return flight;
 }
 async function list(token){const key=scope(token),cut=now()-TTL,before=local.slice();let rows=[];
  if(raw){const r=await raw("SELECT id,kind,at_ms FROM ytmr_ops_events_v1 WHERE scope IN ($1,'*') AND at_ms>$2::bigint ORDER BY at_ms DESC LIMIT 400",[key,String(cut)]);rows=r.map(x=>({id:x.id,kind:x.kind,at:Number(x.at_ms)}));}
  for(const r of [...before,...local])if((r.scope===key||r.scope==='*')&&r.at>cut)rows.push(r);
  return [...new Map(rows.map(r=>[r.id,r])).values()].filter(r=>EVENTS[r.kind]).sort((a,b)=>b.at-a.at).slice(0,400).map(r=>{const [severity,category,message]=EVENTS[r.kind];return {id:r.id,kind:r.kind,at:r.at,severity,category,message,alert:ALERTS.has(r.kind)};});
 }
 function preference(token){return prefs.get(scope(token))||{readAt:0,push:false};}
 let prefTail=Promise.resolve();
 function setPreference(token,patch){const run=prefTail.then(async()=>{const key=scope(token),p={...preference(token),...patch};if(raw)await raw('INSERT INTO ytmr_ops_prefs_v1 VALUES ($1,$2::jsonb) ON CONFLICT(scope) DO UPDATE SET data=EXCLUDED.data',[key,JSON.stringify(p)]);prefs.set(key,p);return p;});prefTail=run.catch(()=>{});return run;}
 async function analytics(token){const key=scope(token),cut=now()-DAY,before=samples.slice();let points=[];
  if(raw){const r=await raw('SELECT id,role,at_ms,ms FROM ytmr_ops_latency_v1 WHERE scope=$1 AND at_ms>$2::bigint ORDER BY at_ms DESC LIMIT 900',[key,String(cut)]);points=r.map(x=>({id:x.id,role:x.role,at:Number(x.at_ms),ms:Number(x.ms)}));}
  for(const r of [...before,...samples])if(r.scope===key&&r.at>cut)points.push(r);
  return [...new Map(points.map(r=>[r.id,r])).values()].sort((a,b)=>a.at-b.at).slice(-900).map(({role,at,ms})=>({role,at,ms}));
 }
 async function breakdown(){const day=new Date(now()).toISOString().slice(0,10),totals=new Map();if(raw){const rows=await raw('SELECT name,sum(calls)::text calls,sum(errors)::text errors,sum(ms)::text ms FROM ytmr_ops_metrics_v1 WHERE day=$1 AND boot<>$2 GROUP BY name',[day,boot]);for(const r of rows)totals.set(r.name,{name:r.name,calls:Number(r.calls),errors:Number(r.errors),ms:Number(r.ms)});}
  for(const d of metrics.values())if(d.day===day){const t=totals.get(d.name)||{name:d.name,calls:0,errors:0,ms:0};t.calls+=d.calls;t.errors+=d.errors;t.ms+=d.ms;totals.set(d.name,t);}
  return [...totals.values()].sort((a,b)=>b.calls-a.calls);
 }
 function recentAlerts(key,after){return local.filter(r=>r.at>after&&(r.scope===key||r.scope==='*')&&ALERTS.has(r.kind));}
 function pushEnabled(key){return prefs.get(key)?.push===true;}
 return {init,flush,emit,emitScope,conn,tick,sample,measure,list,preference,setPreference,analytics,breakdown,recentAlerts,pushEnabled,mode:raw?'neon':'memory'};
}
module.exports={createOps,feature};
