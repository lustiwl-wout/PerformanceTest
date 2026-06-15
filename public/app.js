'use strict';

/* ============================================================
 * Proxy Performance Tester - client logic
 * Measures latency, throughput and connection setup so you can
 * compare a run made *through* a proxy (Zscaler) with a direct run.
 * ========================================================== */

const $ = (id) => document.getElementById(id);
const MB = 1024 * 1024;

// Latest results, used by "Save snapshot" and the summary.
const state = { latency: null, download: null, upload: null, conn: null, proxy: null };

/* ---------- helpers ---------- */

function log(msg) {
  const el = $('log');
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function fmt(n, digits = 1) {
  if (n == null || !isFinite(n)) return '–';
  return Number(n).toFixed(digits);
}

function fmtBytes(b) {
  if (b == null) return '–';
  if (b >= MB) return (b / MB).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function cacheBust(url) {
  return url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function setProgress(label, frac) {
  const wrap = $('progressWrap');
  if (frac == null) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('progressLabel').textContent = label;
  $('progressFill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll('button[data-test], #runAll').forEach((b) => { b.disabled = disabled; });
}

/* ---------- sourced thresholds ----------
 * TTFB bands       -> web.dev:  https://web.dev/articles/ttfb
 *                     good <=800ms, needs-improvement <=1800ms, else poor.
 *                     (Targets full-page navigation TTFB; used here as an
 *                      absolute backstop.)
 * Proxy overhead   -> Zscaler ZIA Latency SLA: <=100ms at the 95th percentile
 *                     for proxy processing. https://www.zscaler.com/legal/sla-support
 *                     Applied to the *added* latency (delta vs a direct baseline).
 */
function gradeTtfb(ms) {
  if (ms == null || !isFinite(ms)) return '';
  if (ms <= 800) return 'grade-good';
  if (ms <= 1800) return 'grade-ni';
  return 'grade-poor';
}
function gradeOverhead(deltaMs) {
  if (deltaMs == null || !isFinite(deltaMs)) return '';
  return deltaMs <= 100 ? 'grade-good' : 'grade-poor';
}

/* ---------- statistics ---------- */

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = (p) => s[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean,
    median: pct(50),
    p95: pct(95),
    jitter: Math.sqrt(variance), // standard deviation
    samples,
  };
}

/* ---------- Resource Timing helpers ---------- */

function timingFor(url) {
  const entries = performance.getEntriesByName(url);
  const e = entries[entries.length - 1];
  if (!e) return null;
  const has = (x) => typeof x === 'number' && x > 0;
  return {
    dns: has(e.domainLookupEnd) ? e.domainLookupEnd - e.domainLookupStart : 0,
    tcp: has(e.connectEnd) && has(e.connectStart) ? e.connectEnd - e.connectStart : 0,
    tls: has(e.secureConnectionStart) ? e.connectEnd - e.secureConnectionStart : 0,
    ttfb: has(e.responseStart) ? e.responseStart - e.requestStart : 0,
    hadConnection: has(e.connectStart) && e.connectEnd > e.connectStart,
  };
}

/* ============================================================
 * Tests
 * ========================================================== */

async function pingOnce() {
  const url = cacheBust('/api/ping');
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  await res.json();
  const rtt = performance.now() - t0;
  return { rtt, url };
}

async function runLatency() {
  const count = parseInt($('pingCount').value, 10) || 25;
  log(`Latency: ${count} pings…`);
  const samples = [];
  let connBreakdown = null;

  // Warm-up ping (discarded) — covers cold start / first connection.
  await pingOnce();

  for (let i = 0; i < count; i++) {
    const { rtt, url } = await pingOnce();
    samples.push(rtt);
    // Capture connection-setup timing from any request that opened a socket.
    const t = timingFor(url);
    if (t && t.hadConnection && !connBreakdown) connBreakdown = t;
    setProgress(`Latency ${i + 1}/${count}`, (i + 1) / count);
  }

  const stats = summarize(samples);
  state.latency = stats;
  renderLatency(stats);
  if (connBreakdown) maybeUpdateConnFromTiming(connBreakdown);
  log(`Latency: median ${fmt(stats.median)} ms, jitter ${fmt(stats.jitter)} ms`);
  return stats;
}

async function runDownload() {
  const mb = parseInt($('downloadMb').value, 10) || 25;
  const bytes = mb * MB;
  log(`Download: ${mb} MB…`);
  const url = cacheBust('/api/download?bytes=' + bytes);

  const t0 = performance.now();
  let firstByteAt = null;
  let received = 0;

  const res = await fetch(url, { cache: 'no-store' });
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = performance.now();
    received += value.length;
    setProgress(`Download ${fmtBytes(received)} / ${fmtBytes(bytes)}`, received / bytes);
  }
  const end = performance.now();

  const ttfb = (firstByteAt ?? end) - t0;
  const transferMs = end - (firstByteAt ?? t0);
  const mbps = (received * 8) / (transferMs / 1000) / 1e6; // sustained, first->last byte
  const result = {
    bytes: received, ttfbMs: ttfb, transferMs,
    mbps, MBps: received / MB / (transferMs / 1000),
  };
  state.download = result;
  renderDownload(result);
  log(`Download: ${fmt(mbps)} Mbit/s (TTFB ${fmt(ttfb)} ms)`);
  return result;
}

function makeRandomBlob(size) {
  // Incompressible payload so the proxy can't gzip it away.
  const buf = new Uint8Array(size);
  const MAXCHUNK = 65536; // crypto.getRandomValues limit
  for (let off = 0; off < size; off += MAXCHUNK) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + MAXCHUNK, size)));
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

