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

  app.get('/timeseries', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const bucket = c.req.query('bucket') === 'hour' ? 'hour' : 'day';
    const eventName = String(c.req.query('event_name') || 'pageview').slice(0, 64);
    const bucketMs = bucket === 'hour' ? 3600000 : 86400000;

    const res = await db.execute({
      sql: `
        SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket_ts,
               COUNT(*) AS count,
               COUNT(DISTINCT session_id) AS sessions,
               COUNT(DISTINCT visitor_hash) AS uniques
        FROM events
        WHERE site_id = ? AND event_name = ?
          AND ts >= ? AND ts < ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
          AND (? = 1 OR bot IS NULL)
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      args: [site, eventName, from, to, inc, incBots],
    });

    return c.json({
      bucket,
      bucket_ms: bucketMs,
      event_name: eventName,
      range: { from, to },
      items: res.rows,
    });
  });

  app.get('/live', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const windowMs = 5 * 60 * 1000;
    const now = Date.now();
    const from = now - windowMs;

    const res = await db.execute({
      sql: `
        SELECT COUNT(*) AS pageviews,
               COUNT(DISTINCT visitor_hash) AS visitors
        FROM events
        WHERE site_id = ? AND event_name = 'pageview'
          AND ts >= ?
          AND (? = 1 OR COALESCE(role, '') != 'admin')
          AND (? = 1 OR bot IS NULL)
      `,
      args: [site, from, inc, incBots],
    });
    const row = res.rows[0] || { pageviews: 0, visitors: 0 };
    return c.json({
      window_ms: windowMs,
      now,
      pageviews: Number(row.pageviews) || 0,
      visitors: Number(row.visitors) || 0,
    });
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

  // Distinct experiment names ever seen for a site — powers the A/B dropdown
  // so we can look up historical (finalized) experiments too.
  app.get('/ab-experiments', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const res = await db.execute({
      sql: `
        SELECT DISTINCT j.key AS name,
               COUNT(DISTINCT s.id) AS sessions,
               MAX(s.last_ts) AS last_ts
        FROM sessions s, json_each(s.variants_json) j
        WHERE s.site_id = ? AND s.variants_json IS NOT NULL
        GROUP BY j.key
        ORDER BY last_ts DESC
      `,
      args: [site],
    });
    return c.json({ items: res.rows });
  });

  // A/B experiment results. Variants are stored once per session in
  // sessions.variants_json (json object like {"homepage": "A"}). Conversion
  // metric: sessions that fired human_interaction AND the experiment's
  // success event without a try_sample event in the same session.
  //
  // Default success event is stack_start; experiments where the variant only
  // affects the pipeline downstream of the stack starting (e.g. video_reader,
  // which changes video decoding) override this with stack_finished so the
  // metric reflects whether the pipeline actually completed.
  //
  // Some experiments only affect a subset of users (e.g. video_reader only
  // changes behavior when a user uploads a video-format file). For those, we
  // restrict the participant pool to sessions that actually reached the code
  // path so unaffected users don't dilute the signal.
  const DEFAULT_SUCCESS_EVENT = 'stack_start';
  const EXPERIMENT_CONFIG = {
    // social_proof_counter: variant B shows a "N Stacks today" badge between
    // the logo and the nav on desktop. Enrollment is gated on desktop in the
    // layout mount, and each enrolled session fires social_proof_counter_view.
    // Restricting the pool to sessions that fired that event keeps out any
    // stale variants_json entries from other experiments.
    social_proof_counter: {
      successEvent: 'stack_start',
      label: 'Desktop-only "N Stacks today" badge between logo and nav (variant B). ' +
             'Restricted to sessions that fired social_proof_counter_view (i.e. actually loaded on desktop).',
      predicate: "SUM(CASE WHEN e.event_name = 'social_proof_counter_view' THEN 1 ELSE 0 END) > 0",
    },
    // video_reader: variant B skips mediabunny for videos. Only sessions that
    // fired a stack_start on a video-format file exercise the differing code
    // path. Success = the video stack actually finished.
    //
    // gpu_enabled=1 is required because the mediabunny/ffmpeg branching in
    // FileUploader.vue is gated on `effectiveUseGpu.value && variant !== 'B'`.
    // CPU-mode users take the ffmpeg path in BOTH variants — including them
    // dilutes the pool with sessions that were never affected by the split.
    video_reader: {
      successEvent: 'stack_finished',
      label: 'Restricted to sessions that started a GPU-mode stack on a video (mp4/mov/webm/etc.). ' +
             'SER, AVI, image, and CPU-mode uploads are excluded because the variant does not affect them.',
      predicate: "SUM(CASE WHEN e.event_name = 'stack_start' AND json_extract(e.props_json, '$.file_type') = 'video' AND json_extract(e.props_json, '$.gpu_enabled') = 1 THEN 1 ELSE 0 END) > 0",
    },
  };

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
    const expConfig = EXPERIMENT_CONFIG[name];
    const successEvent = expConfig?.successEvent || DEFAULT_SUCCESS_EVENT;
    const havingClause = expConfig?.predicate ? `HAVING ${expConfig.predicate}` : '';

    const res = await db.execute({
      sql: `
        WITH session_variant AS (
          SELECT s.id AS session_id,
                 json_extract(s.variants_json, ?) AS variant,
                 MAX(CASE WHEN e.event_name = 'human_interaction' THEN 1 ELSE 0 END) AS did_interact,
                 MAX(CASE WHEN e.event_name = ? THEN 1 ELSE 0 END) AS did_succeed,
                 MAX(CASE WHEN e.event_name = 'try_sample' THEN 1 ELSE 0 END) AS did_try_sample
          FROM sessions s
          JOIN events e ON e.session_id = s.id
          WHERE s.site_id = ?
            AND e.ts >= ? AND e.ts < ?
            AND (? = 1 OR COALESCE(e.role, '') != 'admin')
            AND (? = 1 OR e.bot IS NULL)
            AND json_extract(s.variants_json, ?) IS NOT NULL
          GROUP BY s.id, variant
          ${havingClause}
        )
        SELECT variant,
               COUNT(*) AS participants,
               SUM(did_interact) AS interacted,
               SUM(CASE WHEN did_succeed = 1 AND did_try_sample = 0 THEN 1 ELSE 0 END) AS own_conversion,
               SUM(CASE WHEN did_interact = 1 AND did_succeed = 1 AND did_try_sample = 0 THEN 1 ELSE 0 END) AS converted
        FROM session_variant
        GROUP BY variant
        ORDER BY variant
      `,
      args: [jsonPath, successEvent, site, from, to, inc, incBots, jsonPath],
    });

    return c.json({
      name,
      range: { from, to },
      success_event: successEvent,
      filter: expConfig?.label ? { label: expConfig.label } : null,
      variants: res.rows.map(r => ({
        variant: r.variant,
        participants: Number(r.participants) || 0,
        interacted: Number(r.interacted) || 0,
        own_conversion: Number(r.own_conversion) || 0,
        converted: Number(r.converted) || 0,
      })),
    });
  });

  // Stack jobs: one row per stack_job_id, aggregating stack_* events for the
  // mediabunny reliability debugging surface. Terminal state derived from
  // whether stack_finished / stack_failed / stack_cancelled fired.
  app.get('/stack-jobs', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    const { from, to } = parseRange(c);
    const inc = includeAdmin(c);
    const incBots = includeBots(c);
    const limit = limitArg(c, 100);
    const outcome = String(c.req.query('outcome') || '').toLowerCase();

    const res = await db.execute({
      sql: `
        WITH j AS (
          SELECT json_extract(props_json, '$.stack_job_id') AS job_id,
                 MIN(session_id) AS session_id,
                 MIN(ts) AS first_ts,
                 MAX(ts) AS last_ts,
                 COUNT(*) AS events,
                 SUM(CASE WHEN event_name = 'stack_step' THEN 1 ELSE 0 END) AS steps,
                 SUM(CASE WHEN event_name = 'stack_ping' THEN 1 ELSE 0 END) AS pings,
                 MAX(CASE WHEN event_name = 'stack_start' THEN 1 ELSE 0 END) AS started,
                 MAX(CASE WHEN event_name = 'stack_finished' THEN 1 ELSE 0 END) AS finished,
                 MAX(CASE WHEN event_name = 'stack_failed' THEN 1 ELSE 0 END) AS failed,
                 MAX(CASE WHEN event_name = 'stack_cancelled' THEN 1 ELSE 0 END) AS cancelled,
                 MAX(json_extract(props_json, '$.reader')) AS reader,
                 MAX(json_extract(props_json, '$.file_type')) AS file_type,
                 MAX(json_extract(props_json, '$.gpu_enabled')) AS gpu_enabled,
                 MAX(CASE WHEN event_name = 'stack_step'
                          THEN json_extract(props_json, '$.step') END) AS any_step,
                 MAX(CASE WHEN event_name = 'stack_ping'
                          THEN CAST(json_extract(props_json, '$.errors') AS INTEGER) END) AS max_errors,
                 MAX(CASE WHEN event_name = 'stack_ping'
                          THEN CAST(json_extract(props_json, '$.mem_used_mb') AS INTEGER) END) AS max_mem_mb,
                 MAX(CASE WHEN event_name = 'stack_failed'
                          THEN json_extract(props_json, '$.reason') END) AS fail_reason,
                 MAX(CASE WHEN event_name = 'stack_rating'
                          THEN CAST(json_extract(props_json, '$.rating') AS INTEGER) END) AS rating,
                 MAX(CASE WHEN event_name = 'stack_rating'
                          THEN json_extract(props_json, '$.comment') END) AS rating_comment
          FROM events
          WHERE site_id = ?
            AND event_name LIKE 'stack\\_%' ESCAPE '\\'
            AND json_extract(props_json, '$.stack_job_id') IS NOT NULL
            AND ts >= ? AND ts < ?
            AND (? = 1 OR COALESCE(role, '') != 'admin')
            AND (? = 1 OR bot IS NULL)
          GROUP BY job_id
        )
        SELECT j.*,
               s.ua_device AS device, s.ua_os AS os, s.ua_browser AS browser
        FROM j
        LEFT JOIN sessions s ON s.id = j.session_id
        ORDER BY j.last_ts DESC
        LIMIT ?
      `,
      args: [site, from, to, inc, incBots, limit],
    });

    let items = res.rows.map(r => {
      let outcomeVal = 'pending';
      if (r.finished) outcomeVal = 'finished';
      else if (r.failed) outcomeVal = 'failed';
      else if (r.cancelled) outcomeVal = 'cancelled';
      else if (r.started) outcomeVal = 'silent';  // Started but no terminal event.
      // Continuous-stacking artifact — legacy bucket. Historically, every
      // post-processor Prev/Next click called setInputFilename which minted a
      // new stack_job_id, and the ping timer from the parent stack (which
      // handleStackedImageReady doesn't stop in continuous mode) would tag a
      // couple of pings with that fresh id, producing dozens of "jobs" per
      // session that were really UI navigation. Fixed by splitting
      // setInputFilename from startNewStackJob; existing rows keep this label
      // for continuity, new sessions shouldn't produce it after deploy.
      else if (r.pings > 0 && !r.steps) outcomeVal = 'continuous';
      return { ...r, outcome: outcomeVal };
    });
    if (outcome) items = items.filter(x => x.outcome === outcome);
    return c.json({ range: { from, to }, items });
  });

  app.get('/stack-jobs/:jobId', async c => {
    const site = siteId(c);
    if (!site) return c.json({ error: 'site_id required' }, 400);
    // Job IDs are 8 base-36 chars per useProcessingState.js:shortJobHash.
    const jobId = String(c.req.param('jobId') || '').slice(0, 32);
    if (!/^[a-z0-9]+$/i.test(jobId)) return c.json({ error: 'invalid job id' }, 400);

    const res = await db.execute({
      sql: `
        SELECT event_name, ts, session_id, props_json
        FROM events
        WHERE site_id = ?
          AND json_extract(props_json, '$.stack_job_id') = ?
        ORDER BY ts ASC
        LIMIT 5000
      `,
      args: [site, jobId],
    });

    const items = res.rows.map(r => {
      let props = null;
      try { props = r.props_json ? JSON.parse(r.props_json) : null; } catch (_) {}
      return { event_name: r.event_name, ts: r.ts, session_id: r.session_id, props };
    });

    // One session's UA info is enough — a stack job lives inside a single session.
    let session_info = null;
    const sessionId = items[0]?.session_id;
    if (sessionId) {
      const s = await db.execute({
        sql: 'SELECT ua_device, ua_os, ua_browser, country FROM sessions WHERE id = ? LIMIT 1',
        args: [sessionId],
      });
      const row = s.rows[0];
      if (row) session_info = { device: row.ua_device, os: row.ua_os, browser: row.ua_browser, country: row.country };
    }

    return c.json({ job_id: jobId, session_info, items });
  });

  return app;
}
