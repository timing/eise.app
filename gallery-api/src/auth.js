import { basicAuth } from 'hono/basic-auth';

export function adminAuth(env) {
  return basicAuth({
    username: env.ADMIN_USER || 'admin',
    password: env.ADMIN_PASS || 'change-me',
    realm: 'eise gallery admin',
  });
}
