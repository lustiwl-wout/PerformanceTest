'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and any proxy in front of us, including Zscaler) sets X-Forwarded-*.
// Trusting the proxy lets req.ip / req.ips reflect the real chain so the client
// can see which hops the traffic passed through.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Pre-generate 1 MiB of random, incompressible data to stream for download
// tests. Random bytes prevent the proxy (or any gzip layer) from compressing
// the payload, so we measure true wire throughput instead of compressibility.
const CHUNK_SIZE = 1024 * 1024;
const RANDOM_CHUNK = crypto.randomBytes(CHUNK_SIZE);

const MAX_TRANSFER = 500 * 1024 * 1024; // 500 MiB hard cap per request

/* ============================================================
 * Database (optional) — Neon / PostgreSQL via DATABASE_URL.
 * If DATABASE_URL is unset or unreachable, the snapshot endpoints return 503
 * and the frontend falls back to localStorage.
 * ========================================================== */
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
let dbReady = false;

if (DATABASE_URL) {
  // Normalise the connection string and decide on SSL:
  //  - drop channel_binding: not all driver versions support SCRAM channel binding
  //  - drop sslmode: we set ssl explicitly so the two can't disagree
  //  - managed DBs (Neon, etc.) need TLS; a local dev DB does not.
  let connectionString = DATABASE_URL;
  let host = '';
  try {
    const u = new URL(DATABASE_URL);
    u.searchParams.delete('channel_binding');
    u.searchParams.delete('sslmode');
    connectionString = u.toString();
    host = u.hostname;
  } catch (_) { /* fall back to the raw string */ }

  const isLocal = /^(localhost|127\.0\.0\.1|::1)$/.test(host) || /sslmode=disable/i.test(DATABASE_URL);
  pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('pg pool error:', err.message));
  initDb();
} else {
  console.log('No DATABASE_URL set — snapshots will be stored in the browser (localStorage).');
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id BIGSERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        proxied BOOLEAN,
        scan_group INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        latency_median DOUBLE PRECISION,
        latency_jitter DOUBLE PRECISION,
        download_mbps DOUBLE PRECISION,
        upload_mbps DOUBLE PRECISION,
        ttfb_ms DOUBLE PRECISION,
        tls_ms DOUBLE PRECISION,
        client_ip TEXT,
        user_agent TEXT
      );
    `);
    // Add columns that may be missing on a pre-existing table.
    await pool.query('ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS scan_group INTEGER DEFAULT 1');
    // One-time wipe: set RESET_DB=true to empty the table on startup, then
    // remove the variable again (while set, it wipes on every restart).
    if (process.env.RESET_DB === 'true') {
      await pool.query('TRUNCATE TABLE snapshots RESTART IDENTITY');
      console.warn('RESET_DB=true — emptied the snapshots table. Remove this env var so it does not wipe on every restart.');
    }
    dbReady = true;
    console.log('Database ready — snapshots will be stored in PostgreSQL.');
  } catch (err) {
    dbReady = false;
    console.error('Database init failed (snapshots disabled):', err.message);
  }
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function rowToSnapshot(r) {
  return {
    id: Number(r.id),
    label: r.label,
    proxied: r.proxied,
    group: r.scan_group != null ? Number(r.scan_group) : null,
    ts: new Date(r.created_at).getTime(),
    latency: (r.latency_median != null || r.latency_jitter != null)
      ? { median: r.latency_median, jitter: r.latency_jitter }
      : null,
    download: r.download_mbps,
    upload: r.upload_mbps,
    ttfb: r.ttfb_ms,
    tls: r.tls_ms,
  };
}

// Disable caching everywhere, expose timing to the Resource Timing API, and
// allow cross-origin use so the page can optionally be hosted elsewhere.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Timing-Allow-Origin', '*');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Expose-Headers', 'Server-Timing, X-Server-Time, Content-Length');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- Latency probe -------------------------------------------------------
app.get('/api/ping', (req, res) => {
  res.json({ t: Date.now() });
});

// --- Download throughput -------------------------------------------------
app.get('/api/download', (req, res) => {
  let bytes = parseInt(req.query.bytes, 10);
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 10 * 1024 * 1024;
  bytes = Math.min(bytes, MAX_TRANSFER);

  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(bytes));
  res.set('X-Server-Time', String(Date.now()));

  let sent = 0;
  let closed = false;
  res.on('close', () => { closed = true; });
  res.on('error', () => { closed = true; });

  const write = () => {
    if (closed) return;
    while (sent < bytes) {
      const remaining = bytes - sent;
      const chunk = remaining >= CHUNK_SIZE ? RANDOM_CHUNK : RANDOM_CHUNK.subarray(0, remaining);
      sent += chunk.length;
      if (sent >= bytes) { res.end(chunk); return; }
      if (!res.write(chunk)) { res.once('drain', write); return; }
    }
  };
  write();
});

// --- Upload throughput ---------------------------------------------------
app.post('/api/upload', (req, res) => {
  const start = process.hrtime.bigint();
  let bytes = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_TRANSFER) {
      aborted = true;
      res.status(413).json({ error: 'payload too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    const serverDurationMs = Number(process.hrtime.bigint() - start) / 1e6;
    res.json({ bytes, serverDurationMs, serverTime: Date.now() });
  });
  req.on('error', () => { if (!aborted) res.status(400).end(); });
});

// --- Header / proxy inspection ------------------------------------------
app.get('/api/headers', (req, res) => {
  res.json({
    ip: req.ip,
    ips: req.ips,
    protocol: req.protocol,
    httpVersion: req.httpVersion,
    method: req.method,
    headers: req.headers,
    serverTime: Date.now(),
    region: process.env.RENDER_REGION || process.env.REGION || null,
    instance: process.env.RENDER_INSTANCE_ID || null,
  });
});

// --- Server info / health check -----------------------------------------
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Proxy Performance Tester',
    serverTime: Date.now(),
    nodeVersion: process.version,
    region: process.env.RENDER_REGION || null,
    uptimeSec: Math.round(process.uptime()),
    database: dbReady,
  });
});

/* ============================================================
 * Snapshot persistence endpoints (require a working database)
 * ========================================================== */
const requireDb = (req, res, next) => {
  if (!pool || !dbReady) return res.status(503).json({ error: 'database not configured' });
  next();
};

app.get('/api/snapshots', requireDb, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 500');
    res.json(rows.map(rowToSnapshot));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/snapshots', requireDb, express.json({ limit: '64kb' }), async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query(
      `INSERT INTO snapshots
        (label, proxied, scan_group, latency_median, latency_jitter, download_mbps, upload_mbps, ttfb_ms, tls_ms, client_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        String(b.label || 'snapshot').slice(0, 200),
        typeof b.proxied === 'boolean' ? b.proxied : null,
        Number.isFinite(b.group) ? Math.trunc(b.group) : 1,
        num(b.latency && b.latency.median), num(b.latency && b.latency.jitter),
        num(b.download), num(b.upload), num(b.ttfb), num(b.tls),
        req.ip, String(req.headers['user-agent'] || '').slice(0, 300),
      ]
    );
    res.status(201).json(rowToSnapshot(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/snapshots/:id', requireDb, express.json({ limit: '8kb' }), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (typeof b.label === 'string' && b.label.trim()) { vals.push(b.label.slice(0, 200)); sets.push(`label=$${vals.length}`); }
  if (typeof b.proxied === 'boolean' || b.proxied === null) { vals.push(b.proxied); sets.push(`proxied=$${vals.length}`); }
  if (Number.isFinite(b.group)) { vals.push(Math.trunc(b.group)); sets.push(`scan_group=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE snapshots SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rowToSnapshot(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/snapshots/:id', requireDb, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await pool.query('DELETE FROM snapshots WHERE id=$1', [id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/snapshots', requireDb, async (req, res) => {
  try {
    await pool.query('DELETE FROM snapshots');
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend -----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
}));

app.listen(PORT, () => {
  console.log(`Proxy performance tester listening on :${PORT}`);
});
