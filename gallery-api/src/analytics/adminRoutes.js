import { Hono } from 'hono';

const MAX_LIMIT = 500;

function parseRange(c) {
  const now = Date.now();
  const from = Number(c.req.query('from')) || (now - 30 * 24 * 60 * 60 * 1000);
  const to = Number(c.req.query('to')) || now;
  return { from, to };
}

function siteId(c) {
  const s = c.req.query('site_id');
  if (!s) return null;
  return String(s).slice(0, 64);
}

function includeAdmin(c) {
  const v = c.req.query('include_admin');
  return v === '1' || v === 'true' ? 1 : 0;
}

function limitArg(c, fallback = 50) {
  const raw = Number(c.req.query('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, MAX_LIMIT);
}

export function createAnalyticsAdminRoutes({ db }) {
  const app = new Hono();

  app.get('/sites', async c => {
    const res = await db.execute(`
      SELECT site_id,
             COUNT(*) AS events,
             MAX(ts) AS last_ts,
             MIN(ts) AS first_ts
      FROM events
      GROUP BY site_id
      ORDER BY last_ts DESC
    `);
    return c.json({ items: res.rows });
  });

  app.get('/summary', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);

    const days = await db.execute({
      sql: `
        SELECT DATE(ts/1000, 'unixepoch') AS day,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT session_id) AS sessions,
               COUNT(DISTINCT visitor_hash) AS daily_uniques,
               SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_pageviews
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
        GROUP BY day
        ORDER BY day ASC
      `,
      args: [site, from, to, inc],
    });

    const totals = await db.execute({
      sql: `
        SELECT COUNT(*) AS pageviews,
               COUNT(DISTINCT session_id) AS sessions,
               SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_pageviews
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
      `,
      args: [site, from, to, inc],
    });

    return c.json({
      range: { from, to },
      include_admin: !!inc,
      totals: totals.rows[0] || { pageviews: 0, sessions: 0, admin_pageviews: 0 },
      days: days.rows,
    });
  });

  app.get('/pages', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const limit = limitArg(c);

    const res = await db.execute({
      sql: `
        SELECT path,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT session_id) AS sessions
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND path IS NOT NULL
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
        GROUP BY path
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, limit],
    });
    return c.json({ items: res.rows });
  });

  app.get('/referrers', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const limit = limitArg(c);

    const res = await db.execute({
      sql: `
        SELECT referrer_host,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT session_id) AS sessions,
               COUNT(DISTINCT referrer_url) AS distinct_urls
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND referrer_host IS NOT NULL AND referrer_host != ''
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
        GROUP BY referrer_host
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, limit],
    });
    return c.json({ items: res.rows });
  });

  app.get('/referrers/urls', async c => {
    const site = siteId(c);
    const host = c.req.query('host');
    if (!site) return c.json({ error: 'site_id required' }, 400);
    if (!host) return c.json({ error: 'host required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const limit = limitArg(c);

    const res = await db.execute({
      sql: `
        SELECT referrer_url,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT session_id) AS sessions
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND referrer_host = ?
          AND referrer_url IS NOT NULL
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
        GROUP BY referrer_url
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, String(host).slice(0, 253), from, to, inc, limit],
    });
    return c.json({ items: res.rows });
  });

  const DIMENSIONS = {
    country: 's.country',
    device: 's.ua_device',
    os: 's.ua_os',
    browser: 's.ua_browser',
  };

  app.get('/breakdown', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const dim = c.req.query('dimension');
    const col = DIMENSIONS[dim];
    if (!col) return c.json({ error: `dimension must be one of: ${Object.keys(DIMENSIONS).join(', ')}` }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const limit = limitArg(c, 100);

    const res = await db.execute({
      sql: `
        SELECT COALESCE(${col}, '(unknown)') AS value,
               COUNT(DISTINCT e.session_id) AS sessions,
               COUNT(*) AS pageviews
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        WHERE e.site_id = ? AND e.event_name = 'pageview'
          AND e.ts >= ? AND e.ts < ?
          AND (? = 1 OR COALESCE(e.role, '') != 'admin')
        GROUP BY value
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, limit],
    });
    return c.json({ dimension: dim, items: res.rows });
  });

  app.get('/events', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const limit = limitArg(c);

    const res = await db.execute({
      sql: `
        SELECT event_name,
               COUNT(*) AS occurrences,
               COUNT(DISTINCT session_id) AS sessions
        FROM events
        WHERE site_id = ? AND event_name != 'pageview'
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
        GROUP BY event_name
        ORDER BY occurrences DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, limit],
    });
    return c.json({ items: res.rows });
  });

  return app;
}
