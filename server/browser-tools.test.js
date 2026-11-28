'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const start=src.indexOf('function ordinaryRemoteTab('),end=src.indexOf('async function ensureAgent(',start);
assert(start>=0&&end>start);
const origin='https://relay.example.com',token='abcdefghijklmnopqrstuvwx_1234';
const state={relayUrl:origin,token,remoteTabs:true,remoteTabsOrigin:origin,remoteBrowserTools:true,remoteBrowserScope:origin+'|'+token};
const responses=[],calls=[],regular={id:1,windowId:1,incognito:false,url:'https://example.org',title:'Regular',mutedInfo:{muted:false}},
 privateTab={id:2,windowId:2,incognito:true,url:'https://private.example',title:'Private'};
let closed=[{tab:{incognito:false,sessionId:'123',url:'https://example.org',title:'Closed'}},{tab:{incognito:true,sessionId:'456',url:'https://private.example',title:'Private'}},{tab:{sessionId:'789',url:'https://unknown.example',title:'Unknown'}}];
const chrome={
 storage:{local:{get:async()=>({...state})}},permissions:{contains:async()=>true},
 tabs:{query:async()=>[regular,privateTab],get:async id=>id===1?regular:privateTab,update:async(id,data)=>calls.push(['update',id,data]),create:async data=>calls.push(['create',data]),remove:async id=>calls.push(['remove',id])},
 windows:{getAll:async()=>[{id:1,focused:false,incognito:false},{id:2,focused:true,incognito:true}],create:async data=>calls.push(['window',data]),update:async()=>{}},
 sessions:{getRecentlyClosed:async()=>closed,restore:async id=>{calls.push(['restore',id]);closed=closed.filter(s=>s.tab.sessionId!==id);}},
 management:{getAll:async()=>[{type:'extension',name:'Example',version:'1.0',enabled:true,id:'secret-id'}]}
};
const ws={readyState:1,send:s=>responses.push(JSON.parse(s))};
const run=new Function('chrome','agentWs','agentAuthed','agentScope','relayOrigin',src.slice(start,end)+'\nreturn remoteTabsRequest;')(chrome,ws,true,origin+'|'+token,x=>x);
async function request(action,extra={}){await run(ws,{id:'a'.repeat(32),action,...extra},origin,true);return responses.pop();}
(async()=>{
 const tabs=await request('list');assert.equal(tabs.tabs.length,1);assert.equal(tabs.advanced,true);assert(!('url' in tabs.tabs[0]));
 assert((await request('mute',{tabId:1})).ok);assert.deepEqual(calls.pop(),['update',1,{muted:true}]);
 assert(!(await request('mute',{tabId:2})).ok);
 assert((await request('navigate',{url:'https://example.org'})).ok);assert.equal(calls.pop()[1].windowId,1);
 for(const url of ['javascript:alert(1)','file:///C:/a','chrome://settings','https://u:p@example.org'])assert(!(await request('navigate',{url})).ok);
 const recent=await request('recent');assert.deepEqual(recent.recent,[{sessionId:'123',title:'Closed'}]);
 assert(!(await request('restore',{sessionId:'456'})).ok);
 assert((await request('restore',{sessionId:'123'})).ok);assert.deepEqual(calls.pop(),['restore','123']);
 const ext=await request('extensions');assert.deepEqual(ext.extensions,[{name:'Example',version:'1.0',enabled:true}]);
 assert(!(await request('disable_extension')).ok);
 state.remoteBrowserScope=origin+'|other';
 assert(!(await request('extensions')).ok);assert((await request('list')).ok);
 state.remoteTabs=false;assert(!(await request('list')).ok);
 console.log('PASS: browser tools opt-in, scope binding, private-tab exclusion, safe navigation and read-only inventory');
})().catch(e=>{console.error(e);process.exitCode=1;});
