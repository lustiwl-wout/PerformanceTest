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

## Data storage (PostgreSQL)

Snapshots are stored in a **PostgreSQL** database (the app was built against
[Neon](https://neon.tech)) — the database is the single source of truth. The server
creates its `snapshots` table automatically on first start, and the header badge
shows the status (🗄 Database / ⚠ No database). Without a `DATABASE_URL` the tests
still run, but snapshots can't be saved or compared.

Set the connection string as an environment variable — **never commit it**:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/db?sslmode=require'
npm start
```

On Render, `render.yaml` declares `DATABASE_URL` with `sync: false`, so you paste
the value in the dashboard (Environment) rather than storing it in the repo. TLS is
enabled automatically for non-local hosts; a `localhost` URL connects without TLS
for local development.

## How to use it

1. Open the site **through** your normal (Zscaler) connection.
2. Tick **"Through the proxy"** (auto-detected, but you have the final say).
3. Click **"Run all tests"**, then **"Save snapshot"** → label it e.g. `With Zscaler`.
4. Run the test again **without** the proxy (bypass / different network / hotspot),
   untick the box, and save it as `Direct`.
5. Your direct (no-proxy) runs are combined into a **median baseline** row, and the
   **Δ** on each with-proxy row shows the proxy's *added* cost. The **Proxy** column
   (✓ / ✗) records which run was which.

> Absolute numbers include your distance to the server, so they don't reveal the
> proxy on their own — **the difference vs. the direct baseline is the answer.**
> Rename a snapshot with ✎ or remove it with ✕.

## Reading the comparison

The tool deliberately shows **raw differences**, not pass/fail verdicts. Absolute
numbers are dominated by your distance to the server, so only the **Δ vs. the
direct-median baseline** matters (the baseline is the median of all your
direct/no-proxy scans):

- **Latency / TTFB / TLS** — the millisecond difference the proxy adds.
- **Download / Upload** — the % change vs. the baseline.

What counts as "too much" depends on your own link and expectations, so judge it
from the size of the difference between the with-proxy and no-proxy runs. TLS
handshake background (where SSL inspection adds cost): TLS 1.3 is 1 round trip vs.
2 for TLS 1.2
([ThousandEyes](https://www.thousandeyes.com/blog/optimizing-web-performance-tls-1-3),
[Cloudflare](https://blog.cloudflare.com/introducing-0-rtt/)).

## Endpoints (API)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/ping` | Minimal response for latency measurement. |
| `GET /api/download?bytes=N` | Streams N bytes of random data (max 500 MiB). |
| `POST /api/upload` | Consumes the body, reports bytes + server duration. |
| `GET /api/headers` | Echoes received headers + IP chain (proxy detection). |
| `GET /api/info` | Server info / health check (incl. `database` flag). |
| `GET` / `POST /api/snapshots` | List / create snapshots (PostgreSQL). |
| `PATCH` / `DELETE /api/snapshots/:id` | Rename / delete one snapshot. |
| `DELETE /api/snapshots` | Clear all snapshots. |

## Tech

- Node.js + Express, no build step, vanilla JS frontend (stays lightweight so the
  app itself doesn't skew the measurements).
- PostgreSQL persistence via `pg` (Neon-compatible); the tests run without a
  database, but snapshots require one.
- Random/incompressible payloads so compression doesn't affect throughput.
- No caching on any endpoint; `Timing-Allow-Origin` for the Resource Timing API
  (DNS/TCP/TLS breakdown).
