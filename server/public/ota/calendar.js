// ytmr-payload
// Read only rendered Google Calendar event chips; no network access to Google, no OAuth.
(() => {
  if (location.hostname !== 'calendar.google.com') return;
  if (globalThis.__YTMR_CALENDAR_STOP__) globalThis.__YTMR_CALENDAR_STOP__();
  let stopped = false, debounce, interval;
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  function dateOf(node) {
    const n = node.closest('[data-datekey],[data-date]');
    if (!n) return '';
    let y, m, d;
    const key = n.getAttribute('data-datekey');
    const raw = n.getAttribute('data-date');
    if (raw && /^\d{8}$/.test(raw)) { y = +raw.slice(0,4); m = +raw.slice(4,6); d = +raw.slice(6); }
    else if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) { [y,m,d] = raw.split('-').map(Number); }
    else if (key && /^-?\d+$/.test(key)) { const k = Number(key); y = 1970 + (k >> 9); m = (k >> 5) & 15; d = k & 31; }
    else return '';
    const check = new Date(y,m-1,d);
    if (check.getFullYear() !== y || check.getMonth() !== m-1 || check.getDate() !== d) return '';
    return [y,String(m).padStart(2,'0'),String(d).padStart(2,'0')].join('-');
  }
  // Only unambiguous clocks: 9:30 AM, 14:30, 9 AM. Do not invent an hour from a title.
  function readClock(value) {
    const text = clean(value).replace(/\u200e|\u200f/g,'');
    // For a displayed range, use its first clock only when it is independently unambiguous.
    const first = text.split(/\s*[\u2013\u2014-]\s*/)[0];
    const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(first);
    if (first !== text && !match?.[3] && /\b(am|pm)\b/i.test(text)) return null;
    if (!match || (!match[2] && !match[3])) return null;
    let hour = +match[1], minute = +(match[2] || 0);
    if (minute > 59) return null;
    if (match[3]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (/pm/i.test(match[3]) ? 12 : 0); }
    else if (hour > 23) return null;
    return { hour, minute };
  }
  function grab() {
    const grid = document.querySelector('[role="main"]') || document.querySelector('main');
    if (!grid || !/\/(week|day|month|customday|schedule)(\/|$)/.test(location.pathname))
      return { status: 'unsupported', items: [] };
    const chips = Array.from(grid.querySelectorAll('[data-eventid]'));
    const items = [], seen = new Set();
    for (const chip of chips) {
      if (chip.getAttribute('aria-hidden') === 'true' || !chip.getClientRects().length) continue;
      if (chip.parentElement?.closest('[data-eventid]')) continue;
      const date = dateOf(chip);
      if (!date) continue;
      const lines = (chip.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const timeNode = chip.querySelector('time,[data-event-time]');
      const candidate = clean(timeNode?.innerText || timeNode?.textContent || '');
      const clock = readClock(candidate) || (lines.length > 1 ? readClock(lines[0]) : null);
      const explicitTitle = clean(chip.querySelector('[data-event-title]')?.textContent);
      const title = explicitTitle || (clock && lines.length > 1 && readClock(lines[0]) ? lines.slice(1).join(' ') : lines.join(' '));
      if (!title) continue;
      const [y,m,d] = date.split('-').map(Number);
      // The Calendar display timezone must match the PC timezone for inferred clock times.
      let start = null;
      const dt = timeNode?.getAttribute('datetime');
      if (dt && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dt) && Number.isFinite(Date.parse(dt))) start = Date.parse(dt);
      else if (clock) start = new Date(y,m-1,d,clock.hour,clock.minute).getTime();
      const id = date + '|' + (chip.getAttribute('data-eventid') || '') + '|' + title + '|' + start;
      if (seen.has(id)) continue; seen.add(id);
      items.push({ title: title.slice(0,160), date, start, time: clock ? (candidate || lines[0]) : '' });
      if (items.length >= 80) break;
    }
    // A changed layout must not silently report an empty calendar.
    if (chips.length && !items.length) return { status: 'unsupported', items: [] };
    if (!chips.length && !grid.querySelector('[data-datekey],[data-date]')) return { status: 'unsupported', items: [] };
    items.sort((a,b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
    return { status: 'ok', items };
  }
  async function scan() {
    if (stopped) return;
    try {
      const allowed = await chrome.runtime.sendMessage({ type: 'calendar-check' });
      if (!stopped && allowed?.ok) await chrome.runtime.sendMessage({ type: 'calendar-grab', ...grab() });
    } catch {}
  }
  const observer = new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(scan, 1200); });
  observer.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
  interval = setInterval(scan, 30000);
  globalThis.__YTMR_CALENDAR_STOP__ = () => { stopped = true; observer.disconnect(); clearInterval(interval); clearTimeout(debounce); };
  setTimeout(scan, 2000);
})();
