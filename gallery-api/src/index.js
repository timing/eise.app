import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createDb, initSchema } from './db.js';
import { createStorage } from './storage.js';
import { adminAuth } from './auth.js';
import { createAnalyticsDb, initAnalyticsSchema } from './analytics/db.js';
import { createAnalyticsRoutes } from './analytics/routes.js';
import { createAnalyticsAdminRoutes } from './analytics/adminRoutes.js';
import { signRoleToken, roleCookieHeader } from './analytics/roleCookie.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_MAGIC_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC_WEBP = [0x57, 0x45, 0x42, 0x50];

function isPng(bytes) {
  if (bytes.length < 8) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

function isWebp(bytes) {
  if (bytes.length < 12) return false;
  const riff = WEBP_MAGIC_RIFF.every((b, i) => bytes[i] === b);
  const webp = WEBP_MAGIC_WEBP.every((b, i) => bytes[8 + i] === b);
  return riff && webp;
}

function validAstrobinUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)astrobin\.com$/.test(u.hostname);
  } catch { return false; }
}

function validCapturedAt(s) {
  if (!s) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}

function randId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function clientIp(c) {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = c.req.header('x-real-ip');
  if (xri) return xri.trim();
  return null;
}

export function createApp(env) {
  const app = new Hono();
  const db = createDb(env);
  const storage = createStorage(env);
  const maxImageBytes = Number(env.MAX_IMAGE_BYTES || 20 * 1024 * 1024);
  const maxThumbBytes = 500 * 1024;
  const rateLimitMax = Number(env.RATE_LIMIT_MAX_PER_HOUR || 5);
  const rateLimitWindowMs = 60 * 60 * 1000;

  const origins = (env.CORS_ORIGIN || 'http://localhost:3000,https://eise.app').split(',').map(s => s.trim());
  app.use('*', cors({
    origin: origins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
    credentials: true,
  }));

  const analyticsDb = createAnalyticsDb(env);
  if (analyticsDb) {
    app.route('/a', createAnalyticsRoutes({ db: analyticsDb, env }));
  }

  app.get('/health', c => c.json({ ok: true }));

  app.post('/submissions', async c => {
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    const title = (body.title || '').toString().trim();
    const description = (body.description || '').toString().trim();
    const astrobinUrl = (body.astrobin_url || '').toString().trim();
    const capturedAt = (body.captured_at || '').toString().trim();
    const image = body.image;
    const thumb = body.thumb;

    if (name.length < 1 || name.length > 80) return c.json({ error: 'name must be 1-80 chars' }, 400);
    if (title.length > 120) return c.json({ error: 'title too long' }, 400);
    if (description.length > 2000) return c.json({ error: 'description too long' }, 400);
    if (!validAstrobinUrl(astrobinUrl)) return c.json({ error: 'invalid astrobin url' }, 400);
    if (!validCapturedAt(capturedAt)) return c.json({ error: 'invalid capture date (use YYYY-MM-DD, not in the future)' }, 400);
    if (!(image instanceof File) || !(thumb instanceof File)) return c.json({ error: 'image and thumb required' }, 400);
    if (image.size > maxImageBytes) return c.json({ error: 'image too large' }, 400);
    if (thumb.size > maxThumbBytes) return c.json({ error: 'thumb too large' }, 400);

    const ip = clientIp(c);
    if (ip) {
      const since = Date.now() - rateLimitWindowMs;
      const recent = await db.execute({
        sql: `SELECT COUNT(*) AS cnt FROM submissions WHERE ip = ? AND created_at > ?`,
        args: [ip, since],
      });
      const count = Number(recent.rows[0]?.cnt || 0);
      if (count >= rateLimitMax) {
        return c.json({ error: `Rate limit: max ${rateLimitMax} submissions per hour. Try again later.` }, 429);
      }
    }

    const imageBytes = new Uint8Array(await image.arrayBuffer());
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    if (!isPng(imageBytes)) return c.json({ error: 'image must be PNG' }, 400);
    if (!isWebp(thumbBytes)) return c.json({ error: 'thumb must be WebP' }, 400);

    const id = randId();
    const imagePath = `${id}/full.png`;
    const thumbPath = `${id}/thumb.webp`;
    await storage.put(imagePath, imageBytes, 'image/png');
    await storage.put(thumbPath, thumbBytes, 'image/webp');

    const createdAt = Date.now();
    await db.execute({
      sql: `INSERT INTO submissions (id, name, title, description, astrobin_url, status, image_path, thumb_path, created_at, captured_at, ip)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      args: [id, name, title || null, description || null, astrobinUrl || null, imagePath, thumbPath, createdAt, capturedAt || null, ip],
    });

    return c.json({ id, status: 'pending' }, 201);
  });

  app.get('/submissions', async c => {
    const limit = Math.min(Number(c.req.query('limit') || 60), 200);
    const offset = Math.max(Number(c.req.query('offset') || 0), 0);
    const res = await db.execute({
      sql: `SELECT id, name, title, description, astrobin_url, image_path, thumb_path, created_at, approved_at, captured_at
            FROM submissions WHERE status = 'approved'
            ORDER BY approved_at DESC LIMIT ? OFFSET ?`,
      args: [limit, offset],
    });
    return c.json({ items: res.rows.map(row => publicRow(row, storage)) });
  });

  const admin = new Hono();
  admin.use('*', adminAuth(env));
  admin.use('*', async (c, next) => {
    if (env.ANALYTICS_SALT) {
      const token = await signRoleToken(env.ANALYTICS_SALT, 'admin');
      c.header('Set-Cookie', roleCookieHeader(token, { domain: env.ADMIN_COOKIE_DOMAIN || null }));
    }
    await next();
  });

  admin.get('/submissions', async c => {
    const status = c.req.query('status');
    const sql = status
      ? `SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC`
      : `SELECT * FROM submissions ORDER BY created_at DESC`;
    const res = await db.execute({ sql, args: status ? [status] : [] });
    return c.json({ items: res.rows.map(row => adminRow(row, storage)) });
  });

  admin.post('/submissions/:id/approve', async c => {
    const id = c.req.param('id');
    await db.execute({
      sql: `UPDATE submissions SET status = 'approved', approved_at = ? WHERE id = ?`,
      args: [Date.now(), id],
    });
    return c.json({ ok: true });
  });

  admin.post('/submissions/:id/reject', async c => {
    const id = c.req.param('id');
    await db.execute({
      sql: `UPDATE submissions SET status = 'rejected', approved_at = NULL WHERE id = ?`,
      args: [id],
    });
    return c.json({ ok: true });
  });

  admin.delete('/submissions/:id', async c => {
    const id = c.req.param('id');
    const row = await db.execute({ sql: `SELECT image_path, thumb_path FROM submissions WHERE id = ?`, args: [id] });
    if (row.rows[0]) {
      await storage.delete(row.rows[0].image_path);
      await storage.delete(row.rows[0].thumb_path);
    }
    await db.execute({ sql: `DELETE FROM submissions WHERE id = ?`, args: [id] });
    return c.json({ ok: true });
  });

  if (analyticsDb) {
    admin.route('/analytics', createAnalyticsAdminRoutes({ db: analyticsDb }));
  }

  app.route('/admin', admin);

  app.__init = async () => {
    await initSchema(db);
    if (analyticsDb) await initAnalyticsSchema(analyticsDb);
  };
  return app;
}

function publicRow(row, storage) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    astrobin_url: row.astrobin_url,
    captured_at: row.captured_at,
    image_url: storage.publicUrlFor(row.image_path),
    thumb_url: storage.publicUrlFor(row.thumb_path),
    approved_at: row.approved_at,
  };
}

function adminRow(row, storage) {
  return { ...publicRow(row, storage), status: row.status, created_at: row.created_at };
}
