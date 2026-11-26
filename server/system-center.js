'use strict';
const crypto=require('node:crypto');
const {roomKey}=require('./calendar-neon');
const DAY=86400000,TTL=30*DAY;
const dayKey=t=>new Date(t).toISOString().slice(0,10);
const TABLES=[['Paired devices','ytmr_devices_v1'],['Calendar cache','ytmr_calendar_v1'],['Notifications','ytmr_push_v1'],['Private configuration','ytmr_private_config_v1'],['Device activity','ytmr_device_activity_v1'],['Connection history','ytmr_connections_v1'],['Relay sessions','ytmr_relay_sessions_v1'],['Usage metrics','ytmr_usage_v1'],['Migration records','ytmr_migrations_v1'],['System logs','ytmr_ops_events_v1'],['Latency samples','ytmr_ops_latency_v1'],['Feature metrics','ytmr_ops_metrics_v1'],['Alert preferences','ytmr_ops_prefs_v1']];
function createSystem(raw,{now=Date.now,id=()=>crypto.randomBytes(16).toString('hex'),warn=()=>console.warn('System metrics could not be saved; retrying.')}={}){
  const boot=id(),started=now(),days=new Map(),events=[],memory=[],connections=new Map();
  let ready=false,flight=null,lastBeat=started,lastPrune=started,dbState=null,failed=false,lastObserved=started,ended=null,dirtySession=false,storageCache=null;
  const query=raw?async(q,p)=>{
    const start=now(),day=dayKey(start),d=days.get(day)||{calls:0,errors:0,ms:0};
    days.set(day,d);d.calls++;
    try{const result=await raw(q,p);if(dbState===false)recordGlobal('database_recovered');dbState=true;return result;}
    catch(e){d.errors++;if(dbState!==false)recordGlobal('database_error');dbState=false;throw e;}
    finally{d.ms+=Math.max(0,now()-start);}
  }:null;
  function add(scope,kind){const row={id:id(),scope,kind,at:now()};events.push(row);if(events.length>1000){events.shift();if(!failed)warn();failed=true;}if(!raw){memory.push(row);if(memory.length>1000)memory.shift();events.length=0;}}
  function recordGlobal(kind){add('*',kind);}
  function transition(token,kind,online){
    if(!['pc','helper'].includes(kind))return;
    const scope=roomKey(token),k=scope+':'+kind,prev=connections.get(k);
    if(prev===online)return;
    connections.set(k,online);
    if(connections.size>2000)connections.delete(connections.keys().next().value);
    add(scope,kind+(online?'_connected':'_disconnected'));
  }
  async function init(){
    if(raw){
      await raw('CREATE TABLE IF NOT EXISTS ytmr_connections_v1 (id text PRIMARY KEY,scope text NOT NULL,at_ms bigint NOT NULL,kind text NOT NULL)');
      await raw('CREATE INDEX IF NOT EXISTS ytmr_connections_scope_at ON ytmr_connections_v1 (scope,at_ms DESC)');
      await raw('CREATE TABLE IF NOT EXISTS ytmr_relay_sessions_v1 (id text PRIMARY KEY,started_ms bigint NOT NULL,observed_ms bigint NOT NULL,ended_ms bigint)');
      await raw('CREATE TABLE IF NOT EXISTS ytmr_usage_v1 (boot text NOT NULL,day text NOT NULL,calls bigint NOT NULL,errors bigint NOT NULL,ms bigint NOT NULL,PRIMARY KEY(boot,day))');
      await raw('INSERT INTO ytmr_relay_sessions_v1 (id,started_ms,observed_ms) VALUES ($1,$2::bigint,$2::bigint) ON CONFLICT DO NOTHING',[boot,String(started)]);
    }
    ready=true;recordGlobal('relay_started');await flush();
  }
  function observe(active){
    if(!ready||!active||now()-lastBeat<1800000)return;
    lastBeat=now();lastObserved=lastBeat;dirtySession=true;
  }
  async function flush(){
    if(!ready||!raw)return true;
    if(flight)return flight;
    const usage=[...days].filter(([,d])=>d.dirty!==false||d.saved!==d.calls||d.savedMs!==d.ms||d.savedErrors!==d.errors).map(([day,d])=>({day,calls:d.calls,errors:d.errors,ms:d.ms}));
    if(!events.length&&!usage.length&&!dirtySession&&now()-lastPrune<DAY)return true;
    flight=(async()=>{
      try{
        const batch=events.slice(),stamp=lastObserved,stop=ended;
        if(batch.length){await raw(`INSERT INTO ytmr_connections_v1 (id,scope,at_ms,kind)
          SELECT x->>'id',x->>'scope',(x->>'at')::bigint,x->>'kind' FROM jsonb_array_elements($1::jsonb) t(x) ON CONFLICT DO NOTHING`,[JSON.stringify(batch)]);
          const ids=new Set(batch.map(r=>r.id));for(let i=events.length-1;i>=0;i--)if(ids.has(events[i].id))events.splice(i,1);}
        if(usage.length){await raw(`INSERT INTO ytmr_usage_v1 (boot,day,calls,errors,ms)
          SELECT $1,x->>'day',(x->>'calls')::bigint,(x->>'errors')::bigint,(x->>'ms')::bigint FROM jsonb_array_elements($2::jsonb) t(x)
          ON CONFLICT (boot,day) DO UPDATE SET calls=EXCLUDED.calls,errors=EXCLUDED.errors,ms=EXCLUDED.ms`,[boot,JSON.stringify(usage)]);
          for(const u of usage){const d=days.get(u.day);if(d){d.saved=u.calls;d.savedMs=u.ms;d.savedErrors=u.errors;d.dirty=false;}}}
        if(dirtySession){await raw('UPDATE ytmr_relay_sessions_v1 SET observed_ms=GREATEST(observed_ms,$2::bigint),ended_ms=$3::bigint WHERE id=$1',[boot,String(stamp),stop===null?null:String(stop)]);if(stamp===lastObserved&&stop===ended)dirtySession=false;}
        if(now()-lastPrune>=DAY){const cutoff=String(now()-TTL);
          await raw('DELETE FROM ytmr_connections_v1 WHERE at_ms<=$1::bigint',[cutoff]);
          await raw('DELETE FROM ytmr_relay_sessions_v1 WHERE observed_ms<=$1::bigint',[cutoff]);
          await raw('DELETE FROM ytmr_usage_v1 WHERE day<$1',[dayKey(now()-TTL)]);
          for(const k of days.keys())if(k<dayKey(now()-TTL))days.delete(k);
          lastPrune=now();}
        failed=false;return true;
      }catch{if(!failed)warn();failed=true;return false;}
    })().finally(()=>{flight=null;});
    return flight;
  }
  async function stop(){
    if(!ready)return;
    ended=lastObserved=now();dirtySession=true;recordGlobal('relay_stopped');
    await flush();await flush();
  }
  async function history(token){
    const scope=roomKey(token),cutoff=now()-TTL,queued=events.slice();
    let entries=[],sessions=[];
    if(raw){
      const rows=await raw("SELECT id,kind,at_ms FROM ytmr_connections_v1 WHERE scope IN ($1,'*') AND at_ms>$2::bigint ORDER BY at_ms DESC LIMIT 200",[scope,String(cutoff)]);
      entries=rows.map(r=>({id:r.id,kind:r.kind,at:Number(r.at_ms)}));
      const rr=await raw('SELECT id,started_ms,observed_ms,ended_ms FROM ytmr_relay_sessions_v1 WHERE observed_ms>$1::bigint ORDER BY started_ms DESC LIMIT 50',[String(cutoff)]);
      sessions=rr.map(r=>({id:r.id,started:Number(r.started_ms),observed:Number(r.observed_ms),ended:r.ended_ms==null?null:Number(r.ended_ms)}));
    }
    for(const r of raw?[...queued,...events]:memory)if((r.scope===scope||r.scope==='*')&&r.at>cutoff)entries.push({id:r.id,kind:r.kind,at:r.at});
    sessions=sessions.filter(s=>s.id!==boot);
    sessions.unshift({id:boot,started,observed:now(),ended,current:true});
    return {entries:[...new Map(entries.map(e=>[e.id,e])).values()].sort((a,b)=>b.at-a.at).slice(0,200),sessions:sessions.map(({id,...r})=>r),mode:raw?'neon':'memory'};
  }
  async function usage(){
    if(!raw)return {configured:false};
    const today=dayKey(now()),since=dayKey(now()-6*DAY);
    const rows=await raw('SELECT day,sum(calls)::text AS calls,sum(errors)::text AS errors,sum(ms)::text AS ms FROM ytmr_usage_v1 WHERE day >= $1 AND boot<>$2 GROUP BY day ORDER BY day',[since,boot]);
    const totals=new Map(rows.map(r=>[r.day,{day:r.day,calls:Number(r.calls),errors:Number(r.errors),ms:Number(r.ms)}]));
    for(const [day,d] of days){if(day<since)continue;const t=totals.get(day)||{day,calls:0,errors:0,ms:0};t.calls+=d.calls;t.errors+=d.errors;t.ms+=d.ms;totals.set(day,t);}
    if(!storageCache||now()-storageCache.at>300000){
      const rs=await raw('SELECT name,COALESCE(pg_total_relation_size(to_regclass(name)),0)::text AS bytes FROM unnest($1::text[]) AS t(name)', ['{'+TABLES.map(t=>t[1]).join(',')+'}']);
      storageCache={at:now(),tables:TABLES.map(([name,table])=>({name,bytes:Number(rs.find(r=>r.name===table)?.bytes||0)}))};
    }
    const week=Array.from({length:7},(_,i)=>{const day=dayKey(now()-(6-i)*DAY);return totals.get(day)||{day,calls:0,errors:0,ms:0};});
    return {configured:true,day:today,week,storage:storageCache,healthy:dbState!==false,trackingSince:started};
  }
  return {query,init,transition,observe,flush,stop,history,usage};
}
module.exports={createSystem};
