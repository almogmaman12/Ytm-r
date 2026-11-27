// YT Music Remote - extension shell.
//
// This is the small part you install once. It downloads the real code (the "payload") from
// YOUR relay's /ota/ folder, checks it, and starts it on music.youtube.com using Chrome's
// userScripts API. To update the remote, change the files in server/public/ota/ and redeploy
// your relay (for example git push); the extension picks the new version up by itself.
//
// Safety rules for the downloaded code:
//   - it only comes from the relay address you typed in settings (https, or localhost);
//   - redirects to other addresses are refused;
//   - every file must match the SHA-256 fingerprint in the relay's manifest and start with the
//     payload marker, so an error page or a half-written file is never run;
//   - it only runs on https://music.youtube.com/*, plus https://www.youtube.com/* if (and only if) you
//     switch that on in the settings and approve Chrome's permission prompt; Calendar scripts
//     have their own optional host permission and run on any Calendar tab;
//   - a bad or unreachable download never replaces the copy that already works.

const SHELL_API = 2;            // payloads that need a newer shell are not installed
const SHELL_BUILD = '2.4.5';    // Must match manifest.version in every new shell release.
const SCRIPT_PREFIX = 'ytmr-';
const YTM = 'https://music.youtube.com/*';
const YT = 'https://www.youtube.com/*';          // optional: regular YouTube, off unless enabled in the settings
let ytOn = false, calendarOn = false;
const CAL = 'https://calendar.google.com/*';
const matchesFor = (f) => f.target === 'calendar' ? (calendarOn ? [CAL] : []) : siteMatches();
const siteMatches = () => (ytOn ? [YTM, YT] : [YTM]);
const CHECK_EVERY_MINUTES = 10;
const MAX_FILE_BYTES = 400000;
const MARKER = '// ytmr-payload';

// ---- helpers ----

const userScriptsReady = () => {
  try { return !!(chrome.userScripts && typeof chrome.userScripts.register === 'function'); } catch { return false; }
};

function relayOrigin(raw, allowHttp) {
  const u = new URL(String(raw || '').trim());
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && (local || allowHttp)) return u.origin;
  throw new Error('Use an https:// address. (http:// is only accepted for localhost.)');
}

async function getConfig() {
  const c = await chrome.storage.local.get(['relayUrl', 'token', 'allowHttp', 'pcCode', 'youtube', 'calendar']);
  pcCodeNow = c.pcCode || '';
  ytOn = !!c.youtube && await chrome.permissions.contains({ origins: [YT] }).catch(() => false);
  calendarOn = !!c.calendar && await chrome.permissions.contains({ origins: [CAL] }).catch(() => false);
  return { relayUrl: c.relayUrl || '', token: c.token || '', allowHttp: !!c.allowHttp };
}

