// Runs inside music.youtube.com. Reads player state and performs commands
// by using the page's own controls. Talks only to the background worker.

(() => {
  const q = (sel) => document.querySelector(sel);
  const bar = () => q('ytmusic-player-bar');
  const video = () => q('video');

  function getState() {
    const b = bar();
    const v = video();
    if (!b) return null;
    const title = b.querySelector('.title')?.textContent?.trim() || '';
    const byline = b.querySelector('.byline')?.textContent?.trim() || '';
    const art = b.querySelector('img#img')?.src || b.querySelector('.image')?.src || '';
    const slider = b.querySelector('#volume-slider');
    return {
      title,
      artist: byline.split('•')[0].trim(),
      playing: v ? !v.paused : false,
      volume: slider ? Number(slider.value) : v ? Math.round(v.volume * 100) : null,
      position: v ? Math.floor(v.currentTime) : null,
      duration: v && isFinite(v.duration) ? Math.floor(v.duration) : null,
      art: art.startsWith('https://') ? art : '',
    };
  }

  function click(sel) {
    const el = bar()?.querySelector(sel);
    if (el) el.click();
  }

  function run(cmd, value) {
    const v = video();
    switch (cmd) {
      case 'play': if (v && v.paused) click('#play-pause-button'); break;
      case 'pause': if (v && !v.paused) click('#play-pause-button'); break;
      case 'toggle': click('#play-pause-button'); break;
      case 'next': click('.next-button'); break;
      case 'previous': click('.previous-button'); break;
      case 'volume': {
        const slider = bar()?.querySelector('#volume-slider');
        if (slider) {
          slider.value = value;
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (v) {
          v.volume = value / 100;
        }
        break;
      }
      case 'seek': if (v) v.currentTime = value; break;
      case 'get_state': break;
      default: return;
    }
    // Give the page a moment to update, then report.
    setTimeout(report, 250);
  }

  function report() {
    const state = getState();
    if (state) chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'cmd') run(msg.cmd, msg.value);
  });

  // Periodic and change-driven reporting.
  let last = '';
  setInterval(() => {
    const s = getState();
    if (!s) return;
    const key = JSON.stringify([s.title, s.artist, s.playing, s.volume]);
    if (key !== last) {
      last = key;
      report();
    }
  }, 1000);
  setInterval(report, 10000);
})();
