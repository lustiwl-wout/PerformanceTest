'use strict';

/* ============================================================
 * Proxy Performance Tester - client logic
 * Absolute numbers are dominated by server distance, so the tool is built
 * around the DIFFERENCE between a run made *through* a proxy (Zscaler) and a
 * direct run. That delta is what isolates the proxy's cost.
 *
 * Snapshots live in PostgreSQL (the server needs DATABASE_URL). Without a
 * database, the tests still run but snapshots can't be saved or compared.
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
 * Rendering (absolute numbers — shown plainly, never colour-judged)
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
  $('dl-ttfb').textContent = fmt(r.ttfbMs) + ' ms';
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
}

const PROXY_PATTERNS = /^(via|forwarded|x-forwarded-|x-real-ip|x-client-ip|proxy-|x-zscaler|zscaler|x-bluecoat|x-cache|x-cache-lookup|cf-connecting-ip|client-ip|x-forwarded-server|x-sinkhole)/i;

let proxiedAutoset = false;

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

  // Pre-fill the with/without-proxy checkbox from detection, once (user can override).
  if (!proxiedAutoset) { $('proxied').checked = proxyHeaders.length > 0; proxiedAutoset = true; }

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

  ctx.beginPath();
  ctx.moveTo(x(0), H);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(79,157,255,.12)';
  ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#4f9dff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ============================================================
 * Summary — present raw numbers, push the user to the comparison
 * ========================================================== */

function renderSummary() {
  const ul = $('summaryList');
  ul.innerHTML = '';
  const items = [];
  const add = (level, text) => items.push({ level, text });

  add('warn', 'These are absolute numbers: they include the server\'s own latency and your distance to it, so on their own they do NOT reveal the proxy\'s cost.');

  if (state.latency) add('good', `Latency median ${fmt(state.latency.median)} ms · jitter ${fmt(state.latency.jitter)} ms.`);
  if (state.conn && state.conn.tls != null && state.conn.tls > 0) {
    add('good', `TLS handshake ${fmt(state.conn.tls)} ms — where SSL inspection adds cost (it also contains a round trip, so compare to isolate it).`);
  }
  if (state.download) add('good', `Download ${fmt(state.download.mbps)} Mbit/s · TTFB ${fmt(state.download.ttfbMs)} ms.`);
  if (state.upload) add('good', `Upload ${fmt(state.upload.mbps)} Mbit/s.`);

  if (state.proxy) {
    const hdrs = Object.keys(state.proxy.headers || {}).filter((k) => PROXY_PATTERNS.test(k));
    if (hdrs.length) add('warn', `Proxy headers present: ${hdrs.join(', ')}.`);
  }

  add('good', 'To measure the proxy: save this run, run again WITHOUT the proxy, mark the no-proxy run as ◎ baseline. The Δ in the table is then the proxy\'s impact.');

  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.level;
    li.textContent = it.text;
    ul.appendChild(li);
  }
  $('summaryPanel').hidden = false;
}

/* ============================================================
 * Snapshot storage — PostgreSQL only (the database is the source of truth)
 * ========================================================== */

const BASE_KEY = 'pptester.baselineId.v1'; // which snapshot id is the baseline (UI preference)

let storageMode = 'none';   // 'db' | 'none' (resolved in init())
let snapshotsCache = [];

function dbAvailable() { return storageMode === 'db'; }
function snapId(s) { return s.id; }

function getBaselineId() { return localStorage.getItem(BASE_KEY); }
function setBaselineId(id) {
  if (id == null) localStorage.removeItem(BASE_KEY);
  else localStorage.setItem(BASE_KEY, String(id));
}

async function listSnapshots() {
  if (!dbAvailable()) return [];
  const res = await fetch('/api/snapshots', { cache: 'no-store' });
  if (!res.ok) throw new Error('list ' + res.status);
  return res.json();
}

async function createSnapshotRecord(snap) {
  const res = await fetch('/api/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snap),
  });
  if (!res.ok) throw new Error('create ' + res.status);
  return res.json();
}

