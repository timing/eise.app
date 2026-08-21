const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN || 'admin:change-me';

const PNG_1x1 = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,0x89,
  0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,
  0x78,0x9c,0x63,0xfa,0xcf,0x00,0x00,0x00,0x02,0x00,0x01,
  0xe5,0x27,0xde,0xfc,
  0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
]);

const WEBP_1x1 = new Uint8Array([
  0x52,0x49,0x46,0x46, 0x1a,0x00,0x00,0x00,
  0x57,0x45,0x42,0x50,
  0x56,0x50,0x38,0x4c, 0x0d,0x00,0x00,0x00,
  0x2f,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,
]);

function ok(label, res, body) {
  console.log(`${res.ok ? 'OK ' : 'FAIL'} ${res.status} ${label}${body ? ' → ' + JSON.stringify(body).slice(0, 200) : ''}`);
  if (!res.ok) process.exitCode = 1;
}

const fd = new FormData();
fd.set('name', 'Smoke Test');
fd.set('title', 'Jupiter and Ganymede');
fd.set('description', 'automated');
fd.set('astrobin_url', 'https://astrobin.com/users/smoketester/');
fd.set('captured_at', '2026-08-01');
fd.set('image', new Blob([PNG_1x1], { type: 'image/png' }), 'full.png');
fd.set('thumb', new Blob([WEBP_1x1], { type: 'image/webp' }), 'thumb.webp');

const submit = await fetch(`${BASE}/submissions`, { method: 'POST', body: fd });
const submitBody = await submit.json();
ok('POST /submissions', submit, submitBody);
const id = submitBody.id;

const list = await fetch(`${BASE}/submissions`);
ok('GET /submissions (empty until approved)', list, await list.json());

const auth = 'Basic ' + Buffer.from(ADMIN).toString('base64');
const adminList = await fetch(`${BASE}/admin/submissions`, { headers: { Authorization: auth } });
ok('GET /admin/submissions', adminList, await adminList.json());

const approve = await fetch(`${BASE}/admin/submissions/${id}/approve`, { method: 'POST', headers: { Authorization: auth } });
ok('POST /admin/submissions/:id/approve', approve, await approve.json());

const listAfter = await fetch(`${BASE}/submissions`);
const listAfterBody = await listAfter.json();
ok('GET /submissions (after approve)', listAfter, listAfterBody);

const approved = listAfterBody.items.find(i => i.id === id);
if (approved) {
  const imgRes = await fetch(approved.image_url);
  ok(`fetch image_url ${approved.image_url}`, imgRes);
  const thumbRes = await fetch(approved.thumb_url);
  ok(`fetch thumb_url ${approved.thumb_url}`, thumbRes);
}

if (!process.env.SKIP_DELETE) {
  const del = await fetch(`${BASE}/admin/submissions/${id}`, { method: 'DELETE', headers: { Authorization: auth } });
  ok('DELETE /admin/submissions/:id', del, await del.json());
}

// Analytics endpoints (skip if not configured on the server)
if (!process.env.SKIP_ANALYTICS) {
  function extractCookie(res, name) {
    const raw = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/g);
    for (const c of raw) {
      if (!c) continue;
      const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }

  const SITE = process.env.ANALYTICS_SITE || 'smoke-test';

  const ev1 = await fetch(`${BASE}/a/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: SITE, event: 'pageview', path: '/', referrer: 'https://reddit.com/r/astrophotography/' }),
  });
  if (ev1.status === 404) {
    console.log('SKIP /a/event (analytics not configured on this server)');
  } else {
    const ev1Body = await ev1.json();
    ok('POST /a/event (new session)', ev1, ev1Body);
    const sid = extractCookie(ev1, '_eise_sid') || ev1Body.session_id;
    if (!sid) { console.log('FAIL no session_id returned'); process.exitCode = 1; }

    const ev2 = await fetch(`${BASE}/a/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `_eise_sid=${sid}` },
      body: JSON.stringify({ site_id: SITE, event: 'pageview', path: '/gallery' }),
    });
    const ev2Body = await ev2.json();
    ok('POST /a/event (reuses cookie session)', ev2, ev2Body);
    if (ev2Body.session_id !== sid) { console.log(`FAIL session_id changed: ${ev2Body.session_id} vs ${sid}`); process.exitCode = 1; }

    // Experiment stickiness
    const exp1 = await fetch(`${BASE}/a/experiment/nonexistent?site_id=${SITE}`, {
      headers: { Cookie: `_eise_sid=${sid}` },
    });
    ok('GET /a/experiment/:name (missing experiment returns variant:null)', exp1, await exp1.json());

    // Admin role tagging: fetch admin route to obtain role cookie, then send an event with it
    const adminReq = await fetch(`${BASE}/admin/submissions`, { headers: { Authorization: auth } });
    const roleToken = extractCookie(adminReq, '_eise_role');
    if (!roleToken) {
      console.log('SKIP admin role tagging (no _eise_role cookie — ANALYTICS_SALT may be unset on the server)');
    } else {
      const who = await fetch(`${BASE}/a/whoami`, {
        headers: { Cookie: `_eise_sid=${sid}; _eise_role=${roleToken}` },
      });
      const whoBody = await who.json();
      ok('GET /a/whoami (admin cookie)', who, whoBody);
      if (whoBody.role !== 'admin') { console.log(`FAIL expected role=admin, got ${whoBody.role}`); process.exitCode = 1; }

      const ev3 = await fetch(`${BASE}/a/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `_eise_sid=${sid}; _eise_role=${roleToken}` },
        body: JSON.stringify({ site_id: SITE, event: 'pageview', path: '/admin' }),
      });
      const ev3Body = await ev3.json();
      ok('POST /a/event (with admin role cookie)', ev3, ev3Body);
      if (ev3Body.role !== 'admin') { console.log(`FAIL expected role=admin on event, got ${ev3Body.role}`); process.exitCode = 1; }
    }

    // Admin analytics query endpoints
    const sitesRes = await fetch(`${BASE}/admin/analytics/sites`, { headers: { Authorization: auth } });
    ok('GET /admin/analytics/sites', sitesRes, await sitesRes.json());

    const summaryRes = await fetch(`${BASE}/admin/analytics/summary?site_id=${SITE}&include_admin=1`, { headers: { Authorization: auth } });
    ok('GET /admin/analytics/summary', summaryRes, await summaryRes.json());

    const pagesRes = await fetch(`${BASE}/admin/analytics/pages?site_id=${SITE}&include_admin=1`, { headers: { Authorization: auth } });
    ok('GET /admin/analytics/pages', pagesRes, await pagesRes.json());

    const refRes = await fetch(`${BASE}/admin/analytics/referrers?site_id=${SITE}&include_admin=1`, { headers: { Authorization: auth } });
    const refBody = await refRes.json();
    ok('GET /admin/analytics/referrers', refRes, refBody);
    const firstHost = (refBody.items || [])[0]?.referrer_host;
    if (firstHost) {
      const urlsRes = await fetch(`${BASE}/admin/analytics/referrers/urls?site_id=${SITE}&host=${encodeURIComponent(firstHost)}&include_admin=1`, { headers: { Authorization: auth } });
      ok(`GET /admin/analytics/referrers/urls (host=${firstHost})`, urlsRes, await urlsRes.json());
    }

    const evtsRes = await fetch(`${BASE}/admin/analytics/events?site_id=${SITE}&include_admin=1`, { headers: { Authorization: auth } });
    ok('GET /admin/analytics/events', evtsRes, await evtsRes.json());
  }
}
