// One-off: normalize trailing slashes on events.path.
// Usage: cd gallery-api && node --env-file=.env scripts/backfill-paths.mjs
import { createClient } from '@libsql/client';

const url = process.env.ANALYTICS_DB_URL;
const authToken = process.env.ANALYTICS_DB_TOKEN;
if (!url) { console.error('ANALYTICS_DB_URL not set'); process.exit(1); }

const db = createClient({ url, authToken });

const preview = await db.execute(`
  SELECT path, RTRIM(path, '/') AS new_path, COUNT(*) AS cnt
  FROM events
  WHERE path LIKE '%/' AND path != '/' AND INSTR(path, '?') = 0
  GROUP BY path
`);
console.log('Rows to update:');
for (const r of preview.rows) console.log(`  ${r.path} → ${r.new_path} (${r.cnt} events)`);
if (preview.rows.length === 0) { console.log('Nothing to backfill.'); process.exit(0); }

const res = await db.execute(`
  UPDATE events SET path = RTRIM(path, '/')
  WHERE path LIKE '%/' AND path != '/' AND INSTR(path, '?') = 0
`);
console.log(`Updated ${res.rowsAffected} events.`);
