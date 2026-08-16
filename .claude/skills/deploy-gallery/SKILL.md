---
name: deploy-gallery
description: Build gallery-api and deploy to Bunny Edge Scripting, then smoke-test the live deployment. Use when the user asks to deploy, ship, push, publish, or release the gallery API / backend.
---

# Deploy gallery-api to Bunny Edge Scripting

## What this does

1. Verifies the Bunny CLI is installed and authenticated
2. Builds `gallery-api/` to a single ES module bundle
3. Deploys the bundle to the linked Edge Script
4. Runs the smoke script against the live URL to prove it works

## Preconditions

- `bunny` CLI installed (`npm install -g @bunny.net/cli`)
- Authenticated (`bunny login` — one-time interactive)
- `gallery-api/.bunny/script.json` exists (script is linked)
- `gallery-api/.env` has `BUNNY_STORAGE_ACCESS_KEY` and `ADMIN_PASS` for smoke testing (not deployed — env vars on the Edge Script itself come from `bunny scripts env`)

## Steps

Run from the repo root:

```bash
# 1. Verify auth
bunny whoami   # If this fails, tell user to run: bunny login

# 2. Build + deploy
cd gallery-api
npm run build           # produces dist/bundle.js
bunny scripts deploy dist/bundle.js
```

Deploy output includes the live hostname (typically `https://eise-gallery-api.b-cdn.net` and/or the custom domain `https://gallery.eise.app` if configured).

## Smoke test after deploy

```bash
# Still in gallery-api/
source .env
BASE=https://gallery.eise.app ADMIN="admin:$ADMIN_PASS" node scripts/smoke.mjs
```

Expect 8 "OK" lines. Any "FAIL" means the deployment is broken — do NOT declare success. Common failures:

- 500 on POST /submissions → likely a missing env var on the Edge Script. Check with `bunny scripts env list`. Compare against the required set:
  - Plain: `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_HOSTNAME`, `BUNNY_STORAGE_PUBLIC_URL`, `ADMIN_USER`, `CORS_ORIGIN`
  - Secret: `BUNNY_STORAGE_ACCESS_KEY`, `ADMIN_PASS`, `BUNNY_DATABASE_URL`, `BUNNY_DATABASE_AUTH_TOKEN`
- 401 on admin endpoints → `ADMIN_PASS` on the Edge Script differs from `.env`. Re-sync with `bunny scripts env set --secret ADMIN_PASS ...`.
- 404 on image_url fetch → the pull zone (`eise-gallery.b-cdn.net`) isn't serving the storage zone yet. Check in Bunny dashboard that the pull zone origin is `eise-gallery-2` storage.

## Reporting to the user

Report deploy URL, bundle size (from the build output), and smoke result. Be concise — one line each.

Example success:
> Deployed `dist/bundle.js` (99.9kb) → https://eise-gallery-api.b-cdn.net. Smoke test: 8/8 OK.

Do NOT report success on any smoke fail. Explain the failure instead.

## Do NOT

- Modify `.env`, `.bunny/script.json`, or the Edge Script env vars unless the user explicitly asks.
- Create new pull zones, storage zones, or databases — this skill only redeploys code.
- Skip the smoke test — deploy + no verify is not "done".
