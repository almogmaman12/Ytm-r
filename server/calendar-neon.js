'use strict';
const crypto=require('node:crypto');
const {TTL}=require('./calendar-cache');
const roomKey=token=>crypto.createHash('sha256').update('ytmr-calendar-v1\0'+token).digest('hex');
const hashKey=key=>crypto.createHash('sha256').update(key).digest('hex');
function createCalendarCloud(query){
  async function init(){
    await query('CREATE TABLE IF NOT EXISTS ytmr_calendar_v1 (room_key text PRIMARY KEY, at_ms bigint NOT NULL, data jsonb NOT NULL)');
    await query("CREATE TABLE IF NOT EXISTS ytmr_push_v1 (endpoint text PRIMARY KEY, room_key text NOT NULL, key_id text NOT NULL, sent jsonb NOT NULL DEFAULT '{}'::jsonb)");
    await query('CREATE TABLE IF NOT EXISTS ytmr_private_config_v1 (name text PRIMARY KEY, data jsonb NOT NULL)');
  }
  async function loadSnapshots(now=Date.now()){
    await query('DELETE FROM ytmr_calendar_v1 WHERE at_ms <= $1::bigint',[String(now-TTL)]);
    const rows=await query('SELECT room_key, data::text AS data FROM ytmr_calendar_v1 ORDER BY at_ms DESC LIMIT 100');
    return rows.map(r=>[r.room_key,JSON.parse(r.data)]).reverse();
  }
  async function writeSnapshot(key,snapshot){
    if(!snapshot)return query('DELETE FROM ytmr_calendar_v1 WHERE room_key=$1',[key]);
    return query(`INSERT INTO ytmr_calendar_v1 (room_key,at_ms,data) VALUES ($1,$2::bigint,$3::jsonb)
      ON CONFLICT (room_key) DO UPDATE SET at_ms=EXCLUDED.at_ms,data=EXCLUDED.data
      WHERE ytmr_calendar_v1.at_ms<=EXCLUDED.at_ms`,[key,String(snapshot.at),JSON.stringify(snapshot)]);
  }
  async function vapid(candidate){
    await query("INSERT INTO ytmr_private_config_v1 (name,data) VALUES ('vapid-v1',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(candidate)]);
    const rows=await query("SELECT data::text AS data FROM ytmr_private_config_v1 WHERE name='vapid-v1'");
    if(rows.length!==1)throw Error('Missing persistent notification key');
    return JSON.parse(rows[0].data);
  }
  async function loadSubscriptions(keyId){
    // Old keys cannot send to existing subscriptions. Drop stale records on key rotation.
    await query('DELETE FROM ytmr_push_v1 WHERE key_id<>$1',[keyId]);
    const rows=await query('SELECT endpoint,room_key,sent::text AS sent FROM ytmr_push_v1 WHERE key_id=$1',[keyId]);
    return rows.map(r=>({url:r.endpoint,roomKey:r.room_key,sent:JSON.parse(r.sent)}));
  }
  async function subscribe(url,key,keyId){
    await query(`INSERT INTO ytmr_push_v1 (endpoint,room_key,key_id) VALUES ($1,$2,$3)
      ON CONFLICT (endpoint) DO UPDATE SET room_key=EXCLUDED.room_key,key_id=EXCLUDED.key_id,
      sent=CASE WHEN ytmr_push_v1.room_key=EXCLUDED.room_key AND ytmr_push_v1.key_id=EXCLUDED.key_id THEN ytmr_push_v1.sent ELSE '{}'::jsonb END`,[url,key,keyId]);
  }
  async function unsubscribe(url,key,keyId){
    await query('DELETE FROM ytmr_push_v1 WHERE endpoint=$1 AND room_key=$2 AND key_id=$3',[url,key,keyId]);
  }
  async function saveSent(url,key,keyId,sent){
    await query('UPDATE ytmr_push_v1 SET sent=$4::jsonb WHERE endpoint=$1 AND room_key=$2 AND key_id=$3',[url,key,keyId,JSON.stringify(sent)]);
  }
  return {init,loadSnapshots,writeSnapshot,vapid,loadSubscriptions,subscribe,unsubscribe,saveSent};
}
module.exports={createCalendarCloud,roomKey,hashKey};
