import { serve } from '@hono/node-server';
import { createApp } from './index.js';

const app = createApp(process.env);
await app.__init();

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port });
console.log(`gallery-api listening on http://localhost:${port}`);
