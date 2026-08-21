export const SESSION_COOKIE = '_eise_sid';
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 395; // ~13 months

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

export function sessionCookieHeader(sid) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function randUuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function visitorHash(secret, ip, ua) {
  const date = new Date().toISOString().slice(0, 10);
  const buf = new TextEncoder().encode(`${secret}|${date}|${ip || ''}|${ua || ''}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

export function parseUserAgent(ua) {
  if (!ua) return { browser: null, os: null, device: 'desktop' };
  const uaL = ua.toLowerCase();

  let browser = null;
  if (uaL.includes('edg/')) browser = 'Edge';
  else if (uaL.includes('opr/') || uaL.includes('opera')) browser = 'Opera';
  else if (uaL.includes('chrome/')) browser = 'Chrome';
  else if (uaL.includes('firefox/')) browser = 'Firefox';
  else if (uaL.includes('safari/')) browser = 'Safari';

  let os = null;
  if (uaL.includes('windows')) os = 'Windows';
  else if (uaL.includes('android')) os = 'Android';
  else if (uaL.includes('iphone') || uaL.includes('ipad') || uaL.includes('ios')) os = 'iOS';
  else if (uaL.includes('mac os x') || uaL.includes('macos')) os = 'macOS';
  else if (uaL.includes('linux')) os = 'Linux';

  let device = 'desktop';
  if (uaL.includes('mobile')) device = 'mobile';
  else if (uaL.includes('tablet') || uaL.includes('ipad')) device = 'tablet';

  return { browser, os, device };
}

export function normalizePath(p) {
  if (!p) return p;
  const qIdx = p.indexOf('?');
  const pathPart = qIdx === -1 ? p : p.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : p.slice(qIdx);
  const trimmed = pathPart.replace(/\/+$/, '') || '/';
  return trimmed + queryPart;
}

export function parseReferrer(referrer) {
  if (!referrer || typeof referrer !== 'string') return { url: null, host: null, path: null };
  try {
    const u = new URL(referrer);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: null, host: null, path: null };
    return {
      url: referrer.slice(0, 2000),
      host: u.hostname.replace(/^www\./, '').toLowerCase(),
      path: u.pathname,
    };
  } catch {
    return { url: null, host: null, path: null };
  }
}

export function parseUtm(pathOrUrl) {
  const empty = { source: null, medium: null, campaign: null, term: null, content: null };
  if (!pathOrUrl) return empty;
  try {
    const u = new URL(pathOrUrl, 'http://x');
    return {
      source: u.searchParams.get('utm_source'),
      medium: u.searchParams.get('utm_medium'),
      campaign: u.searchParams.get('utm_campaign'),
      term: u.searchParams.get('utm_term'),
      content: u.searchParams.get('utm_content'),
    };
  } catch {
    return empty;
  }
}

export function readCountry(c) {
  return c.req.header('cdn-requestcountrycode')
    || c.req.header('cf-ipcountry')
    || c.req.header('x-country')
    || c.req.header('bunny-country')
    || null;
}