function runUpload() {
  const mb = parseInt($('uploadMb').value, 10) || 10;
  const bytes = mb * MB;
  log(`Upload: ${mb} MB…`);
  setProgress('Preparing upload…', 0);
  const blob = makeRandomBlob(bytes);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', cacheBust('/api/upload'));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    let t0 = null;
    xhr.upload.onloadstart = () => { t0 = performance.now(); };
    xhr.upload.onprogress = (e) => {
      if (t0 === null) t0 = performance.now();
      setProgress(`Upload ${fmtBytes(e.loaded)} / ${fmtBytes(bytes)}`, e.total ? e.loaded / e.total : 0);
    };
    xhr.onload = () => {
      const end = performance.now();
      const totalMs = end - (t0 ?? end);
      const mbps = (bytes * 8) / (totalMs / 1000) / 1e6;
      let server = {};
      try { server = JSON.parse(xhr.responseText); } catch (_) {}
      const result = { bytes, totalMs, mbps, MBps: bytes / MB / (totalMs / 1000), server };
      state.upload = result;
      renderUpload(result);
      log(`Upload: ${fmt(mbps)} Mbit/s`);
      resolve(result);
    };
    xhr.onerror = () => { log('Upload: error'); reject(new Error('upload failed')); };
    xhr.send(blob);
  });
}

async function runConnInfo() {
  log('Checking connection/proxy…');
  const res = await fetch(cacheBust('/api/headers'), { cache: 'no-store' });
  const data = await res.json();
  state.proxy = data;
  renderProxy(data);
  // Page-load navigation timing gives a genuine cold-connection breakdown
  // (incl. the real TLS handshake through the proxy).
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    maybeUpdateConnFromTiming({
      dns: nav.domainLookupEnd - nav.domainLookupStart,
      tcp: nav.connectEnd - nav.connectStart,
      tls: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
      ttfb: nav.responseStart - nav.requestStart,
    }, true);
  }
  return data;
}

/* ============================================================
 * Rendering
 * ========================================================== */

function renderLatency(s) {
  $('lat-median').textContent = fmt(s.median);
  $('lat-min').textContent = fmt(s.min);
  $('lat-avg').textContent = fmt(s.mean);
  $('lat-p95').textContent = fmt(s.p95);
  $('lat-max').textContent = fmt(s.max);
  $('lat-jit').textContent = fmt(s.jitter);
  drawSparkline($('lat-spark'), s.samples);
}

function renderDownload(r) {
  $('dl-mbps').textContent = fmt(r.mbps);
  const dlTtfb = $('dl-ttfb');
  dlTtfb.textContent = fmt(r.ttfbMs) + ' ms';
  dlTtfb.className = gradeTtfb(r.ttfbMs); // web.dev bands
  $('dl-size').textContent = fmtBytes(r.bytes);
  $('dl-time').textContent = fmt(r.transferMs) + ' ms';
  $('dl-mbs').textContent = fmt(r.MBps) + ' MB/s';
}

