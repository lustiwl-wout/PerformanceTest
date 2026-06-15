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

> **One-time reset:** set `RESET_DB=true` (e.g. in the Render dashboard) to empty
> the `snapshots` table on the next startup, then remove the variable again. While
> it is set, the table is wiped on *every* restart.

## How to use it

1. Open the site **through** your normal (Zscaler) connection.
2. Tick **"Through the proxy"** (auto-detected, but you have the final say) and pick a
   **Group** number — related scans (e.g. one comparison session) share a group.
3. Click **"Run all tests"** — the run is saved automatically as `Scan N`
   (auto-incrementing), tagged with the proxy state and group.
4. Run again **without** the proxy (bypass / different network / hotspot) with the
   box unticked, so you also have some direct scans.
5. The results table groups scans by **Group**: each group shows its **Direct baseline**
   median and **With proxy** median (with the **Δ**), plus a **verdict** (good / not good)
   based on **per-metric tolerances** (Settings → Latency / TTFB / Throughput, default 30%
   each; TLS is shown but not judged). Tick **Show individual scans** to edit — re-tag
   (click the Proxy cell), rename (✎) or delete (✕) a scan.

> Absolute numbers include your distance to the server, so they don't reveal the
> proxy on their own — **the difference vs. the direct baseline is the answer.**
> Rename a snapshot with ✎ or remove it with ✕.

## Reading the comparison

The comparison is **per scan group**: each group's with-proxy median is compared to
its direct-scan median (the baseline). Absolute numbers are dominated by your distance
to the server, so the **Δ** is what matters:

- **Latency / TTFB / TLS** — the millisecond difference the proxy adds.
- **Download / Upload** — the % change vs. the baseline.

A group's **verdict** is *not good* when the proxy exceeds the **per-metric tolerance** for
latency, TTFB or throughput (Settings, default 30 % each); otherwise *good*. **TLS is shown
but not judged** — SSL inspection inherently doubles the handshake, so it would almost always
trip and says little about the end-user experience. There is no absolute standard, so the
relative degradation vs. your own direct baseline (and the tolerances you pick) is the honest
measure. TLS handshake background (where SSL inspection adds cost): TLS 1.3 is 1 round trip vs. 2 for TLS 1.2
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
| `PATCH` / `DELETE /api/snapshots/:id` | Update (label / proxied / group) or delete one scan. |
| `DELETE /api/snapshots` | Clear all snapshots. |

## Tech

- Node.js + Express, no build step, vanilla JS frontend (stays lightweight so the
  app itself doesn't skew the measurements).
- PostgreSQL persistence via `pg` (Neon-compatible); the tests run without a
  database, but snapshots require one.
- Random/incompressible payloads so compression doesn't affect throughput.
- No caching on any endpoint; `Timing-Allow-Origin` for the Resource Timing API
  (DNS/TCP/TLS breakdown).
