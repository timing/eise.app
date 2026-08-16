# gallery-api

Small Hono backend for the Eise gallery submission flow.

Runs anywhere Hono runs. Local dev uses `@hono/node-server`. Production target: Bunny Edge Scripting.

## Local dev

```bash
cd gallery-api
cp .env.example .env
# edit .env — ADMIN_PASS at minimum
npm install
npm run dev
# → http://localhost:8787
```

Storage falls back to `./uploads/` and DB to `./gallery.db` when Bunny env vars are absent.

## Endpoints

Public:
- `POST /submissions` — multipart: `name`, `description`, `astrobin_url`, `image` (PNG), `thumb` (WebP)
- `GET /submissions` — approved list

Admin (HTTP Basic Auth: `ADMIN_USER` / `ADMIN_PASS`):
- `GET /admin/submissions[?status=pending|approved|rejected]`
- `POST /admin/submissions/:id/approve`
- `POST /admin/submissions/:id/reject`
- `DELETE /admin/submissions/:id`

## Deploy to Bunny Edge Scripting

Deploy path is TBD; the `createApp(env).fetch` handler is compatible with Bunny's fetch-based runtime.