function renderUpload(r) {
  $('ul-mbps').textContent = fmt(r.mbps);
  $('ul-size').textContent = fmtBytes(r.bytes);
  $('ul-time').textContent = fmt(r.totalMs) + ' ms';
  $('ul-mbs').textContent = fmt(r.MBps) + ' MB/s';
  $('ul-srv').textContent = r.server && r.server.serverDurationMs != null ? fmt(r.server.serverDurationMs) + ' ms' : '–';
}

// Keep the largest seen TLS/connection breakdown (the real cold-connection one).
function maybeUpdateConnFromTiming(t, force = false) {
  if (!state.conn || force || (t.tls || 0) > (state.conn.tls || 0)) {
    state.conn = { ...state.conn, ...t };
    renderConn(state.conn);
  }
}

function renderConn(t) {
  const max = Math.max(t.dns || 0, t.tcp || 0, t.tls || 0, t.ttfb || 0, 1);
  const set = (barId, valId, v) => {
    $(barId).style.width = ((v || 0) / max * 100) + '%';
    $(valId).textContent = v != null ? fmt(v) + ' ms' : '–';
  };
  set('bar-dns', 'val-dns', t.dns);
  set('bar-tcp', 'val-tcp', t.tcp);
  set('bar-tls', 'val-tls', t.tls);
  set('bar-ttfb', 'val-ttfb', t.ttfb);
  $('val-ttfb').className = gradeTtfb(t.ttfb); // web.dev bands
}

const PROXY_PATTERNS = /^(via|forwarded|x-forwarded-|x-real-ip|x-client-ip|proxy-|x-zscaler|zscaler|x-bluecoat|x-cache|x-cache-lookup|cf-connecting-ip|client-ip|x-forwarded-server|x-sinkhole)/i;

function renderProxy(data) {
  const headers = data.headers || {};
  const proxyHeaders = Object.keys(headers).filter((k) => PROXY_PATTERNS.test(k));
  const verdict = $('proxy-verdict');

  if (proxyHeaders.length > 0) {
    verdict.className = 'verdict verdict-proxy';
    verdict.textContent = `⚠ Proxy/forwarding detected — ${proxyHeaders.length} suspicious header(s). Traffic is likely passing through an intermediate proxy.`;
  } else {
    verdict.className = 'verdict verdict-direct';
    verdict.textContent = '✓ No typical proxy headers seen at the server. (Note: Render itself also sits behind a load balancer.)';
  }

  const kv = $('proxy-kv');
  kv.innerHTML = '';
  const rows = [
    ['Client IP (as seen by server)', data.ip],
    ['IP chain', (data.ips && data.ips.length) ? data.ips.join(' → ') : '(empty)'],
    ['HTTP version', data.httpVersion],
    ['Protocol', data.protocol],
    ['User-Agent', headers['user-agent']],
    ['Server region', data.region || '(unknown)'],
  ];
  for (const [k, v] of rows) addKv(kv, k, v ?? '–', false);
  for (const h of proxyHeaders) addKv(kv, h, headers[h], true);

  $('proxy-headers').textContent = JSON.stringify(headers, null, 2);
}

function addKv(container, k, v, flag) {
  const row = document.createElement('div');
  row.className = 'row' + (flag ? ' flag' : '');
  row.innerHTML = `<span class="k"></span><span class="v"></span>`;
  row.querySelector('.k').textContent = k;
  row.querySelector('.v').textContent = v;
  container.appendChild(row);
}

function drawSparkline(canvas, data) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!data.length) return;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const pad = 6;
  const x = (i) => pad + (i / (data.length - 1 || 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - min) / range) * (H - 2 * pad);

  // area
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(79,157,255,.12)';
  ctx.fill();

  // line
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#4f9dff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ============================================================
 * Summary / interpretation (heuristic, never a hard verdict)
 * ========================================================== */

