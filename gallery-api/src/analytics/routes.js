import { Hono } from 'hono';
import {
  SESSION_COOKIE,
  parseCookies,
  sessionCookieHeader,
  randUuid,
  visitorHash,
  parseUserAgent,
  parseReferrer,
  parseUtm,
  readCountry,
  normalizePath,
} from './session.js';
import { ROLE_COOKIE, verifyRoleToken } from './roleCookie.js';

const MAX_PROPS_BYTES = 16384;  // Bumped from 4KB to fit stack_ping log deltas + stack_failed log tails.
const MAX_EVENT_NAME_LEN = 64;
const MAX_PATH_LEN = 2048;

function clientIp(c) {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return c.req.header('x-real-ip') || null;
}

function resolveSessionId(c, bodySessionId) {
  const cookies = parseCookies(c.req.header('cookie'));
  const fromCookie = cookies[SESSION_COOKIE];
  if (fromCookie && /^[0-9a-f-]{32,36}$/i.test(fromCookie)) return { id: fromCookie, source: 'cookie' };

  const headerSid = c.req.header('x-session-id');
  if (headerSid && /^[0-9a-f-]{32,36}$/i.test(headerSid)) return { id: headerSid, source: 'header' };

  if (bodySessionId && /^[0-9a-f-]{32,36}$/i.test(bodySessionId)) return { id: bodySessionId, source: 'body' };

  return { id: randUuid(), source: 'new' };
}

