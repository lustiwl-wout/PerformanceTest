# ⚡ Proxy Performance Tester

Een kleine website om te meten of een web-proxy / SSL-inspectie-gateway (zoals
**Zscaler**) performanceproblemen veroorzaakt. Je draait de test één keer **mét**
proxy en één keer **zónder** (of vanaf een niet-gefilterd netwerk) en vergelijkt
de cijfers.

## Wat wordt er gemeten?

| Test | Wat het zegt over de proxy |
|------|----------------------------|
| **Latency** (mediaan / p95 / jitter) | Per-request overhead. Veel kleine pings over één verbinding tonen de vaste vertraging die een proxy toevoegt. Hoge jitter = wisselende wachtrijvertraging. |
| **Download** (Mbit/s + TTFB) | Doorvoer. Onversleutelbare random data, dus lage snelheid wijst op throttling of SSL-inspectie i.p.v. compressie. |
| **Upload** (Mbit/s) | Doorvoer omhoog, vaak eerst door de proxy-buffer. |
| **Verbinding** (DNS / TCP / **TLS** / TTFB) | De **TLS-handshaketijd** is dé indicator voor SSL-inspectie: bij interceptie zet de proxy een eigen TLS-sessie op, wat de handshake meetbaar verlengt. |
| **Proxy-detectie** | Toont welke headers de server ontvangt (`Via`, `X-Forwarded-For`, Zscaler-headers, …) en de IP-keten, zodat je ziet of het verkeer écht door de proxy loopt. |

De interpretatie is heuristisch — de **vergelijking** tussen snapshots is de
echte conclusie.

## Lokaal draaien

```bash
npm install
npm start
# open http://localhost:3000
```

## Deployen op Render.com

Er zit een [`render.yaml`](./render.yaml) blueprint bij.

1. Push deze repo naar GitHub.
2. Render-dashboard → **New** → **Blueprint** → kies deze repo.
3. Render leest `render.yaml`, bouwt met `npm install` en start met `npm start`.

Handmatig kan ook (**New → Web Service**):

- **Runtime:** Node
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/api/info`

> De server luistert automatisch op `process.env.PORT` (door Render gezet).

### Let op de Render free-tier

Free-tier services gaan **slapen** na inactiviteit. De eerste request daarna
heeft een cold-start van enkele seconden — dat is géén proxy-latency. Open de
pagina, wacht tot de statusbadge "verbonden" toont en draai dan pas de test
(de latency-test gooit de eerste meting sowieso weg).

## Hoe gebruik je het?

1. Open de site **via** je normale (Zscaler-)verbinding.
2. Klik **"Alle tests uitvoeren"**.
3. Klik **"Snapshot opslaan"** → label bv. `Met Zscaler`.
4. Draai dezelfde test **zonder** de proxy (bypass / ander netwerk / hotspot) en
   sla op als `Direct`.
5. Vergelijk de rijen in de **Snapshots**-tabel. Grote verschillen in TLS-tijd,
   latency-jitter of doorvoer wijzen op proxy-impact.

## Endpoints (API)

| Endpoint | Doel |
|----------|------|
| `GET /api/ping` | Minimale respons voor latency-meting. |
| `GET /api/download?bytes=N` | Streamt N bytes random data (max 500 MiB). |
| `POST /api/upload` | Slokt de body op, rapporteert bytes + serverduur. |
| `GET /api/headers` | Echo't ontvangen headers + IP-keten (proxy-detectie). |
| `GET /api/info` | Serverinfo / health check. |

## Techniek

- Node.js + Express, geen build-stap, vanilla JS frontend (blijft licht zodat de
  app zelf de meting niet vertroebelt).
- Random/onversleutelbare payloads zodat compressie de doorvoer niet beïnvloedt.
- Geen caching op alle endpoints; `Timing-Allow-Origin` voor de Resource Timing
  API (DNS/TCP/TLS-breakdown).
