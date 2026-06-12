-- Roo '26 telemetry — durable event log + per-device plan snapshots.
-- Apply with:  wrangler d1 migrations apply roo26-analytics --remote
-- (created by `wrangler d1 create roo26-analytics`, then paste the id into wrangler.jsonc)

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recv_ts    INTEGER NOT NULL,   -- server receive time (epoch ms)
  client_ts  INTEGER,            -- client event time (epoch ms) — clock-skew/offline analysis
  client_id  TEXT NOT NULL,      -- anonymous per-device id
  session_id TEXT,               -- per-tab session
  event      TEXT NOT NULL,      -- 'fav','search','share','route_view','geo','snapshot',...
  props      TEXT,               -- JSON payload (set_id, artist, query, lat/lon, ...)
  route      TEXT,               -- pathname the event fired on
  app_ver    TEXT,
  country TEXT, region TEXT, city TEXT, colo TEXT, asn TEXT, tz TEXT,  -- from request.cf
  device  TEXT,                  -- coarse device class (ios-phone, android-phone, mac, ...)
  ua      TEXT,
  ip_hash TEXT                   -- salted SHA-256 prefix — never the raw IP
);
CREATE INDEX IF NOT EXISTS idx_events_recv ON events(recv_ts);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_event_recv ON events(event, recv_ts);

-- one row per device: the latest snapshot of their plan/selections, so we can
-- reconstruct everyone's final Roo after the festival without replaying events.
CREATE TABLE IF NOT EXISTS snapshots (
  client_id TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  name      TEXT,
  icon      TEXT,
  favs      TEXT,               -- JSON array of starred set IDs
  fav_count INTEGER,
  pins      INTEGER,
  friends   INTEGER,
  settings  TEXT                -- JSON: {notif, locate}
);
CREATE INDEX IF NOT EXISTS idx_snapshots_favcount ON snapshots(fav_count);