function hashBucket(sessionId, experimentId) {
  let h = 2166136261;
  const s = `${sessionId}|${experimentId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function pickVariant(variants, weights, bucket) {
  if (!weights || weights.length !== variants.length) {
    return variants[Math.floor(bucket * variants.length) % variants.length];
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < variants.length; i++) {
    acc += weights[i] / total;
    if (bucket <= acc) return variants[i];
  }
  return variants[variants.length - 1];
}

export function createAnalyticsRoutes({ db, env }) {
  const app = new Hono();
  const salt = env.ANALYTICS_SALT || 'change-me-in-production';

  app.post('/event', async c => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid json' }, 400); }

    const siteId = String(body.site_id || '').slice(0, 64);
    const eventName = String(body.event || '').slice(0, MAX_EVENT_NAME_LEN);
    if (!siteId) return c.json({ error: 'site_id required' }, 400);
    if (!eventName) return c.json({ error: 'event required' }, 400);

    const { id: sessionId, source } = resolveSessionId(c, body.session_id);
    const path = body.path ? normalizePath(String(body.path).slice(0, MAX_PATH_LEN)) : null;
    const referrer = body.referrer ? String(body.referrer).slice(0, 2000) : null;
    const userId = body.user_id ? String(body.user_id).slice(0, 128) : null;
    const variant = body.variant ? String(body.variant).slice(0, 64) : null;

    // Extract A/B variants. New clients send them at top-level `body.variants`
    // (e.g. { homepage: "A" }). Older cached clients still shove them into
    // props as `ab_<name>`; accept those too and strip from props so events
    // stay clean. Variants are stored once on the session, not on every event.
    const variants = {};
    if (body.variants && typeof body.variants === 'object') {
      for (const [k, v] of Object.entries(body.variants)) {
        if (typeof v === 'string' && v.length <= 32 && /^[a-z0-9_]{1,32}$/i.test(k)) {
          variants[k] = v.slice(0, 32);
        }
      }
    }
    let propsObj = null;
    if (body.props && typeof body.props === 'object') {
      propsObj = {};
      for (const [k, v] of Object.entries(body.props)) {
        if (k.startsWith('ab_')) {
          const name = k.slice(3);
          if (typeof v === 'string' && v.length <= 32 && /^[a-z0-9_]{1,32}$/i.test(name) && !(name in variants)) {
            variants[name] = v.slice(0, 32);
          }
          continue;
        }
        propsObj[k] = v;
      }
      if (Object.keys(propsObj).length === 0) propsObj = null;
    }
    let propsJson = null;
    if (propsObj) {
      const s = JSON.stringify(propsObj);
      if (s.length > MAX_PROPS_BYTES) return c.json({ error: 'props too large' }, 400);
      propsJson = s;
    }
    const variantsJson = Object.keys(variants).length ? JSON.stringify(variants) : null;

    const ip = clientIp(c);
    const ua = c.req.header('user-agent') || '';
    const country = readCountry(c);
    const vh = await visitorHash(salt, ip, ua);
    const ref = parseReferrer(referrer);
    const utm = parseUtm(body.path ? String(body.path) : null);
    // If no HTTP referrer but UTM source is set, treat UTM source as synthetic referrer.
    // Real referrers still win when both are present.
    if (!ref.host && utm.source) {
      ref.host = String(utm.source).toLowerCase().slice(0, 128);
    }
    const ts = Date.now();

    const cookies = parseCookies(c.req.header('cookie'));
    const roleToken = cookies[ROLE_COOKIE];
    const verified = roleToken ? await verifyRoleToken(salt, roleToken) : null;
    const role = verified ? verified.role : null;

    // Bunny Shield adds CDN-Bot only when a bot is detected. Format example:
    // "googlebot; category=SEO; verified=yes; action=allow". Store the raw
    // header so we can filter it out of analytics and still inspect it later.
    const cdnBot = c.req.header('cdn-bot');
    const bot = cdnBot ? String(cdnBot).slice(0, 256) : null;

    const existing = await db.execute({
      sql: 'SELECT id FROM sessions WHERE id = ? LIMIT 1',
      args: [sessionId],
    });

    if (existing.rows.length === 0) {
      const uaInfo = parseUserAgent(ua);
      await db.execute({
        sql: `INSERT INTO sessions (
          id, site_id, first_ts, last_ts,
          first_referrer_url, first_referrer_host,
          first_utm_source, first_utm_medium, first_utm_campaign, first_utm_term, first_utm_content,
          country, ua_browser, ua_os, ua_device, role, bot, variants_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          sessionId, siteId, ts, ts,
          ref.url, ref.host,
          utm.source, utm.medium, utm.campaign, utm.term, utm.content,
          country, uaInfo.browser, uaInfo.os, uaInfo.device, role, bot, variantsJson,
        ],
      });
    } else {
      // Merge variants: if a new key comes in that isn't already stored, add it.
      // json_patch keeps existing keys and overwrites with new values only where present.
      await db.execute({
        sql: `UPDATE sessions SET last_ts = ?,
                role = CASE WHEN ? IS NOT NULL THEN ? ELSE role END,
                bot  = CASE WHEN ? IS NOT NULL THEN ? ELSE bot  END,
                variants_json = CASE
                  WHEN ? IS NULL THEN variants_json
                  WHEN variants_json IS NULL THEN ?
                  ELSE json_patch(variants_json, ?)
                END
              WHERE id = ?`,
        args: [ts, role, role, bot, bot, variantsJson, variantsJson, variantsJson, sessionId],
      });
    }

    await db.execute({
      sql: `INSERT INTO events (
        site_id, session_id, user_id, ts, event_name,
        path, referrer_url, referrer_host, referrer_path,
        visitor_hash, props_json, variant, role, bot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        siteId, sessionId, userId, ts, eventName,
        path, ref.url, ref.host, ref.path,
        vh, propsJson, variant, role, bot,
      ],
    });

    if (source === 'new' || source === 'body') {
      c.header('Set-Cookie', sessionCookieHeader(sessionId));
    }
    return c.json({ ok: true, session_id: sessionId, role });
  });

  app.get('/whoami', async c => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies[SESSION_COOKIE] || null;
    const roleToken = cookies[ROLE_COOKIE];
    const verified = roleToken ? await verifyRoleToken(salt, roleToken) : null;
    return c.json({
      session_id: sessionId,
      role: verified ? verified.role : null,
      expires_at: verified ? verified.exp : null,
    });
  });

  app.get('/experiment/:name', async c => {
    const name = c.req.param('name');
    const siteId = c.req.query('site_id');
    if (!siteId) return c.json({ error: 'site_id required' }, 400);

    const { id: sessionId, source } = resolveSessionId(c, c.req.query('session_id'));

    const exp = await db.execute({
      sql: 'SELECT id, variants_json, traffic_split_json, active FROM experiments WHERE site_id = ? AND name = ?',
      args: [siteId, name],
    });
    if (exp.rows.length === 0 || !exp.rows[0].active) {
      return c.json({ variant: null, session_id: sessionId });
    }
    const expId = exp.rows[0].id;
    const variants = JSON.parse(exp.rows[0].variants_json);
    const weights = exp.rows[0].traffic_split_json ? JSON.parse(exp.rows[0].traffic_split_json) : null;

    const existing = await db.execute({
      sql: 'SELECT variant FROM experiment_assignments WHERE session_id = ? AND experiment_id = ?',
      args: [sessionId, expId],
    });

    let variant;
    if (existing.rows.length > 0) {
      variant = existing.rows[0].variant;
    } else {
      variant = pickVariant(variants, weights, hashBucket(sessionId, expId));
      await db.execute({
        sql: `INSERT OR IGNORE INTO experiment_assignments (session_id, experiment_id, variant, assigned_at)
              VALUES (?, ?, ?, ?)`,
        args: [sessionId, expId, variant, Date.now()],
      });
    }

    if (source === 'new') {
      c.header('Set-Cookie', sessionCookieHeader(sessionId));
    }
    return c.json({ variant, session_id: sessionId });
  });

  return app;
}
