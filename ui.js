/* Small shared UI helpers: formatting + settings/data panel used by all versions. */
(function () {
  const C = window.NetCore;
  const fmt = {
    ms: v => v == null ? '—' : Math.round(v) + ' ms',
    mbps: v => v == null ? '—' : (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' Mbps',
    pct: v => v == null ? '—' : Math.round(v) + '%',
    mb: b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB',
    time: t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    day: k => { const [y, m, d] = k.split('-').map(Number); const dt = new Date(y, m - 1, d); const today = C.dayKey(Date.now()), yest = C.dayKey(Date.now() - 864e5); return k === today ? 'Today' : k === yest ? 'Yesterday' : dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
  };

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v); }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }

  function seg(options, current, onPick) {
    const wrap = el('div', { class: 'nw-seg' });
    options.forEach(([val, label]) => {
      const b = el('button', { type: 'button', class: val === current ? 'on' : '', onclick: () => { [...wrap.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); onPick(val); } }, label);
      wrap.append(b);
    });
    return wrap;
  }

  // Settings + data panel. onChange() is called after data changes.
  function dataPanel(onChange) {
    const s = C.settings;
    const msg = el('div', { class: 'nw-msg' });
    const say = t => { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 4000); };
    const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const n = C.importJSON(await f.text()); say(`Imported ${n} readings`); onChange && onChange(); } catch (err) { say('That file could not be read'); }
      file.value = '';
    } });
    let confirmClear = false;
    const clearBtn = el('button', { type: 'button', class: 'nw-btn danger', onclick: () => {
      if (!confirmClear) { confirmClear = true; clearBtn.textContent = 'Tap again to erase everything'; setTimeout(() => { confirmClear = false; clearBtn.textContent = 'Erase all readings'; }, 3500); return; }
      C.clearAll(); confirmClear = false; clearBtn.textContent = 'Erase all readings'; say('All readings erased'); onChange && onChange();
    } }, 'Erase all readings');
    const demoBtn = el('button', { type: 'button', class: 'nw-btn', onclick: () => {
      if (C.hasDemo()) { C.clearDemo(); demoBtn.textContent = 'Load demo walk (Roseau)'; say('Demo readings removed'); }
      else { const n = C.demo(); demoBtn.textContent = 'Remove demo readings'; say(`Added ${n} pretend readings over 3 days`); }
      onChange && onChange();
    } }, C.hasDemo() ? 'Remove demo readings' : 'Load demo walk (Roseau)');
    const real = () => C.samples().filter(x => !x.demo).length;
    const count = el('div', { class: 'nw-small' });
    const refresh = () => { count.textContent = `${real()} real readings saved on this phone · ${fmt.mb(C.usage())} of data used today`; };
    refresh(); C.on('sample', refresh); C.on('data', refresh);

    return el('div', { class: 'nw-panel' },
      el('h3', {}, 'How often to test'),
      seg([[5, '5 s'], [10, '10 s'], [20, '20 s'], [30, '30 s']], s.interval, v => C.setSettings({ interval: v })),
      el('h3', {}, 'Download speed test'),
      seg([[0, 'Off'], [60, 'Every 1 min'], [120, 'Every 2 min'], [300, 'Every 5 min']], s.speedEvery, v => C.setSettings({ speedEvery: v })),
      el('div', { class: 'nw-small' }, 'Pings use almost no data. Each speed test uses 0.25–1 MB, so every 1 min ≈ 15–60 MB per hour of walking.'),
      el('h3', {}, 'Your readings'), count,
      el('div', { class: 'nw-row' },
        el('button', { type: 'button', class: 'nw-btn', onclick: () => C.download(`netwalk-${C.dayKey(Date.now())}.json`, C.exportJSON()) }, 'Save backup (.json)'),
        el('button', { type: 'button', class: 'nw-btn', onclick: () => C.download(`netwalk-${C.dayKey(Date.now())}.csv`, C.exportCSV(), 'text/csv') }, 'Export spreadsheet (.csv)'),
        el('button', { type: 'button', class: 'nw-btn', onclick: () => file.click() }, 'Import backup'),
        demoBtn, clearBtn, file),
      msg,
      el('div', { class: 'nw-small' }, 'Readings are kept on this phone only, and are shared between all three versions of the app. Keep the screen on while walking: iPhone pauses web pages when the screen locks.')
    );
  }

  const css = `
  .nw-seg{display:flex;gap:4px;background:var(--seg-bg,#0000000f);border-radius:10px;padding:3px}
  .nw-seg button{flex:1;border:0;background:transparent;padding:8px 4px;border-radius:8px;font:600 13px/1 inherit;color:inherit;opacity:.7}
  .nw-seg button.on{background:var(--seg-on,#fff);opacity:1;box-shadow:0 1px 3px #0002}
  .nw-panel h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;opacity:.6;margin:18px 0 8px}
  .nw-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .nw-btn{border:1px solid var(--line,#0002);background:var(--btn-bg,#fff);color:inherit;border-radius:10px;padding:10px 12px;font:600 14px inherit}
  .nw-btn.danger{color:#d8314a}
  .nw-small{font-size:12.5px;opacity:.65;margin-top:8px;line-height:1.4}
  .nw-msg{font-size:13px;font-weight:600;margin-top:8px;min-height:1em;color:#12a37f}
  .leaflet-popup-content{font:13px/1.45 -apple-system,system-ui,sans-serif;margin:10px 12px}
  .leaflet-popup-content b{font-size:14px}`;
  document.head.append(el('style', {}, css));

  function zonePopup(z) {
    const b = C.band(z.value);
    return `<b style="color:${b.color}">${b.label}</b> · score ${z.value ?? '—'}<br>` +
      `Speed: ${fmt.mbps(z.dl)} · Ping: ${fmt.ms(z.rtt)}<br>` +
      `Connected ${z.uptime}% of the time<br>` +
      `<span style="opacity:.6">${z.n} readings over ${z.days} day${z.days > 1 ? 's' : ''}</span>`;
  }

  window.NetUI = { fmt, el, seg, dataPanel, zonePopup };
})();
