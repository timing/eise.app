export const ROLE_COOKIE = '_eise_role';
const DEFAULT_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signRoleToken(secret, role, maxAgeSec = DEFAULT_MAX_AGE_SEC) {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const payload = `${role}.${exp}`;
  const sig = await hmacSha256(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyRoleToken(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [role, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const expected = await hmacSha256(secret, `${role}.${exp}`);
  if (!safeEqual(sig, expected)) return null;
  return { role, exp };
}

export function roleCookieHeader(token, { domain = null, maxAgeSec = DEFAULT_MAX_AGE_SEC } = {}) {
  const parts = [
    `${ROLE_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}
