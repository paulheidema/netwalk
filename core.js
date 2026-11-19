/* NetWalk core — shared measurement engine for all three versions.
   Measures what a browser on iPhone CAN measure: latency (ping), jitter,
   packet loss (failed requests) and download speed, tags each reading with
   GPS, stores it on the phone, and bins readings into map zones. */
(function () {
  'use strict';
  const KEY = 'netwalk.samples.v1';
  const SKEY = 'netwalk.settings.v1';
  const UKEY = 'netwalk.usage.v1';
  const WKEY = 'netwalk.walk.v1';
  const ROSEAU = [15.3017, -61.3881];

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  // ---- scoring (0–100) ----
  const latScore = rtt => rtt == null ? 0 : clamp(100 - (Math.log10(Math.max(rtt, 1)) - Math.log10(50)) / (Math.log10(1500) - Math.log10(50)) * 100);
  const speedScore = dl => dl == null ? null : clamp((Math.log10(Math.max(dl, 0.01)) - Math.log10(0.3)) / (Math.log10(30) - Math.log10(0.3)) * 100);
  const jitScore = j => j == null ? 50 : clamp(100 - j / 3);
  function scoreOf(s) {
    if (s.loss >= 1) return { score: 0, relScore: 0 };
    const L = latScore(s.rtt), R = (1 - s.loss) * 100, J = jitScore(s.jit);
    const S = speedScore(s.dlEst);
    const score = S == null ? 0.6 * L + 0.25 * R + 0.15 * J : 0.4 * S + 0.3 * L + 0.2 * R + 0.1 * J;
    return { score: Math.round(score), relScore: Math.round(0.75 * R + 0.25 * J) };
  }

  const BANDS = [
    { min: 80, label: 'Excellent', color: '#12a37f' },
    { min: 60, label: 'Good', color: '#7cc142' },
    { min: 40, label: 'Fair', color: '#f2c12e' },
    { min: 20, label: 'Poor', color: '#f2792e' },
    { min: 0, label: 'Dead zone', color: '#d8314a' }
  ];
  const band = v => BANDS.find(b => (v ?? 0) >= b.min);

  // ---- state ----
  const listeners = {};
  const emit = (e, d) => (listeners[e] || []).forEach(f => { try { f(d); } catch (err) { console.error(err); } });
  const state = {
    running: false, pos: null, posErr: null, lastDl: null, lastDlAt: 0, cycle: 0,
    pings: [], // rolling {t, ok, rtt}
    last: null, timer: null, watchId: null, wake: null, dlSize: 262144
  };
  let samples = ls.get(KEY, []);
  const settings = Object.assign({ interval: 10, speedEvery: 60 }, ls.get(SKEY, {}));

  function usage() { const u = ls.get(UKEY, {}); return u[dayKey(Date.now())] || 0; }
  function addUsage(bytes) { const u = ls.get(UKEY, {}); const k = dayKey(Date.now()); u[k] = (u[k] || 0) + bytes; ls.set(UKEY, u); }

  function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ---- network tests (same-origin files, so no CORS issues) ----
  const base = (() => { const s = document.currentScript && document.currentScript.src; return s ? s.replace(/core\.js.*$/, '') : './'; })();
  async function timedFetch(url, timeout) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeout);
    const t0 = performance.now();
    try {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'r=' + Math.random().toString(36).slice(2), { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      return { ok: true, ms: performance.now() - t0, bytes: buf.byteLength };
    } catch (e) { return { ok: false, ms: performance.now() - t0, bytes: 0 }; }
    finally { clearTimeout(to); }
  }

  async function pingBurst(n = 3) {
    const res = [];
    for (let i = 0; i < n; i++) {
      const r = await timedFetch(base + 'ping.txt', 4000);
      res.push(r); state.pings.push({ t: Date.now(), ok: r.ok, rtt: r.ok ? r.ms : null });
      addUsage(r.ok ? 700 : 300);
    }
    if (state.pings.length > 60) state.pings.splice(0, state.pings.length - 60);
    const ok = res.filter(r => r.ok).map(r => r.ms);
    let jit = null;
    if (ok.length > 1) { const d = []; for (let i = 1; i < ok.length; i++) d.push(Math.abs(ok[i] - ok[i - 1])); jit = mean(d); }
    return { rtt: median(ok), jit, loss: (n - ok.length) / n };
  }

  async function speedTest(rtt) {
    const file = state.dlSize >= 1048576 ? 'dl/1m.bin' : 'dl/256k.bin';
    const r = await timedFetch(base + file, 20000);
    if (!r.ok) return null;
    addUsage(r.bytes + 500);
    const secs = Math.max((r.ms - (rtt || 0)) / 1000, 0.02);
    const mbps = r.bytes * 8 / secs / 1e6;
    state.dlSize = secs < 0.6 ? 1048576 : 262144; // go bigger only when fast
    return Math.round(mbps * 100) / 100;
  }

  async function cycle() {
    if (!state.running) return;
    state.cycle++;
    const p = await pingBurst(3);
    let dl = null;
    const now = Date.now();
    if (settings.speedEvery > 0 && p.loss < 1 && (now - state.lastDlAt) / 1000 >= settings.speedEvery - 1) {
      emit('status', 'Testing download speed…');
      dl = await speedTest(p.rtt);
      state.lastDlAt = Date.now();
      if (dl != null) state.lastDl = dl;
    }
    const dlEst = dl != null ? dl : (Date.now() - state.lastDlAt < 150000 ? state.lastDl : null);
    const pos = state.pos && (Date.now() - state.pos.t < 30000) ? state.pos : null;
    const conn = navigator.connection || {};
    const s = {
      t: Date.now(),
      lat: pos ? +pos.lat.toFixed(6) : null, lon: pos ? +pos.lon.toFixed(6) : null, acc: pos ? Math.round(pos.acc) : null,
      rtt: p.rtt != null ? Math.round(p.rtt) : null, jit: p.jit != null ? Math.round(p.jit) : null, loss: +p.loss.toFixed(2),
      dl, dlEst, net: conn.effectiveType || null
    };
    Object.assign(s, scoreOf(s));
    delete s.dlEst;
    s.speedScore = dlEst != null ? Math.round(speedScore(dlEst)) : null;
    samples.push(s); ls.set(KEY, samples);
    state.last = s;
    { const w = ls.get(WKEY, null); if (w && w.active) { w.seen = s.t; ls.set(WKEY, w); } }
    emit('sample', s); emit('status', p.loss >= 1 ? 'No connection' : 'Measuring');
    if (state.running) state.timer = setTimeout(cycle, settings.interval * 1000);
  }

  // ---- location ----
  function startGeo() {
    if (!('geolocation' in navigator)) { state.posErr = 'Location not supported'; emit('position', null); return; }
    state.watchId = navigator.geolocation.watchPosition(
      p => { state.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; state.posErr = null; emit('position', state.pos); },
      e => { state.posErr = e.code === 1 ? 'Location permission denied — allow it in Settings › Safari › Location' : 'Waiting for GPS…'; emit('position', null); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  async function wake() {
    try { if ('wakeLock' in navigator) state.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.running) { wake(); clearTimeout(state.timer); state.timer = setTimeout(cycle, 300); } });

  // ---- zones: hexagon bins ----
  const M_PER_DEG = 111320;
  function hexZones(list, sizeM = 45, metric = 'overall') {
    const pts = list.filter(s => s.lat != null && (s.acc == null || s.acc <= 80));
    if (!pts.length) return [];
    const lat0 = pts[0].lat, k = Math.cos(lat0 * Math.PI / 180);
    const toXY = (lat, lon) => [lon * M_PER_DEG * k, lat * M_PER_DEG];
    const toLL = (x, y) => [y / M_PER_DEG, x / (M_PER_DEG * k)];
    const S3 = Math.sqrt(3);
    const bins = new Map();
    for (const s of pts) {
      const [x, y] = toXY(s.lat, s.lon);
      let q = (S3 / 3 * x - y / 3) / sizeM, r = (2 / 3 * y) / sizeM;
      // cube round
      let cx = q, cz = r, cy = -cx - cz;
      let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
      const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
      if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
      const key = rx + ',' + rz;
      if (!bins.has(key)) bins.set(key, { q: rx, r: rz, items: [] });
      bins.get(key).items.push(s);
    }
    const out = [];
    for (const b of bins.values()) {
      const cxm = sizeM * S3 * (b.q + b.r / 2), cym = sizeM * 1.5 * b.r;
      const corners = [];
      for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); corners.push(toLL(cxm + sizeM * Math.cos(a), cym + sizeM * Math.sin(a))); }
      out.push(Object.assign({ center: toLL(cxm, cym), corners }, summarize(b.items, metric)));
    }
    return out;
  }

  function summarize(items, metric = 'overall') {
    const dls = items.map(s => s.dl).filter(v => v != null);
    const rtts = items.map(s => s.rtt).filter(v => v != null);
    const sp = items.map(s => s.speedScore).filter(v => v != null);
    const r = {
      n: items.length,
      score: Math.round(median(items.map(s => s.score))),
      rel: Math.round(mean(items.map(s => s.relScore))),
      uptime: Math.round(mean(items.map(s => 1 - s.loss)) * 100),
      dl: dls.length ? Math.round(median(dls) * 10) / 10 : null,
      rtt: rtts.length ? Math.round(median(rtts)) : null,
      speed: sp.length ? Math.round(median(sp)) : null,
      first: Math.min(...items.map(s => s.t)), last: Math.max(...items.map(s => s.t)),
      days: new Set(items.map(s => dayKey(s.t))).size
    };
    r.value = metric === 'speed' ? r.speed : metric === 'reliability' ? r.rel : r.score;
    r.confidence = Math.min(1, r.n / 12);
    return r;
  }

  function filterRange(list, range) {
    const today = dayKey(Date.now());
    if (range === 'today') return list.filter(s => dayKey(s.t) === today);
    if (range === 'yesterday') { const y = dayKey(Date.now() - 864e5); return list.filter(s => dayKey(s.t) === y); }
    if (range === '3d') return list.filter(s => s.t > Date.now() - 3 * 864e5);
    if (range === '7d') return list.filter(s => s.t > Date.now() - 7 * 864e5);
    if (range && /^\d{4}-\d\d-\d\d$/.test(range)) return list.filter(s => dayKey(s.t) === range);
    return list;
  }

  function byDay(list) {
    const m = new Map();
    for (const s of list) { const k = dayKey(s.t); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, items]) => ({ day, items, ...summarize(items) }));
  }

  // ---- demo data around Roseau (clearly flagged, removable) ----
  function demo() {
    clearDemo();
    const towers = [[15.3005, -61.3870, 1.0, 600], [15.3130, -61.3760, 0.8, 500], [15.2900, -61.3700, 0.55, 450]];
    const holes = [[15.3060, -61.3800, 0.9, 220], [15.2960, -61.3790, 0.6, 180]];
    const quality = (lat, lon) => {
      const d = (a, b) => Math.hypot((lat - a) * M_PER_DEG, (lon - b) * M_PER_DEG * 0.965);
      let q = 0.08;
      for (const [a, b, w, r] of towers) q += w * Math.exp(-(d(a, b) ** 2) / (2 * r * r));
      for (const [a, b, w, r] of holes) q -= w * Math.exp(-(d(a, b) ** 2) / (2 * r * r));
      return clamp(q, 0, 1);
    };
    const walks = [
      [[15.3017, -61.3881], [15.3040, -61.3840], [15.3065, -61.3795], [15.3100, -61.3770], [15.3135, -61.3755]],
      [[15.3017, -61.3881], [15.2990, -61.3850], [15.2960, -61.3800], [15.2925, -61.3735], [15.2895, -61.3700]],
      [[15.2985, -61.3895], [15.3010, -61.3860], [15.3040, -61.3820], [15.3060, -61.3790], [15.3080, -61.3750]]
    ];
    const out = [];
    for (let day = 2; day >= 0; day--) {
      const walk = walks[day];
      let t = new Date(); t.setDate(t.getDate() - day); t.setHours(8 + day, 15, 0, 0); t = t.getTime();
      for (let pass = 0; pass < 2; pass++) {
        const path = pass ? [...walk].reverse() : walk;
        for (let i = 0; i < path.length - 1; i++) {
          for (let j = 0; j < 28; j++) {
            const f = j / 28;
            const lat = path[i][0] + (path[i + 1][0] - path[i][0]) * f + (Math.random() - 0.5) * 0.0004;
            const lon = path[i][1] + (path[i + 1][1] - path[i][1]) * f + (Math.random() - 0.5) * 0.0004;
            const q = clamp(quality(lat, lon) + (Math.random() - 0.5) * 0.15, 0, 1);
            const loss = q < 0.12 ? (Math.random() < 0.6 ? 1 : 0.67) : q < 0.3 ? (Math.random() < 0.3 ? 0.33 : 0) : 0;
            const rtt = loss >= 1 ? null : Math.round(45 + (1 - q) ** 2 * 900 + Math.random() * 30);
            const dl = j % 6 === 0 && loss < 1 ? Math.round((0.2 + q ** 1.6 * 38) * 10) / 10 : null;
            const s = { t, lat: +lat.toFixed(6), lon: +lon.toFixed(6), acc: 8 + Math.round(Math.random() * 12), rtt, jit: rtt ? Math.round(5 + (1 - q) * 120 * Math.random()) : null, loss, dl, dlEst: dl ?? (loss < 1 ? 0.2 + q ** 1.6 * 38 : null), net: null, demo: true };
            Object.assign(s, scoreOf(s)); s.speedScore = s.dlEst != null ? Math.round(speedScore(s.dlEst)) : null; delete s.dlEst;
            out.push(s); t += 10000;
          }
        }
      }
    }
    samples = samples.concat(out).sort((a, b) => a.t - b.t); ls.set(KEY, samples); emit('data');
    return out.length;
  }
  function clearDemo() { samples = samples.filter(s => !s.demo); ls.set(KEY, samples); emit('data'); }
  function clearAll() { samples = []; ls.set(KEY, samples); emit('data'); }
  const hasDemo = () => samples.some(s => s.demo);

  function exportJSON() { return JSON.stringify({ app: 'netwalk', version: 1, exported: new Date().toISOString(), samples: samples.filter(s => !s.demo) }); }
  function download(name, text, type = 'application/json') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportCSV() {
    const cols = ['t', 'lat', 'lon', 'acc', 'rtt', 'jit', 'loss', 'dl', 'score', 'relScore', 'speedScore', 'net'];
    return cols.join(',') + ',time\n' + samples.filter(s => !s.demo).map(s => cols.map(c => s[c] ?? '').join(',') + ',' + new Date(s.t).toISOString()).join('\n');
  }
  function importJSON(text) {
    const d = JSON.parse(text); const inc = Array.isArray(d) ? d : d.samples || [];
    const seen = new Set(samples.map(s => s.t)); let n = 0;
    for (const s of inc) if (s && s.t && !seen.has(s.t)) { samples.push(s); n++; }
    samples.sort((a, b) => a.t - b.t); ls.set(KEY, samples); emit('data'); return n;
  }

  function reliabilityNow() {
    const recent = state.pings.slice(-30);
    if (!recent.length) return null;
    return Math.round(recent.filter(p => p.ok).length / recent.length * 100);
  }

  window.NetCore = {
    ROSEAU, BANDS, band,
    on(e, f) { (listeners[e] = listeners[e] || []).push(f); },
    get state() { return state; },
    get settings() { return settings; },
    setSettings(o) { Object.assign(settings, o); ls.set(SKEY, settings); },
    start(resume) {
      if (state.running) return; state.running = true; startGeo(); wake();
      if (!resume) ls.set(WKEY, { start: Date.now(), dist: 0, active: true, seen: Date.now() });
      emit('status', resume ? 'Walk resumed' : 'Starting…'); emit('running', true); cycle();
    },
    stop() {
      state.running = false; clearTimeout(state.timer);
      const w = ls.get(WKEY, null); if (w) { w.active = false; w.end = Date.now(); ls.set(WKEY, w); }
      if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId); state.watchId = null;
      try { state.wake && state.wake.release(); } catch (e) { } state.wake = null;
      emit('status', 'Stopped'); emit('running', false);
    },
    walk: () => ls.get(WKEY, null),
    saveWalk(w) { ls.set(WKEY, w); },
    // Resume a walk that was running when the page was closed or reloaded (within 30 min).
    resumeIfActive() {
      const w = ls.get(WKEY, null);
      if (!w || !w.active) return false;
      if (Date.now() - (w.seen || w.start) > 30 * 60000) { w.active = false; w.end = w.seen; ls.set(WKEY, w); return false; }
      this.start(true); return true;
    },
    samples: () => samples, filterRange, byDay, hexZones, summarize, dayKey, reliabilityNow, usage,
    demo, clearDemo, clearAll, hasDemo, exportJSON, exportCSV, importJSON, download, median, mean
  };
})();
