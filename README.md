# ⚡ Proxy Performance Tester

A small website to measure whether a web proxy / SSL-inspection gateway (such as
**Zscaler**) causes performance problems. You run the test once **with** the
proxy and once **without** (or from an unfiltered network) and compare the
numbers.

## What is measured?

| Test | What it tells you about the proxy |
|------|-----------------------------------|
| **Latency** (median / p95 / jitter) | Per-request overhead. Many small pings over a single connection reveal the fixed delay a proxy adds. High jitter = variable queueing delay. |
| **Download** (Mbit/s + TTFB) | Throughput. Incompressible random data, so a low speed points to throttling or SSL inspection rather than compression. |
| **Upload** (Mbit/s) | Upstream throughput, which often passes through the proxy buffer first. |
| **Connection** (DNS / TCP / **TLS** / TTFB) | The **TLS handshake time** is the key indicator of SSL inspection: when intercepting, the proxy sets up its own TLS session, which measurably lengthens the handshake. |
| **Proxy detection** | Shows which headers the server receives (`Via`, `X-Forwarded-For`, Zscaler headers, …) and the IP hop chain, so you can confirm the traffic really goes through the proxy. |

The interpretation is heuristic — the **comparison** between snapshots is the
real conclusion.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render.com

A [`render.yaml`](./render.yaml) blueprint is included.

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → pick this repo.
3. Render reads `render.yaml`, builds with `npm install` and starts with `npm start`.

Manual setup also works (**New → Web Service**):

- **Runtime:** Node
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/api/info`

> The server automatically listens on `process.env.PORT` (set by Render).

### Mind the Render free tier

Free-tier services **sleep** after inactivity. The first request afterwards has
a cold start of a few seconds — that is *not* proxy latency. Open the page, wait
until the status badge shows "connected", and only then run the test (the latency
test discards its first measurement anyway).

## How to use it

1. Open the site **through** your normal (Zscaler) connection.
2. Click **"Run all tests"**.
3. Click **"Save snapshot"** → label it e.g. `With Zscaler`.
4. Run the same test **without** the proxy (bypass / different network / hotspot)
   and save it as `Direct`.
5. Compare the rows in the **snapshots** table. Large differences in TLS time,
   latency jitter or throughput point to proxy impact.

> You can rename a saved snapshot's label any time with the ✎ button, mark one as
> the ◎ **baseline** (your direct reference), or remove it with ✕. Once a baseline
> is set, the coloured **Δ** on Latency & TTFB shows the proxy's *added* latency.

## Thresholds & sources

The colour grading in the UI is anchored to published figures, not guesswork:

| Metric | Threshold | Source |
|--------|-----------|--------|
| **Absolute TTFB** | ≤ 800 ms good · 800–1800 ms needs improvement · > 1800 ms poor | [web.dev — TTFB](https://web.dev/articles/ttfb) (TTFB is a diagnostic metric, not a Core Web Vital; the band targets full-page navigation) |
| **Proxy overhead (Δ vs. baseline)** | ≤ 100 ms green / > 100 ms red | [Zscaler ZIA Latency Agreement](https://www.zscaler.com/legal/sla-support) — Zscaler commits to *"100 milliseconds or less for the 95th percentile"* of proxy **processing** (measured proxy-ingress → proxy-egress; it does **not** cover the network detour to the Zscaler node) |

Background on the TLS handshake cost (where SSL inspection shows up): a TLS 1.3
handshake is 1 round trip vs. 2 for TLS 1.2 — see
[ThousandEyes](https://www.thousandeyes.com/blog/optimizing-web-performance-tls-1-3)
and [Cloudflare 0-RTT](https://blog.cloudflare.com/introducing-0-rtt/). The
per-metric TLS bands in the summary are heuristic, not a published standard.

## Endpoints (API)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/ping` | Minimal response for latency measurement. |
| `GET /api/download?bytes=N` | Streams N bytes of random data (max 500 MiB). |
| `POST /api/upload` | Consumes the body, reports bytes + server duration. |
| `GET /api/headers` | Echoes received headers + IP chain (proxy detection). |
| `GET /api/info` | Server info / health check. |

## Tech

- Node.js + Express, no build step, vanilla JS frontend (stays lightweight so the
  app itself doesn't skew the measurements).
- Random/incompressible payloads so compression doesn't affect throughput.
- No caching on any endpoint; `Timing-Allow-Origin` for the Resource Timing API
  (DNS/TCP/TLS breakdown).
