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

function includeBots(c) {
  const v = c.req.query('include_bots');
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
    const incBots = includeBots(c);

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
          AND (? = 1 OR bot IS NULL)
        GROUP BY day
        ORDER BY day ASC
      `,
      args: [site, from, to, inc, incBots],
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
          AND (? = 1 OR bot IS NULL)
      `,
      args: [site, from, to, inc, incBots],
    });

    return c.json({
      range: { from, to },
      include_admin: !!inc,
      include_bots: !!incBots,
      totals: totals.rows[0] || { pageviews: 0, sessions: 0, admin_pageviews: 0 },
      days: days.rows,
    });
  });

  app.get('/pages', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
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
          AND (? = 1 OR bot IS NULL)
        GROUP BY path
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, incBots, limit],
    });
    return c.json({ items: res.rows });
  });

  app.get('/referrers', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
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
          AND (? = 1 OR bot IS NULL)
        GROUP BY referrer_host
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, incBots, limit],
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
    const incBots = includeBots(c);
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
          AND (? = 1 OR bot IS NULL)
        GROUP BY referrer_url
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, String(host).slice(0, 253), from, to, inc, incBots, limit],
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
    const incBots = includeBots(c);
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
          AND (? = 1 OR e.bot IS NULL)
        GROUP BY value
        ORDER BY pageviews DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, incBots, limit],
    });
    return c.json({ dimension: dim, items: res.rows });
  });

  app.get('/dashboard', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const limit = limitArg(c, 50);

    const adminFilter = `AND (? = 1 OR COALESCE(role, '') != 'admin')`;
    const botFilter = `AND (? = 1 OR bot IS NULL)`;
    const baseArgs = [site, from, to, inc, incBots];

    const stmts = [
      // 0 - daily
      { sql: `SELECT DATE(ts/1000, 'unixepoch') AS day, COUNT(*) AS pageviews,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT visitor_hash) AS daily_uniques,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_pageviews
              FROM events WHERE site_id = ? AND event_name = 'pageview' AND ts >= ? AND ts < ? ${adminFilter} ${botFilter}
              GROUP BY day ORDER BY day ASC`,
        args: baseArgs },
      // 1 - totals
      { sql: `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_pageviews
              FROM events WHERE site_id = ? AND event_name = 'pageview' AND ts >= ? AND ts < ? ${adminFilter} ${botFilter}`,
        args: baseArgs },
      // 2 - pages
      { sql: `SELECT path, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
              FROM events WHERE site_id = ? AND event_name = 'pageview' AND path IS NOT NULL
                AND ts >= ? AND ts < ? ${adminFilter} ${botFilter}
              GROUP BY path ORDER BY pageviews DESC LIMIT ?`,
        args: [...baseArgs, limit] },
      // 3 - referrers
      { sql: `SELECT referrer_host, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT referrer_url) AS distinct_urls
              FROM events WHERE site_id = ? AND event_name = 'pageview'
                AND referrer_host IS NOT NULL AND referrer_host != ''
                AND ts >= ? AND ts < ? ${adminFilter} ${botFilter}
              GROUP BY referrer_host ORDER BY pageviews DESC LIMIT ?`,
        args: [...baseArgs, limit] },
      // 4 - custom events
      { sql: `SELECT event_name, COUNT(*) AS occurrences, COUNT(DISTINCT session_id) AS sessions
              FROM events WHERE site_id = ? AND event_name != 'pageview'
                AND ts >= ? AND ts < ? ${adminFilter} ${botFilter}
              GROUP BY event_name ORDER BY occurrences DESC LIMIT ?`,
        args: [...baseArgs, limit] },
    ];

    // 5..8 - breakdowns
    for (const dim of ['country', 'device', 'os', 'browser']) {
      const col = DIMENSIONS[dim];
      stmts.push({
        sql: `SELECT COALESCE(${col}, '(unknown)') AS value,
                COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS pageviews
              FROM events e JOIN sessions s ON s.id = e.session_id
              WHERE e.site_id = ? AND e.event_name = 'pageview' AND e.ts >= ? AND e.ts < ?
                AND (? = 1 OR COALESCE(e.role, '') != 'admin')
                AND (? = 1 OR e.bot IS NULL)
              GROUP BY value ORDER BY pageviews DESC LIMIT ?`,
        args: [...baseArgs, dim === 'country' ? 30 : 10],
      });
    }

    const results = await db.batch(stmts, 'read');
    return c.json({
      range: { from, to },
      include_admin: !!inc,
      include_bots: !!incBots,
      days: results[0].rows,
      totals: results[1].rows[0] || { pageviews: 0, sessions: 0, admin_pageviews: 0 },
      pages: results[2].rows,
      referrers: results[3].rows,
      events: results[4].rows,
      breakdowns: {
        country: results[5].rows,
        device: results[6].rows,
        os: results[7].rows,
        browser: results[8].rows,
      },
    });
  });

  app.get('/events', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
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
          AND (? = 1 OR bot IS NULL)
        GROUP BY event_name
        ORDER BY occurrences DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, incBots, limit],
    });
    return c.json({ items: res.rows });
  });

  app.get('/event-detail', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const name = String(c.req.query('event_name') || '').slice(0, 64);
    if (!name) return c.json({ error: 'event_name required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const limit = limitArg(c, 100);

    const res = await db.execute({
      sql: `
        SELECT ts, path, props_json, referrer_host
        FROM events
        WHERE site_id = ? AND event_name = ?
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
          AND (? = 1 OR bot IS NULL)
        ORDER BY ts DESC
        LIMIT ?
      `,
      args: [site, name, from, to, inc, incBots, limit],
    });
    return c.json({ items: res.rows });
  });

  // A/B experiment results. Variants are stored once per session in
  // sessions.variants_json (json object like {"homepage": "A"}). Conversion
  // metric: sessions that fired human_interaction AND own-footage stack_start
  // (stack_start without a try_sample event in the same session).
  app.get('/ab', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const name = String(c.req.query('name') || '').trim();
    if (!/^[a-z0-9_]{1,32}$/i.test(name)) {
      return c.json({ error: 'invalid experiment name' }, 400);
    }
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const jsonPath = `$.${name}`;

    const res = await db.execute({
      sql: `
        WITH session_variant AS (
          SELECT s.id AS session_id,
                 json_extract(s.variants_json, ?) AS variant,
                 MAX(CASE WHEN e.event_name = 'human_interaction' THEN 1 ELSE 0 END) AS did_interact,
                 MAX(CASE WHEN e.event_name = 'stack_start' THEN 1 ELSE 0 END) AS did_stack_start,
                 MAX(CASE WHEN e.event_name = 'try_sample' THEN 1 ELSE 0 END) AS did_try_sample
          FROM sessions s
          JOIN events e ON e.session_id = s.id
          WHERE s.site_id = ?
            AND e.ts >= ? AND e.ts < ?
            AND (? = 1 OR COALESCE(e.role, '') != 'admin')
            AND (? = 1 OR e.bot IS NULL)
            AND json_extract(s.variants_json, ?) IS NOT NULL
          GROUP BY s.id, variant
        )
        SELECT variant,
               COUNT(*) AS participants,
               SUM(did_interact) AS interacted,
               SUM(CASE WHEN did_stack_start = 1 AND did_try_sample = 0 THEN 1 ELSE 0 END) AS own_stack_start,
               SUM(CASE WHEN did_interact = 1 AND did_stack_start = 1 AND did_try_sample = 0 THEN 1 ELSE 0 END) AS converted
        FROM session_variant
        GROUP BY variant
        ORDER BY variant
      `,
      args: [jsonPath, site, from, to, inc, incBots, jsonPath],
    });

    return c.json({
      name,
      range: { from, to },
      variants: res.rows.map(r => ({
        variant: r.variant,
        participants: Number(r.participants) || 0,
        interacted: Number(r.interacted) || 0,
        own_stack_start: Number(r.own_stack_start) || 0,
        converted: Number(r.converted) || 0,
      })),
    });
  });

  return app;
}