async function fetchBytes(url, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctrl.signal });
    if (!res.ok) throw new Error(`The relay answered HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) throw new Error('File is too large');
    return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('The relay did not answer in time');
    if (e instanceof TypeError) throw new Error("Can't reach the relay (check the address, or it may be waking up)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('The relay sent an invalid update manifest');
  if (typeof m.version !== 'string' || !/^[0-9a-f]{6,64}$/.test(m.version)) throw new Error('Invalid payload version');
  if (!Number.isInteger(m.requiresShell) || m.requiresShell < 1) throw new Error('Invalid manifest');
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 6) throw new Error('Invalid file list');
  const names = new Set();
  for (const f of m.files) {
    if (!f || !/^[A-Za-z0-9_.-]+\.js$/.test(f.name) || names.has(f.name)) throw new Error('Invalid file entry');
    if (f.world !== 'MAIN' && f.world !== 'USER_SCRIPT') throw new Error('Invalid file world');
    if (f.target != null && f.target !== 'calendar' && f.target !== 'music') throw new Error('Invalid payload target');
    if (f.target === 'calendar' && f.world !== 'USER_SCRIPT') throw new Error('Calendar must use an isolated script');
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('Invalid fingerprint');
    names.add(f.name);
  }
}

// The optional PC code (see the README) travels to the page script together with the token.
let pcCodeNow = '';
const cfgKey = (origin, token) => `${origin}|${token}|${pcCodeNow}|${ytOn ? 'yt' : ''}|${calendarOn ? 'cal' : ''}`;

async function saveStatus(patch) {
  const { ota = {} } = await chrome.storage.local.get('ota');
  await chrome.storage.local.set({ ota: { ...ota, ...patch, checkedAt: Date.now() } });
}

// ---- registering the payload with Chrome ----

function codeFor(f, origin, token, version) {
  const prefix = f.target === 'calendar' ? '' : f.world === 'USER_SCRIPT'
    ? `globalThis.__YTMR_CONFIG__=${JSON.stringify({ relay: origin, token, version, pcCode: pcCodeNow })};\n`
    : '';
  return prefix + f.code;
}

// MAIN-world files first, so the page helper exists before the content script asks for it.
const ordered = (files) => Object.entries(files).sort((a, b) => (a[1].world === 'MAIN' ? -1 : 1) - (b[1].world === 'MAIN' ? -1 : 1));

async function registerFiles(origin, token, version, files) {
  await chrome.userScripts.configureWorld({ messaging: true });
  const existing = (await chrome.userScripts.getScripts()).filter((s) => s.id.startsWith(SCRIPT_PREFIX)).map((s) => s.id);
  if (existing.length) await chrome.userScripts.unregister({ ids: existing });
  await chrome.userScripts.register(ordered(files).filter(([, f]) => matchesFor(f).length).map(([name, f]) => ({
    id: SCRIPT_PREFIX + name,
    matches: matchesFor(f),
    js: [{ code: codeFor(f, origin, token, version) }],
    runAt: 'document_idle',
    world: f.world,
  })));
}

// Tabs that are already open get the new code straight away. The new copy tells the old one
// to stop, so nothing runs twice and the page does not need to be reloaded.
async function applyToOpenTabs(origin, token, version, files) {
  const tabs = await chrome.tabs.query({ url: [...siteMatches(), ...(calendarOn ? [CAL] : [])] });
  if (!tabs.length) return true;
  if (typeof chrome.userScripts.execute !== 'function') return false;
  let ok = true;
  for (const tab of tabs) {
    for (const [, f] of ordered(files)) {
      if (!matchesFor(f).some(p => (tab.url || '').startsWith(p.slice(0, -1)))) continue;
      try {
        await chrome.userScripts.execute({
          target: { tabId: tab.id },
          world: f.world,
          js: [{ code: codeFor(f, origin, token, version) }],
          injectImmediately: true,
        });
      } catch { ok = false; }
    }
  }
  return ok;
}

// After a browser restart, or if the token changed: make sure what Chrome has registered
// matches the saved copy and current settings.
async function ensureRegistered() {
  if (!userScriptsReady()) return;
  const { ota } = await chrome.storage.local.get('ota');
  if (!ota || !ota.files) return;
  const cfg = await getConfig();
  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch { return; }
  const have = new Set((await chrome.userScripts.getScripts()).map((s) => s.id));
  const wanted = Object.entries(ota.files).filter(([, f]) => matchesFor(f).length).map(([n]) => SCRIPT_PREFIX + n);
  if (ota.cfgKey === cfgKey(origin, cfg.token) && wanted.every((id) => have.has(id))) return;
  await registerFiles(origin, cfg.token, ota.version, ota.files);
  await chrome.storage.local.set({ ota: { ...ota, cfgKey: cfgKey(origin, cfg.token) } });
}

// ---- the update check ----

let running = null;
let rerun = false;

function checkForUpdate(opts) {
  if (running) { rerun = rerun || !!(opts && opts.force); return running; }
  running = doUpdate(opts || {})
    .catch((e) => saveStatus({ state: 'rejected', error: String((e && e.message) || e) }).then(summary))
    .finally(async () => {
      running = null;
      if (rerun) { rerun = false; checkForUpdate({ force: true }); }
    });
  return running;
}

async function doUpdate({ force = false }) {
  const cfg = await getConfig();
  if (!cfg.relayUrl || !cfg.token) { await saveStatus({ state: 'not-configured', error: '' }); return summary(); }

  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch (e) {
    await saveStatus({ state: 'bad-relay', error: e.message });
    return summary();
  }
  if (!userScriptsReady()) { await saveStatus({ state: 'userscripts-disabled', error: '' }); return summary(); }

  const { ota = {} } = await chrome.storage.local.get('ota');

  // 1. Ask the relay what the current payload is.
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(`${origin}/ota/manifest.json`)));
    validateManifest(manifest);
  } catch (e) {
    await ensureRegistered().catch(() => {});
getConfig().then(ensureAgent).catch(() => {});
    await saveStatus({ state: ota.version ? 'offline' : 'fetch-failed', error: e.message });
    return summary();
  }

  if (manifest.requiresShell > SHELL_API) {
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'needs-shell', latest: manifest.version, error: '' });
    return summary();
  }

  const key = cfgKey(origin, cfg.token);
  if (!force && ota.version === manifest.version && ota.cfgKey === key) {
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'ok', latest: manifest.version, error: '' });
    return summary();
  }

  // 2. Download every file and check it.
  const files = {};
  try {
    for (const f of manifest.files) {
      const buf = await fetchBytes(`${origin}/ota/${f.name}`);
      if (hex(await crypto.subtle.digest('SHA-256', buf)) !== f.sha256) throw new Error(`${f.name} does not match its fingerprint`);
      const code = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      if (!code.startsWith(MARKER)) throw new Error(`${f.name} is not a YT Music Remote payload file`);
      files[f.name] = { world: f.world, target: f.target || 'music', sha256: f.sha256, code };
    }
  } catch (e) {
    // Keep whatever already works.
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'rejected', error: `Update refused: ${e.message}`, latest: manifest.version });
    return summary();
  }

  // 3. Start it.
  try {
    await registerFiles(origin, cfg.token, manifest.version, files);
  } catch (e) {
    await saveStatus({ state: 'rejected', error: `Chrome would not register the update: ${e.message}` });
    return summary();
  }
  const applied = await applyToOpenTabs(origin, cfg.token, manifest.version, files);
  await chrome.storage.local.set({
    ota: {
      version: manifest.version, latest: manifest.version, files, cfgKey: key,
      installedAt: Date.now(), checkedAt: Date.now(), state: 'ok', error: '', reloadNeeded: !applied,
    },
  });
  return summary();
}

async function summary() {
  const { ota = {}, pcStatus = null } = await chrome.storage.local.get(['ota', 'pcStatus']);
  const { files, ...rest } = ota;
  return {
    ...rest,
    pcStatus,
    shellApi: SHELL_API,
    shellBuild: SHELL_BUILD,
    manifestVersion: chrome.runtime.getManifest().version,
    userScriptsReady: userScriptsReady(),
    canApplyLive: userScriptsReady() && typeof chrome.userScripts.execute === 'function',
    extensionId: chrome.runtime.id,
  };
}

// ---- wake-up helper ----
// While no YouTube Music tab is open, keep one small connection to the relay (role "agent", same
// PC code as the tab). If your phone asks, it opens music.youtube.com. It can do nothing else:
// the address is fixed here and the relay sends no other instructions to it.
let agentWs = null, agentAuthed = false;
let calendarCache=null, calendarScope='', agentScope='', calendarWork=Promise.resolve();
const calendarTabs=new Map();
const CAL_TTL=14*86400000;
function calendarQueue(fn){const p=calendarWork.then(fn);calendarWork=p.catch(()=>{});return p;}
async function loadCalendarCache(cfg,origin){
  const scope=origin+'|'+cfg.token;
  if(calendarScope!==scope){
    calendarScope=scope;calendarTabs.clear();
    const {calendarCacheV2}=await chrome.storage.local.get('calendarCacheV2');
    calendarCache=calendarCacheV2?.scope===scope?calendarCacheV2:null;
  }
  if(calendarCache&&Date.now()-calendarCache.at>=CAL_TTL)calendarCache=null;
}
function publishCalendar(){
  if(!agentAuthed||!agentWs||agentWs.readyState!==1||calendarScope!==agentScope)return;
  const now=Date.now();
  for(const [id,t] of calendarTabs)if(now-t.at>=180000)calendarTabs.delete(id);
  const live=new Set([...calendarTabs.values()].filter(t=>t.status==='ok').flatMap(t=>t.keys));
  let data;
  if(!calendarOn)data={status:'disabled',items:[]};
  else if(calendarCache&&now-calendarCache.at<CAL_TTL)data={status:[...calendarTabs.values()].some(t=>t.status==='ok')?'ok':'cached',at:calendarCache.at,emptyConfirmed:calendarCache.emptyConfirmed===true,items:calendarCache.items.map(x=>({title:x.title,date:x.date,start:x.start,end:x.end??null,time:x.time,allDay:x.allDay,live:live.has(x.key)&&now-x.seenAt<180000}))};
  else data={status:[...calendarTabs.values()].some(t=>t.status==='unsupported')?'unsupported':'offline',items:[]};
  try{agentWs.send(JSON.stringify({type:'calendar_snapshot',...data}));}catch{}
}
async function saveCalendarTab(tabId,source,msg){
  const cfg=await getConfig();if(!calendarOn||!cfg.token)return false;
  await loadCalendarCache(cfg,relayOrigin(cfg.relayUrl,cfg.allowHttp));
  const now=Date.now();
  if(msg.status!=='ok'){calendarTabs.set(tabId,{at:now,status:'unsupported',keys:[]});return true;}
  const items=(Array.isArray(msg.items)?msg.items:[]).slice(0,80).filter(x=>x&&typeof x.title==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(Date.parse(x.date))).map(x=>{
    const title=x.title.slice(0,160),start=Number.isFinite(x.start)?x.start:null,time=String(x.time||'').slice(0,50);
    const end=Number.isFinite(x.end)&&start!==null&&x.end>start&&x.end-start<=7*86400000?x.end:null;
    return {title,date:x.date,start,end,time,allDay:x.allDay===true,source,seenAt:now,key:source+'|'+x.date+'|'+title+'|'+(start??time)};
  });
  // Closing or navigating a tab can briefly expose an empty DOM. Require two
  // matching empty scans separated by time before deleting previously observed dates.
  const prior=calendarTabs.get(tabId);
  const emptySig=JSON.stringify((Array.isArray(msg.days)?msg.days:[]).slice(0,62).sort());
  if(!items.length&&calendarCache?.items?.length&&(!prior?.emptySince||prior.emptySig!==emptySig||now-prior.emptySince<15000)){
    calendarTabs.set(tabId,{at:now,status:'unsupported',keys:[],emptySig,emptySince:prior?.emptySig===emptySig&&prior.emptySince?prior.emptySince:now});return true;
  }
  const days=new Set(items.map(x=>x.date));
  for(const d of (Array.isArray(msg.days)?msg.days:[]).slice(0,62))if(typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d)))days.add(d);
  const merged=new Map((calendarCache?.items||[]).filter(x=>!(x.source===source&&days.has(x.date))&&now-x.seenAt<CAL_TTL).map(x=>[x.key,x]));
  for(const x of items){const old=calendarCache?.items?.find(y=>y.key===x.key);if(x.end===null&&old?.end>x.start)x.end=old.end;merged.set(x.key,x);}
  const all=[...merged.values()].filter(x=>Date.parse(x.date)>=now-8*86400000&&Date.parse(x.date)<=now+61*86400000).sort((a,b)=>a.date.localeCompare(b.date)||(a.start??0)-(b.start??0)).slice(0,80);
  calendarTabs.set(tabId,{at:now,status:'ok',keys:items.map(x=>x.key)});
  calendarCache={scope:calendarScope,at:now,items:all,emptyConfirmed:all.length===0&&days.size>0};
  await chrome.storage.local.set({calendarCacheV2:calendarCache});return true;
}
async function clearCalendarCache(){calendarTabs.clear();calendarCache=null;await chrome.storage.local.remove('calendarCacheV2');publishCalendar();}
let agentPing = null;
let agentRetry = null;
let agentDelay = 3000;

function stopAgent() {
  agentAuthed = false;
  clearInterval(agentPing); agentPing = null;
  clearTimeout(agentRetry); agentRetry = null;
  if (agentWs) { const w = agentWs; agentWs = null; try { w.close(); } catch {} }
}

// Chrome can put a YouTube Music tab to sleep (discard it, or freeze it) when it has been in the
// background for a while. Ask Chrome not to discard it on its own, every time we see one.
async function pinTabs() {
  const tabs = await chrome.tabs.query({ url: YTM }).catch(() => []);
  for (const t of tabs) {
    if (t.autoDiscardable !== false) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
  }
}

// The phone asked for YouTube Music. No tab: open one. A discarded tab: reload it (it has no live
// state left anyway). A tab that is asleep but still loaded: bring it to the front for a moment
// and put you back where you were, which wakes it without losing the page.
async function openMusicTab() {
  const tabs = await chrome.tabs.query({ url: YTM }).catch(() => []);
  if (!tabs.length) {
    const url = 'https://music.youtube.com/';
    try { await chrome.tabs.create({ url, active: false }); }
    catch { await chrome.windows.create({ url, focused: false }).catch(() => {}); }
    return;
  }
  const t = tabs[0];
  if (t.discarded) { await chrome.tabs.reload(t.id).catch(() => {}); return; }
  if (t.active) return;
  const [was] = await chrome.tabs.query({ active: true, windowId: t.windowId }).catch(() => []);
  await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  setTimeout(() => { if (was && was.id !== t.id) chrome.tabs.update(was.id, { active: true }).catch(() => {}); }, 1200);
}

// The phone asked to open or switch the site. "swap" replaces the other site: its tab is reused
// (same window and position, so a full-screen browser on a TV stays full-screen) or closed.
// Tabs opened here are marked so their script connects to the relay at once instead of waiting.
const claimTabs = new Map();   // tab id -> expiry
const SITE_URL = { ytm: 'https://music.youtube.com/', yt: 'https://www.youtube.com/' };
async function openSite(site, swap) {
  if (site !== 'ytm' && site !== 'yt') return;
  await getConfig().catch(() => {});                     // refreshes ytOn
  if (site === 'yt' && !ytOn) return;                    // regular YouTube is off in the settings
  const url = SITE_URL[site];
  const mine = await chrome.tabs.query({ url: site === 'ytm' ? YTM : YT }).catch(() => []);
  const others = swap ? await chrome.tabs.query({ url: site === 'ytm' ? YT : YTM }).catch(() => []) : [];
  const claim = (id) => claimTabs.set(id, Date.now() + 60000);
  let target = mine[0];
  if (target) {
    if (target.discarded) await chrome.tabs.reload(target.id).catch(() => {});
  } else if (others.length) {
    target = others.shift();
    await chrome.tabs.update(target.id, { url }).catch(() => {});
  } else {
    try { target = await chrome.tabs.create({ url, active: true }); }
    catch { const w = await chrome.windows.create({ url, focused: true }).catch(() => null); target = w && w.tabs && w.tabs[0]; }
  }
  if (target) {
    claim(target.id);
    await chrome.tabs.update(target.id, { active: true }).catch(() => {});
    if (target.windowId != null) await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
  }
  if (swap) for (const t of others) chrome.tabs.remove(t.id).catch(() => {});
}
function sendCaps() {
  if (agentWs && agentWs.readyState === 1) { try { agentWs.send(JSON.stringify({ type: 'caps', yt: ytOn })); } catch {} }
}

// Browser tab management is explicitly opted in and limited to the test relay.
function ordinaryRemoteTab(t) {
  if (!t || t.incognito || !Number.isInteger(t.id) || typeof t.url !== 'string') return false;
  try { const u=new URL(t.url);return ['https:','http:'].includes(u.protocol); } catch { return false; }
}
async function remoteTabsRequest(ws,m,origin,guarded) {
  if (!guarded || origin !== 'https://ytm-r.onrender.com' || ws !== agentWs || !agentAuthed || !/^[0-9a-f]{32}$/.test(m.id || '')) return;
  const respond=(data)=>{if(ws===agentWs&&agentAuthed&&ws.readyState===1)ws.send(JSON.stringify({type:'chrome_tabs_result',id:m.id,...data}));};
  const allowed=async()=>ws===agentWs&&agentAuthed&&(await chrome.storage.local.get('remoteTabs')).remoteTabs===true&&await chrome.permissions.contains({permissions:['tabs']});
  try {
    if(!await allowed())return respond({ok:false,error:'Enable remote tabs in the extension settings and approve Chrome tab access.'});
    if(!['list','activate','close'].includes(m.action))return respond({ok:false,error:'Unsupported tab action.'});
    if(m.action!=='list'){
      if(!Number.isSafeInteger(m.tabId)||m.tabId<0)return respond({ok:false,error:'Invalid tab.'});
      const t=await chrome.tabs.get(m.tabId);
      if(!ordinaryRemoteTab(t)||!await allowed())return respond({ok:false,error:'This tab is not available for remote control.'});
      if(m.action==='activate'){await chrome.tabs.update(t.id,{active:true});await chrome.windows.update(t.windowId,{focused:true});}
      else await chrome.tabs.remove(t.id);
    }
    const tabs=(await chrome.tabs.query({})).filter(ordinaryRemoteTab);
    if(!await allowed())return respond({ok:false,error:'Remote tabs disabled.'});
    respond({ok:true,total:tabs.length,tabs:tabs.slice(0,60).map(t=>({id:t.id,title:String(t.title||'Web tab').slice(0,120),active:!!t.active,audible:!!t.audible,windowId:t.windowId}))});
  }catch{respond({ok:false,error:'Chrome could not complete the tab request. Refresh the list.'});}
}
async function ensureAgent() {
  const { agent } = await chrome.storage.local.get('agent');
  const cfg = await getConfig();
  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch { return stopAgent(); }
  // Always on (not only when no tab is open): if the tab is asleep, the phone can still wake it.
  if (agent === false || !cfg.token) return stopAgent();
  await loadCalendarCache(cfg,origin);
  if (agentWs && agentWs.readyState <= 1) return;
  agentScope=origin+'|'+cfg.token;
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(cfg.token)}&role=agent`);
  agentWs = ws;
  let guarded=false;
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'challenge') {
      if (!pcCodeNow) return;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pcCodeNow), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${cfg.token}|agent|${m.nonce}`));
      ws.send(JSON.stringify({ type: 'auth', proof: hex(sig) }));
    } else if (m.type === 'authed') {
      agentAuthed = true;
      guarded=m.guarded===true;
      agentDelay = 3000;
      clearInterval(agentPing);
      // A message every 20 s also keeps Chrome from stopping this worker.
      agentPing = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 20000);
      sendCaps(); publishCalendar();
    } else if (m.type === 'chrome_tabs_request') {
      await remoteTabsRequest(ws,m,origin,guarded);
    } else if (m.type === 'wake') {
      openMusicTab();
    } else if (m.type === 'site') {
      openSite(m.site, !!m.swap).catch(() => {});
    }
  };
  ws.onclose = (ev) => {
    if (agentWs !== ws) return;
    agentWs = null; agentAuthed = false;
    clearInterval(agentPing); agentPing = null;
    const wait = ev.code === 4003 ? 10 * 60 * 1000 : agentDelay;   // wrong or missing code: do not hammer the relay
    agentDelay = Math.min(agentDelay * 2, 60000);
    agentRetry = setTimeout(() => ensureAgent().catch(() => {}), wait);
  };
  ws.onerror = () => {};
}

// ---- events ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ota-check') { checkForUpdate({ force: !!msg.force }).then(sendResponse, () => sendResponse(null)); return true; }
  if (msg.type === 'calendar-open' && sender.url === chrome.runtime.getURL('options.html')) {
    (async () => {
      await getConfig(); if (!calendarOn) return { ok: false };
      await chrome.tabs.create({ url: 'https://calendar.google.com/calendar/u/0/r/agenda', active: true });
      return { ok: true };
    })().then(sendResponse, () => sendResponse({ ok: false })); return true;
  }
  if (msg.type === 'ota-status') { summary().then(sendResponse, () => sendResponse(null)); return true; }
});

const lastActivation = new Map();   // tabId -> time, so one tab gets at most one synthetic click per 30 s
async function giveActivation(tabId, x, y) {
  const now = Date.now();
  if (now - (lastActivation.get(tabId) || 0) < 30000) return false;
  const { sound } = await chrome.storage.local.get('sound');
  if (sound !== true || !chrome.debugger || !(await chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false))) return false;
  lastActivation.set(tabId, now);
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); } catch { return false; }   // e.g. DevTools is already open on that tab
  try {
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    return true;
  } catch { return false; }
  finally { chrome.debugger.detach(target).catch(() => {}); }
}
let lastPhoneCheck = 0;
// Optional status messages from the running payload (shown on the settings page).
if (chrome.runtime.onUserScriptMessage) {
  chrome.runtime.onUserScriptMessage.addListener((msg, sender, sendResponse) => {
    if (msg && (msg.type === 'calendar-grab' || msg.type === 'calendar-check')) {
      (async () => {
        const tab = sender.tab;
        const cfg=await chrome.storage.local.get('calendar');
        if(!tab||sender.frameId!==0||!/^https:\/\/calendar\.google\.com\/calendar\//.test(sender.url||'')||!cfg.calendar||!(await chrome.permissions.contains({origins:[CAL]})))return false;
        if(msg.type==='calendar-check')return true;
        const source=(new URL(sender.url).pathname.match(/\/u\/(\d+)\//)||[])[1]||'0';
        const ok=await calendarQueue(()=>saveCalendarTab(tab.id,source,msg));
        if(ok){await ensureAgent();publishCalendar();}return ok;
      })().then(ok => sendResponse({ ok }), () => sendResponse({ ok: false })); return true;
    }
    if (msg && msg.type === 'claim-check') {
      // A YouTube tab waits for a video to play before taking the connection, unless we just opened it for the phone.
      const id = sender && sender.tab && sender.tab.id;
      const until = claimTabs.get(id) || 0;
      if (until > Date.now()) claimTabs.delete(id);
      sendResponse({ claim: until > Date.now() });
      return true;
    }
    if (msg && msg.type === 'activate') {
      // Chrome only lets a tab play sound after a real click or key press in it. A tab opened from the
      // phone has had none, so (only if the person turned this on in settings) send one real click.
      const tab = sender && sender.tab;
      const x = Number(msg.x), y = Number(msg.y);
      if (tab && /^https:\/\/(music|www)\.youtube\.com\//.test(tab.url || '') && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < 10000 && y < 10000) {
        giveActivation(tab.id, x, y).then((ok) => { try { sendResponse({ ok }); } catch { /* gone */ } });
        return true;
      }
      sendResponse({ ok: false });
      return;
    }
    if (msg && msg.type === 'ota-check') {
      // "Refresh" on the phone: look for an update now (at most every 30 seconds).
      if (Date.now() - lastPhoneCheck > 30000) { lastPhoneCheck = Date.now(); checkForUpdate({ force: false }); }
      return;
    }
    if (msg && msg.type === 'pc-status' && typeof msg.state === 'string') {
      chrome.storage.local.set({ pcStatus: { state: msg.state.slice(0, 20), version: String(msg.version || '').slice(0, 20), at: Date.now() } });
    }
  });
}

chrome.tabs.onRemoved.addListener(async (id) => {
  await calendarQueue(async()=>{calendarTabs.delete(id);publishCalendar();});
  const tabs = await chrome.tabs.query({ url: siteMatches() }).catch(() => []);
  if (!tabs.length) chrome.storage.local.set({ pcStatus: { state: 'no-tab', version: '', at: Date.now() } });
  ensureAgent().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if(info.url&&!info.url.startsWith('https://calendar.google.com/')&&calendarTabs.delete(tabId))publishCalendar();
  if (info.url && info.url.startsWith('https://music.youtube.com/')) { ensureAgent().catch(() => {}); pinTabs(); }
  if (info.status !== 'complete' || !tab.url || !(tab.url.startsWith('https://music.youtube.com/') || (calendarOn&&tab.url.startsWith('https://calendar.google.com/')))) return;
  const { ota = {} } = await chrome.storage.local.get('ota');
  if (Date.now() - (ota.checkedAt || 0) > 120000) checkForUpdate();
});

chrome.permissions.onAdded.addListener(() => { ensureRegistered().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { getConfig().then(async () => { if (!calendarOn) await calendarQueue(clearCalendarCache); return ensureRegistered(); }).catch(() => {}); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.calendar) {
    getConfig().then(async()=>{if(!calendarOn)await calendarQueue(clearCalendarCache);else await ensureAgent();publishCalendar();}).catch(()=>{});checkForUpdate({force:true});
  }
  if (area === 'local' && changes.youtube) { checkForUpdate({ force: true }); getConfig().then(sendCaps).catch(() => {}); }
  if (area === 'local' && (changes.relayUrl || changes.token || changes.allowHttp || changes.pcCode)) checkForUpdate({ force: true });
  if (area === 'local' && (changes.relayUrl || changes.token || changes.allowHttp || changes.pcCode || changes.agent)) { if(changes.relayUrl||changes.token){calendarCache=null;calendarScope='';calendarTabs.clear();} stopAgent(); ensureAgent().catch(() => {}); }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  checkForUpdate({ force: true });
});
// A local, owner-enabled startup check for stale workers after an unpacked update.
function newerShellVersion(candidate, running) {
  const valid = v => typeof v === 'string' && /^\d+(\.\d+){1,3}$/.test(v) && v.split('.').every(n => Number(n) <= 65535 && String(Number(n)) === n);
  if (!valid(candidate) || !valid(running)) return false;
  const a = candidate.split('.').map(Number), b = running.split('.').map(Number);
  for (let i=0; i<4; i++) {
    const diff=(a[i]||0)-(b[i]||0);
    if (diff) return diff>0;
  }
  return false;
}
async function reloadStaleShellAtStartup() {
  const saved = await chrome.storage.local.get(['reloadShellAtStartup','shellReloadAttempt']);
  if (saved.reloadShellAtStartup !== true) return false;
  const target = chrome.runtime.getManifest().version;
  if (!newerShellVersion(target,SHELL_BUILD)) return false;
  // One attempt per target version, persisted across worker and browser restarts.
  if (saved.shellReloadAttempt?.target === target) return false;
  await chrome.storage.local.set({shellReloadAttempt:{target,from:SHELL_BUILD,at:Date.now()}});
  chrome.runtime.reload();
  return true;
}
chrome.runtime.onStartup.addListener(async () => {
  try { if (await reloadStaleShellAtStartup()) return; } catch { /* Keep the current shell usable. */ }
  checkForUpdate(); ensureAgent().catch(() => {});
});
chrome.alarms.create('ota-check', { periodInMinutes: CHECK_EVERY_MINUTES, delayInMinutes: 1 });
chrome.alarms.create('agent-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ota-check') checkForUpdate();
  if (a.name === 'agent-check') { ensureAgent().catch(() => {}); pinTabs(); publishCalendar(); }
});

pinTabs();

// A worker restart only needs to make sure the saved copy is registered; it does not hit the network.
ensureRegistered().catch(() => {});