function renderSummary() {
  const ul = $('summaryList');
  ul.innerHTML = '';
  const items = [];
  const add = (level, text) => items.push({ level, text });

  if (state.conn && state.conn.tls != null) {
    const tls = state.conn.tls;
    if (tls > 150) add('bad', `TLS handshake takes ${fmt(tls)} ms — strongly elevated, typical of SSL inspection by a proxy.`);
    else if (tls > 60) add('warn', `TLS handshake ${fmt(tls)} ms — slightly elevated; may indicate interception.`);
    else if (tls > 0) add('good', `TLS handshake ${fmt(tls)} ms — normal, no clear inspection overhead.`);
  }

  if (state.latency) {
    const { median, jitter } = state.latency;
    add('good', `Median latency ${fmt(median)} ms.`);
    if (jitter > median * 0.5 && jitter > 15) add('warn', `High jitter (${fmt(jitter)} ms) — variable proxy/queueing delay.`);
  }

  if (state.download) {
    const cls = state.download.ttfbMs > 800 ? 'warn' : 'good';
    add(cls, `Download ${fmt(state.download.mbps)} Mbit/s, TTFB ${fmt(state.download.ttfbMs)} ms (web.dev: ≤800 ms good).`);
  }
  if (state.upload) {
    add('good', `Upload ${fmt(state.upload.mbps)} Mbit/s.`);
  }

  if (state.proxy) {
    const hdrs = Object.keys(state.proxy.headers || {}).filter((k) => PROXY_PATTERNS.test(k));
    if (hdrs.length) add('warn', `Proxy headers present: ${hdrs.join(', ')}.`);
  }

  add('good', 'Tip: save this run, mark a direct (un-proxied) run as ◎ baseline, then the Δ shows the proxy overhead vs Zscaler\'s ≤100 ms p95 SLA.');

  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.level;
    li.textContent = it.text;
    ul.appendChild(li);
  }
  $('summaryPanel').hidden = false;
}

/* ============================================================
 * Snapshots (localStorage) for with-proxy vs without-proxy
 * ========================================================== */

const SNAP_KEY = 'pptester.snapshots.v1';
const BASE_KEY = 'pptester.baselineTs.v1';

function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; }
  catch (_) { return []; }
}
function saveSnapshots(list) {
  localStorage.setItem(SNAP_KEY, JSON.stringify(list));
}
function getBaselineTs() { return localStorage.getItem(BASE_KEY); }
function setBaselineTs(ts) {
  if (ts == null) localStorage.removeItem(BASE_KEY);
  else localStorage.setItem(BASE_KEY, String(ts));
}

function currentSnapshot(label) {
  return {
    label,
    ts: Date.now(),
    latency: state.latency ? { median: state.latency.median, jitter: state.latency.jitter } : null,
    download: state.download ? state.download.mbps : null,
    upload: state.upload ? state.upload.mbps : null,
    ttfb: state.download ? state.download.ttfbMs : null,
    tls: state.conn ? state.conn.tls : null,
  };
}

function appendCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

// Cell that shows a value plus, when a baseline is set, the colored delta
// (proxy overhead) graded against Zscaler's 100 ms p95 SLA.
function appendMetricCell(tr, value, baseValue, valueGradeCls) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.textContent = value != null ? fmt(value) : '–';
  if (valueGradeCls) span.className = valueGradeCls;
  td.appendChild(span);
  if (value != null && baseValue != null) {
    const delta = value - baseValue;
    const d = document.createElement('span');
    d.className = 'delta ' + gradeOverhead(delta);
    const sign = delta >= 0 ? '+' : '−';
    d.textContent = ` Δ${sign}${fmt(Math.abs(delta))}`;
    d.title = 'Added vs baseline — graded against Zscaler ≤100 ms p95 SLA';
    td.appendChild(d);
  }
  tr.appendChild(td);
}

