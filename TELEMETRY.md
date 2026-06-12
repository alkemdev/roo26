# Roo '26 — Telemetry & Analytics

Anonymous, offline-resilient usage analytics. Three sinks, each for a different job:

| Sink | Binding | Status | Use |
|---|---|---|---|
| **Analytics Engine** | `ROO26_AE` | ✅ live on deploy (no provisioning) | fast time-series / aggregates, 90-day retention, SQL API |
| **D1** | `DB` | ⏳ provision once | durable event log + per-device plan snapshots; powers `/roo26-api/stats` |
| **R2** | `ARCHIVE` | ⏳ optional | immutable raw NDJSON archive — never lose a byte |

The client SDK lives in `src/pages/roo26/_app.js` (the `tev()` / `tsnap()` /
`flushTelemetry()` / `initTelemetry()` block). Events queue in `localStorage` and
flush via `fetch(keepalive)` / `sendBeacon` on interval, tab-hide, and `online`,
so taps in a festival dead-zone land when signal returns. Ingestion +
dashboard: `src-roo26/pages/roo26-api/[...path].ts` (`/roo26-api/t`, `/roo26-api/stats`).

## What's captured

`session_start`, `route_view`, `fav`, `search`, `filter`, `share_open`, `share`,
`import_view`, `import_save` (social graph), `ics_export`, `pin_add`,
`tracks_toggle`, `geo` (🐾 trail points), `notif_set`, `wx_alert_view`, `quest`,
`perf` + `vital` (TTFB/LCP/INP/CLS), `error`, `net`, `visibility`,
`pwa_install`, `session_end`, and `snapshot` (full plan per device).
Server enriches each with `request.cf` geo (country/region/city/**colo**/asn/tz),
coarse device class, and a salted IP hash (never the raw IP).

## One-time setup (needs your Cloudflare login)

```bash
# 1) Durable log
wrangler d1 create roo26-analytics            # copy the database_id it prints
#   → paste it into wrangler.jsonc and UNCOMMENT the d1_databases line
wrangler d1 migrations apply roo26-analytics --remote

# 2) Raw archive (optional)
wrangler r2 bucket create roo26-telemetry
#   → UNCOMMENT the r2_buckets line in wrangler.jsonc

# 3) Lock the dashboard
wrangler secret put STATS_KEY                 # type any long random string

# 4) Ship (or just push to main — Workers Builds deploys it)
git commit -am "enable D1+R2 telemetry" && git push
```

Analytics Engine works without any of the above — data flows the moment the
current commit deploys.

## Looking at the data

- **Dashboard:** `https://roo26.alkem.dev/roo26-api/stats?key=<STATS_KEY>`
  (add `&format=json` for raw JSON). Server-rendered: totals, events by type,
  top artists, searches, geography, devices, the share graph, and per-person plans.
- **Analytics Engine (live, ad-hoc):** Cloudflare dashboard → Workers → Analytics
  Engine, or the SQL API:
  ```sql
  SELECT blob1 AS event, count() AS n
  FROM roo26_events
  WHERE timestamp > NOW() - INTERVAL '1' DAY
  GROUP BY event ORDER BY n DESC
  ```
  (blob layout: 1 event, 2 route, 3 client_id, 4 session_id, 5 country, 6 region,
  7 city, 8 colo, 9 device, 10 app_ver, 11 key-dim, 12 props-json.)
- **D1 deep dives (post-festival):**
  ```bash
  wrangler d1 execute roo26-analytics --remote --command \
    "SELECT json_extract(props,'\$.artist') a, count(*) n FROM events
     WHERE event='fav' AND json_extract(props,'\$.on')=1 GROUP BY a ORDER BY n DESC LIMIT 20"
  wrangler d1 export roo26-analytics --remote --output roo26.sqlite   # keep forever
  ```

### Query cookbook (D1 / SQLite)

```sql
-- Most-favorited artists
SELECT json_extract(props,'$.artist') artist, count(*) n FROM events
WHERE event='fav' AND json_extract(props,'$.on')=1 GROUP BY artist ORDER BY n DESC;

-- Busiest hours (festival-local is CDT = UTC-5)
SELECT strftime('%Y-%m-%d %H:00', recv_ts/1000 - 18000,'unixepoch') hr, count(*) n
FROM events GROUP BY hr ORDER BY n DESC;

-- The share graph: whose plans got imported most
SELECT json_extract(props,'$.from') sharer, count(*) imports FROM events
WHERE event='import_save' GROUP BY sharer ORDER BY imports DESC;

-- Wanted-but-missing artists (searches with zero results)
SELECT json_extract(props,'$.q') q, count(*) n FROM events
WHERE event='search' AND json_extract(props,'$.hits')=0 GROUP BY q ORDER BY n DESC;

-- Movement: total trail points per device per day
SELECT client_id, date(recv_ts/1000,'unixepoch') d, count(*) pts FROM events
WHERE event='geo' GROUP BY client_id, d ORDER BY pts DESC;

-- Everyone's final plan
SELECT name, icon, fav_count, pins, friends, datetime(ts/1000,'unixepoch') updated
FROM snapshots ORDER BY fav_count DESC;
```
