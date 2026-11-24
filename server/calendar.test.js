const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const push = require('./calendar-push');
const {createCalendarCache}=require('./calendar-cache');
const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'ytmr-calendar-'));
try {
  const file=path.join(dir,'cache.json'),now=Date.now(),token='room-a';
  const store=createCalendarCache(file,{now:()=>now});
  const item={title:'Example',date:'2026-11-24',start:now+1000,end:now+2000,live:true};
  assert(store.put(token,{at:now,items:[item]}));
  assert.equal(store.get(token).items[0].live,false);
  assert.equal(store.put(token,{at:now,items:[]}),false,'transient empty cannot wipe cache');
  const restarted=createCalendarCache(file,{now:()=>now});
  assert.equal(restarted.get(token).items[0].end,item.end);
  assert.equal(restarted.get('room-b'),null);
  assert(restarted.put(token,{at:now,items:[],emptyConfirmed:true}));
  assert.equal(restarted.get(token).items.length,0);
  restarted.remove(token);assert.equal(createCalendarCache(file,{now:()=>now}).get(token),null);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
assert.equal(Buffer.from(push.publicKey,'base64url').length,65);
assert.ok(push.endpoint('https://fcm.googleapis.com/fcm/send/abc-123'));
assert.equal(push.endpoint('https://fcm.googleapis.com.evil.test/fcm/send/abc'),null);
assert.equal(push.endpoint('http://fcm.googleapis.com/fcm/send/abc'),null);
assert.equal(push.endpoint('https://127.0.0.1/fcm/send/abc'),null);
assert.equal(push.endpoint('https://fcm.googleapis.com/fcm/send/abc?x=1'),null);
const code = fs.readFileSync(path.join(__dirname,'public/ota/calendar.js'),'utf8');
const day = {getAttribute: k => k==='data-datekey' ? String(((2026-1970)<<9)|(11<<5)|24) : null};
const event = (id, title, time) => ({
  parentElement: {closest:()=>null}, closest:()=>day, getClientRects:()=>[{}],
  getAttribute:k=>k==='data-eventid'?id:null, innerText:time?time+'\n'+title:title,
  querySelector:()=>null,
});
const chips = [event('1','Meeting','09:30'),event('2','All day',''),event('3','Evening','6:30 PM'),event('4','Range','14:00–15:00'),event('5','Ambiguous','9:30–10:30 AM')];
let observed, first, permitted=true;
const grid = {querySelectorAll:s=>s==='[data-eventid]'?chips:[],querySelector:()=>day};
const ctx = {
  location:{hostname:'calendar.google.com',pathname:'/calendar/u/0/r/week'},
  document:{querySelector:()=>grid,documentElement:{}},
  MutationObserver:class{observe(){} disconnect(){}},
  setTimeout:fn=>{first=fn;return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){},
  chrome:{runtime:{sendMessage:async m=>{if(m.type==='calendar-check')return {ok:permitted};observed=m;return {ok:true};}}},
};
vm.runInNewContext(code,ctx);
(async()=>{
  await first();
  assert.equal(observed.status,'ok');
  assert.equal(observed.items.length,5);
  const find = title=>observed.items.find(x=>x.title===title);
  assert.equal(find('Meeting').date,'2026-11-24');
  assert.equal(find('Meeting').start,new Date(2026,10,24,9,30).getTime());
  assert.equal(find('Evening').start,new Date(2026,10,24,18,30).getTime());
  assert.equal(find('Range').start,new Date(2026,10,24,14,0).getTime());
  assert.equal(find('Range').end,new Date(2026,10,24,15,0).getTime());
  assert.equal(find('Meeting').end,null);
  assert.equal(find('All day').end,null);
  assert.equal(find('All day').start,null);
  assert.equal(observed.items.find(x=>x.title.includes('Ambiguous')).start,null);
  ctx.location.pathname='/calendar/u/0/r/agenda';
  chips.push(event('6','Hebrew','12:45 עד 14:45'));
  chips.push(event('7','16:00 עד 18:00 Single line',''));
  await first();
  assert.equal(observed.status,'ok');
  assert.equal(observed.items.find(x=>x.title==='Hebrew').start,new Date(2026,10,24,12,45).getTime());
  assert.equal(observed.items.find(x=>x.title==='Single line').start,new Date(2026,10,24,16,0).getTime());
  assert.equal(observed.items.find(x=>x.title==='Hebrew').end,new Date(2026,10,24,14,45).getTime());
  assert.equal(observed.items.find(x=>x.title==='Single line').end,new Date(2026,10,24,18,0).getTime());
  chips.push(event('8','Overnight','23:00 עד 01:00'));
  await first();assert.equal(observed.items.find(x=>x.title==='Overnight').end,new Date(2026,10,25,1,0).getTime());
  permitted=false;observed=null;await first();assert.equal(observed,null);
  console.log('Calendar fixture and push endpoint tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
