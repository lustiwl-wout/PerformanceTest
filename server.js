'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

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

// Disable caching everywhere, expose timing to the Resource Timing API, and
// allow cross-origin use so the page can optionally be hosted elsewhere.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Timing-Allow-Origin', '*');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Expose-Headers', 'Server-Timing, X-Server-Time, Content-Length');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- Latency probe -------------------------------------------------------
// Smallest possible response. The client fires many of these and measures the
// round-trip time; over a kept-alive connection this isolates the per-request
// overhead a proxy adds.
app.get('/api/ping', (req, res) => {
  res.json({ t: Date.now() });
});

// --- Download throughput -------------------------------------------------
// Streams `bytes` of random data with backpressure handling.
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
// Consumes the request body and reports how many bytes arrived and how long
// the server spent receiving them.
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
// Echoes what the server actually received so the client can detect proxy
// injection (Via, X-Forwarded-For, Zscaler headers, ...) and the hop chain.
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
  });
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
