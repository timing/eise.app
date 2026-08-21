// One-off: normalize events.path (strip trailing slashes + tracking params) and
// backfill referrer_host from utm_source where the HTTP referrer was missing.
// Usage: cd gallery-api && node --env-file=.env scripts/backfill-paths.mjs
import { createClient } from '@libsql/client';
import { normalizePath } from '../src/analytics/session.js';

const url = process.env.ANALYTICS_DB_URL;
const authToken = process.env.ANALYTICS_DB_TOKEN;
if (!url) { console.error('ANALYTICS_DB_URL not set'); process.exit(1); }

const db = createClient({ url, authToken });

// --- Path normalization ---
const rows = await db.execute(`SELECT id, path FROM events WHERE path IS NOT NULL`);
let pathUpdates = 0;
for (const r of rows.rows) {
  const cleaned = normalizePath(r.path);
  if (cleaned !== r.path) {
    await db.execute({ sql: 'UPDATE events SET path = ? WHERE id = ?', args: [cleaned, r.id] });
    pathUpdates++;
  }
}
console.log(`Path normalized: ${pathUpdates} events updated (of ${rows.rows.length} scanned).`);

// --- Referrer backfill from UTM (events) ---
const evRes = await db.execute(`
  UPDATE events
  SET referrer_host = (
    SELECT LOWER(SUBSTR(s.first_utm_source, 1, 128))
    FROM sessions s WHERE s.id = events.session_id
  )
  WHERE (referrer_host IS NULL OR referrer_host = '')
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = events.session_id
        AND s.first_utm_source IS NOT NULL AND s.first_utm_source != ''
    )
`);
console.log(`Referrer backfilled from UTM on events: ${evRes.rowsAffected}.`);

// --- Referrer backfill from UTM (sessions) ---
const seRes = await db.execute(`
  UPDATE sessions
  SET first_referrer_host = LOWER(SUBSTR(first_utm_source, 1, 128))
  WHERE (first_referrer_host IS NULL OR first_referrer_host = '')
    AND first_utm_source IS NOT NULL AND first_utm_source != ''
`);
console.log(`Referrer backfilled from UTM on sessions: ${seRes.rowsAffected}.`);
