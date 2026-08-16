import { createClient } from '@libsql/client/web';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    astrobin_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    image_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    approved_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC)`,
];

const MIGRATIONS = [
  `ALTER TABLE submissions ADD COLUMN captured_at TEXT`,
  `ALTER TABLE submissions ADD COLUMN title TEXT`,
  `ALTER TABLE submissions ADD COLUMN ip TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_ip_created ON submissions(ip, created_at)`,
];

export function createDb(env) {
  const url = env.BUNNY_DATABASE_URL || 'file:./gallery.db';
  const authToken = env.BUNNY_DATABASE_AUTH_TOKEN || undefined;
  return createClient({ url, authToken });
}

export async function initSchema(db) {
  for (const stmt of SCHEMA) await db.execute(stmt);
  for (const stmt of MIGRATIONS) {
    try { await db.execute(stmt); } catch { /* column likely exists */ }
  }
}