async function renameSnapshotRecord(id, label) {
  const res = await fetch('/api/snapshots/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('rename ' + res.status);
}

async function deleteSnapshotRecord(id) {
  const res = await fetch('/api/snapshots/' + id, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error('delete ' + res.status);
}

async function clearSnapshotRecords() {
  const res = await fetch('/api/snapshots', { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error('clear ' + res.status);
}

function currentSnapshot(label) {
  return {
    label,
    proxied: $('proxied').checked,
    latency: state.latency ? { median: state.latency.median, jitter: state.latency.jitter } : null,
    download: state.download ? state.download.mbps : null,
    upload: state.upload ? state.upload.mbps : null,
    ttfb: state.download ? state.download.ttfbMs : null,
    tls: state.conn ? state.conn.tls : null,
  };
}

/* ---------- rendering the snapshot table ---------- */

function appendCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

// Value cell that, when a baseline is set, shows the raw difference vs baseline.
//   unit 'ms'  -> latency-type difference in milliseconds.
//   unit 'pct' -> throughput difference as a percentage.
function appendMetricCell(tr, value, baseValue, unit) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.textContent = value != null ? fmt(value) : '–';
  td.appendChild(span);

  if (value != null && baseValue != null) {
    const d = document.createElement('span');
    d.className = 'delta delta-muted';
    if (unit === 'pct') {
      const pct = baseValue ? (value / baseValue - 1) * 100 : 0;
      d.textContent = ` Δ${pct >= 0 ? '+' : '−'}${fmt(Math.abs(pct))}%`;
    } else {
      const delta = value - baseValue;
      d.textContent = ` Δ${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))}`;
    }
    d.title = 'Difference vs baseline';
    td.appendChild(d);
  }
  tr.appendChild(td);
}

function appendProxyCell(tr, proxied) {
  const td = document.createElement('td');
  if (proxied === true) { td.innerHTML = '<span class="px-yes">✓ proxy</span>'; }
  else if (proxied === false) { td.innerHTML = '<span class="px-no">✗ direct</span>'; }
  else { td.textContent = '–'; }
  tr.appendChild(td);
}

function renderSnapshotList(list) {
  const body = $('snapBody');
  body.innerHTML = '';
  if (!dbAvailable()) {
    body.innerHTML = '<tr class="empty"><td colspan="10">No database connected — set DATABASE_URL to save and compare snapshots.</td></tr>';
    return;
  }
  if (!list.length) {
    body.innerHTML = '<tr class="empty"><td colspan="10">No snapshots saved yet.</td></tr>';
    return;
  }

  const baseId = getBaselineId();
  const baseline = list.find((s) => String(snapId(s)) === String(baseId)) || null;

  list.forEach((s) => {
    const id = snapId(s);
    const isBase = !!(baseline && String(id) === String(snapId(baseline)));
    const cmp = baseline && !isBase ? baseline : null;
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

    appendProxyCell(tr, s.proxied);
    appendCell(tr, new Date(s.ts).toLocaleString());
    appendMetricCell(tr, s.latency ? s.latency.median : null, cmp && cmp.latency ? cmp.latency.median : null, 'ms');
    appendCell(tr, s.latency ? fmt(s.latency.jitter) : '–');
    appendMetricCell(tr, s.download, cmp ? cmp.download : null, 'pct');
    appendMetricCell(tr, s.upload, cmp ? cmp.upload : null, 'pct');
    appendMetricCell(tr, s.ttfb, cmp ? cmp.ttfb : null, 'ms');
    appendMetricCell(tr, s.tls, cmp ? cmp.tls : null, 'ms');

    // Actions: baseline / rename / delete
    const tdActions = document.createElement('td');
    tdActions.className = 'snap-actions';

    const baseBtn = document.createElement('button');
    baseBtn.className = 'snap-base' + (isBase ? ' active' : '');
    baseBtn.textContent = '◎';
    baseBtn.title = isBase ? 'Unset baseline' : 'Set as direct (no-proxy) baseline';
    baseBtn.onclick = () => { setBaselineId(isBase ? null : id); renderSnapshotList(snapshotsCache); };

    const editBtn = document.createElement('button');
    editBtn.className = 'snap-edit'; editBtn.textContent = '✎'; editBtn.title = 'Rename';
    editBtn.onclick = async () => {
      const name = prompt('New label for this snapshot:', s.label);
      if (name == null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      try { await renameSnapshotRecord(id, trimmed); await refreshSnapshots(); log('Snapshot renamed to: ' + trimmed); }
      catch (err) { log('Rename failed: ' + err.message); }
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'snap-del'; delBtn.textContent = '✕'; delBtn.title = 'Delete';
    delBtn.onclick = async () => {
      try {
        await deleteSnapshotRecord(id);
        if (String(id) === String(getBaselineId())) setBaselineId(null);
        await refreshSnapshots();
      } catch (err) { log('Delete failed: ' + err.message); }
    };

    tdActions.appendChild(baseBtn);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
}

async function refreshSnapshots() {
  if (!dbAvailable()) { snapshotsCache = []; renderSnapshotList(snapshotsCache); return; }
  try { snapshotsCache = await listSnapshots(); }
  catch (err) { log('Could not load snapshots: ' + err.message); snapshotsCache = []; }
  renderSnapshotList(snapshotsCache);
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
    $('saveSnapshot').disabled = !dbAvailable();
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
    $('saveSnapshot').disabled = !dbAvailable();
  } catch (err) {
    log('Error: ' + (err && err.message ? err.message : err));
  } finally {
    setProgress(null);
    setButtonsDisabled(false);
  }
}

function setStorageBadge() {
  const el = $('storageBadge');
  if (!el) return;
  if (dbAvailable()) { el.textContent = '🗄 Database'; el.title = 'Snapshots are stored in PostgreSQL'; }
  else { el.textContent = '⚠ No database'; el.title = 'Set DATABASE_URL to save and compare snapshots'; }
}

async function init() {
  // Server info -> tells us whether the database is available.
  try {
    const res = await fetch(cacheBust('/api/info'), { cache: 'no-store' });
    const info = await res.json();
    storageMode = info && info.database ? 'db' : 'none';
    $('connDot').className = 'dot ok';
    $('connText').textContent = 'connected';
    $('serverInfo').textContent = `${info.nodeVersion} · region ${info.region || '?'} · uptime ${info.uptimeSec}s · db ${info.database ? 'on' : 'off'}`;
    log(`Connected to server (database: ${dbAvailable() ? 'on' : 'off'}).`);
  } catch (_) {
    storageMode = 'none';
    $('connDot').className = 'dot err';
    $('connText').textContent = 'no connection';
    log('Could not reach server.');
  }
  setStorageBadge();

  // Wire up controls.
  $('runAll').onclick = runAll;
  document.querySelectorAll('button[data-test]').forEach((b) => {
    b.onclick = () => runSingle(b.dataset.test);
  });
  $('saveSnapshot').onclick = async () => {
    if (!dbAvailable()) { log('No database connected — cannot save snapshots.'); return; }
    const proxied = $('proxied').checked;
    const label = prompt('Label for this snapshot:', proxied ? 'With proxy' : 'Direct');
    if (!label) return;
    try {
      await createSnapshotRecord(currentSnapshot(label));
      await refreshSnapshots();
      log(`Snapshot saved: ${label} (${proxied ? 'through proxy' : 'direct'}).`);
    } catch (err) { log('Save failed: ' + err.message); }
  };
  $('clearSnapshots').onclick = async () => {
    if (!dbAvailable()) return;
    if (!confirm('Delete all snapshots?')) return;
    try { await clearSnapshotRecords(); setBaselineId(null); await refreshSnapshots(); }
    catch (err) { log('Clear failed: ' + err.message); }
  };

  // Initial proxy/connection read so the dashboard isn't empty.
  runConnInfo().catch(() => {});
  await refreshSnapshots();
}

document.addEventListener('DOMContentLoaded', init);