function renderSnapshots() {
  const list = loadSnapshots();
  const body = $('snapBody');
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = '<tr class="empty"><td colspan="9">No snapshots saved yet.</td></tr>';
    return;
  }

  const baseTs = getBaselineTs();
  const baseline = list.find((s) => String(s.ts) === String(baseTs)) || null;

  list.forEach((s, i) => {
    const isBase = !!(baseline && String(s.ts) === String(baseline.ts));
    const cmp = baseline && !isBase ? baseline : null; // compare this row against baseline
    const tr = document.createElement('tr');
    if (isBase) tr.className = 'baseline-row';

    // Label (+ baseline tag)
    const tdLabel = document.createElement('td');
    tdLabel.textContent = s.label;
    if (isBase) {
      const tag = document.createElement('span');
      tag.className = 'baseline-tag';
      tag.textContent = 'baseline';
      tdLabel.appendChild(tag);
    }
    tr.appendChild(tdLabel);

    appendCell(tr, new Date(s.ts).toLocaleString());
    appendMetricCell(tr, s.latency ? s.latency.median : null, cmp && cmp.latency ? cmp.latency.median : null);
    appendCell(tr, s.latency ? fmt(s.latency.jitter) : '–');
    appendCell(tr, fmt(s.download));
    appendCell(tr, fmt(s.upload));
    appendMetricCell(tr, s.ttfb, cmp ? cmp.ttfb : null, gradeTtfb(s.ttfb));
    appendCell(tr, s.tls != null ? fmt(s.tls) : '–');

    // Actions: baseline / rename / delete
    const tdActions = document.createElement('td');
    tdActions.className = 'snap-actions';

    const baseBtn = document.createElement('button');
    baseBtn.className = 'snap-base' + (isBase ? ' active' : '');
    baseBtn.textContent = '◎';
    baseBtn.title = isBase ? 'Unset baseline' : 'Set as direct baseline';
    baseBtn.onclick = () => { setBaselineTs(isBase ? null : s.ts); renderSnapshots(); };

    const editBtn = document.createElement('button');
    editBtn.className = 'snap-edit'; editBtn.textContent = '✎'; editBtn.title = 'Rename';
    editBtn.onclick = () => {
      const l = loadSnapshots();
      if (!l[i]) return;
      const name = prompt('New label for this snapshot:', l[i].label);
      if (name == null) return;            // cancelled
      const trimmed = name.trim();
      if (!trimmed) return;                // empty -> keep old label
      l[i].label = trimmed;
      saveSnapshots(l);
      renderSnapshots();
      log('Snapshot renamed to: ' + trimmed);
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'snap-del'; delBtn.textContent = '✕'; delBtn.title = 'Delete';
    delBtn.onclick = () => {
      const l = loadSnapshots();
      const removed = l.splice(i, 1)[0];
      saveSnapshots(l);
      if (removed && String(removed.ts) === String(getBaselineTs())) setBaselineTs(null);
      renderSnapshots();
    };

    tdActions.appendChild(baseBtn);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
}

/* ============================================================
 * Orchestration & wiring
 * ========================================================== */

async function runAll() {
  setButtonsDisabled(true);
  try {
    await runConnInfo();
    await runLatency();
    await runDownload();
    await runUpload();
    renderSummary();
    $('saveSnapshot').disabled = false;
    log('All tests done.');
  } catch (err) {
    log('Error: ' + (err && err.message ? err.message : err));
  } finally {
    setProgress(null);
    setButtonsDisabled(false);
  }
}

async function runSingle(test) {
  setButtonsDisabled(true);
  try {
    if (test === 'latency') await runLatency();
    else if (test === 'download') await runDownload();
    else if (test === 'upload') await runUpload();
    else if (test === 'conn' || test === 'proxy') await runConnInfo();
    $('saveSnapshot').disabled = false;
  } catch (err) {
    log('Error: ' + (err && err.message ? err.message : err));
  } finally {
    setProgress(null);
    setButtonsDisabled(false);
  }
}

async function init() {
  // Server info + warm up the instance.
  try {
    const res = await fetch(cacheBust('/api/info'), { cache: 'no-store' });
    const info = await res.json();
    $('connDot').className = 'dot ok';
    $('connText').textContent = 'connected';
    $('serverInfo').textContent = `${info.nodeVersion} · region ${info.region || '?'} · uptime ${info.uptimeSec}s`;
    log('Connected to server.');
  } catch (_) {
    $('connDot').className = 'dot err';
    $('connText').textContent = 'no connection';
    log('Could not reach server.');
  }

  // Wire up controls.
  $('runAll').onclick = runAll;
  document.querySelectorAll('button[data-test]').forEach((b) => {
    b.onclick = () => runSingle(b.dataset.test);
  });
  $('saveSnapshot').onclick = () => {
    const label = prompt('Label for this snapshot (e.g. "With Zscaler" or "Direct"):', 'With proxy');
    if (!label) return;
    const list = loadSnapshots();
    list.push(currentSnapshot(label));
    saveSnapshots(list);
    renderSnapshots();
    log('Snapshot saved: ' + label);
  };
  $('clearSnapshots').onclick = () => {
    if (confirm('Delete all snapshots?')) { saveSnapshots([]); setBaselineTs(null); renderSnapshots(); }
  };

  // Initial proxy/connection read so the dashboard isn't empty.
  runConnInfo().catch(() => {});
  renderSnapshots();
}

document.addEventListener('DOMContentLoaded', init);
