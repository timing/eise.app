import { createClient } from '@libsql/client/web';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    first_referrer_url TEXT,
    first_referrer_host TEXT,
    first_utm_source TEXT,
    first_utm_medium TEXT,
    first_utm_campaign TEXT,
    first_utm_term TEXT,
    first_utm_content TEXT,
    country TEXT,
    ua_browser TEXT,
    ua_os TEXT,
    ua_device TEXT,
    role TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id TEXT,
    ts INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    path TEXT,
    referrer_url TEXT,
    referrer_host TEXT,
    referrer_path TEXT,
    visitor_hash TEXT,
    props_json TEXT,
    variant TEXT,
    role TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_site_event_ts ON events(site_id, event_name, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_site_first ON sessions(site_id, first_ts DESC)`,
  `CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    name TEXT NOT NULL,
    variants_json TEXT NOT NULL,
    traffic_split_json TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE(site_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS experiment_assignments (
    session_id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, experiment_id)
  )`,
];

const MIGRATIONS = [
  `ALTER TABLE events ADD COLUMN role TEXT`,
  `ALTER TABLE sessions ADD COLUMN role TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_events_role_ts ON events(role, ts DESC)`,
  `ALTER TABLE events ADD COLUMN bot TEXT`,
  `ALTER TABLE sessions ADD COLUMN bot TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_events_bot_ts ON events(bot, ts DESC)`,
];

export function createAnalyticsDb(env) {
  const url = env.ANALYTICS_DB_URL;
  if (!url) return null;
  const authToken = env.ANALYTICS_DB_TOKEN || undefined;
  return createClient({ url, authToken });
}

export async function initAnalyticsSchema(db) {
  for (const stmt of SCHEMA) await db.execute(stmt);
  for (const stmt of MIGRATIONS) {
    try { await db.execute(stmt); } catch { /* likely already applied */ }
  }
}
