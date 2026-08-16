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
