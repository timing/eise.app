<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Gallery Admin</h2>

			<div v-if="!authed" class="admin-login">
				<p>Enter admin credentials to manage submissions.</p>
				<form @submit.prevent="doLogin">
					<div class="form-row">
						<label>Username</label>
						<input v-model="loginUser" type="text" required autocomplete="username" />
					</div>
					<div class="form-row">
						<label>Password</label>
						<input v-model="loginPass" type="password" required autocomplete="current-password" />
					</div>
					<div v-if="loginError" class="error-msg">{{ loginError }}</div>
					<button type="submit" class="btn-primary">Sign in</button>
				</form>
			</div>

			<template v-else>
				<div class="admin-toolbar">
					<div class="filter-tabs">
						<button v-for="s in filters" :key="s" :class="{ active: filter === s }" @click="setFilter(s)">
							{{ s }}
						</button>
					</div>
					<button class="btn-secondary" @click="logout">Sign out</button>
				</div>

				<div v-if="loading" class="admin-msg">Loading…</div>
				<div v-else-if="listError" class="admin-msg error">{{ listError }}</div>
				<div v-else-if="items.length === 0" class="admin-msg">No submissions in this bucket.</div>

				<table v-else class="admin-table">
					<thead>
						<tr>
							<th class="col-thumb">Preview</th>
							<th>Submission</th>
							<th class="col-status">Status</th>
							<th class="col-actions">Actions</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="item in items" :key="item.id" :class="'row-' + item.status">
							<td class="col-thumb">
								<a :href="item.image_url" target="_blank" rel="noopener">
									<img :src="item.thumb_url" :alt="item.name" />
								</a>
							</td>
							<td>
								<div v-if="item.title" class="submission-title">{{ item.title }}</div>
								<div class="submission-name">by {{ item.name }}</div>
								<div v-if="item.captured_at" class="submission-captured">Captured: {{ item.captured_at }}</div>
								<div v-if="item.description" class="submission-desc">{{ item.description }}</div>
								<div v-if="item.astrobin_url" class="submission-link">
									<a :href="item.astrobin_url" target="_blank" rel="noopener">Astrobin profile</a>
								</div>
								<div class="submission-meta">Submitted: {{ formatDate(item.created_at) }}</div>
							</td>
							<td class="col-status">
								<span :class="'badge badge-' + item.status">{{ item.status }}</span>
							</td>
							<td class="col-actions">
								<button v-if="item.status !== 'approved'" class="action approve" @click="act(item.id, 'approve')">Approve</button>
								<button v-if="item.status !== 'rejected'" class="action reject" @click="act(item.id, 'reject')">Reject</button>
								<button class="action danger" @click="del(item.id)">Delete</button>
							</td>
						</tr>
					</tbody>
				</table>
			</template>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';

definePageMeta({ ssr: false });

const API_BASE = 'https://gallery.eise.app';
const STORAGE_KEY = 'eise-gallery-admin-auth';
const filters = ['pending', 'approved', 'rejected', 'all'];

const authHeader = ref('');
const authed = ref(false);
const loginUser = ref('admin');
const loginPass = ref('');
const loginError = ref('');

const filter = ref('pending');
const items = ref([]);
const loading = ref(false);
const listError = ref('');

onMounted(() => {
	const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
	if (stored) {
		authHeader.value = stored;
		authed.value = true;
		fetchItems();
	}
});

async function doLogin() {
	loginError.value = '';
	const header = 'Basic ' + btoa(`${loginUser.value}:${loginPass.value}`);
	const res = await fetch(`${API_BASE}/admin/submissions?status=pending`, {
		headers: { Authorization: header },
	});
	if (res.status === 401) {
		loginError.value = 'Invalid credentials.';
		return;
	}
	if (!res.ok) {
		loginError.value = `Login failed (${res.status})`;
		return;
	}
	authHeader.value = header;
	authed.value = true;
	sessionStorage.setItem(STORAGE_KEY, header);
	loginPass.value = '';
	const body = await res.json();
	items.value = body.items || [];
}

function logout() {
	sessionStorage.removeItem(STORAGE_KEY);
	authHeader.value = '';
	authed.value = false;
	items.value = [];
}

function setFilter(s) { filter.value = s; }
watch(filter, fetchItems);

async function fetchItems() {
	if (!authed.value) return;
	loading.value = true;
	listError.value = '';
	try {
		const url = filter.value === 'all'
			? `${API_BASE}/admin/submissions`
			: `${API_BASE}/admin/submissions?status=${filter.value}`;
		const res = await fetch(url, { headers: { Authorization: authHeader.value } });
		if (res.status === 401) return logout();
		if (!res.ok) throw new Error(`Failed (${res.status})`);
		const body = await res.json();
		items.value = body.items || [];
	} catch (e) {
		listError.value = e.message;
	} finally {
		loading.value = false;
	}
}

async function act(id, action) {
	const res = await fetch(`${API_BASE}/admin/submissions/${id}/${action}`, {
		method: 'POST',
		headers: { Authorization: authHeader.value },
	});
	if (!res.ok) return alert(`Failed: ${res.status}`);
	await fetchItems();
}

async function del(id) {
	if (!confirm('Delete this submission permanently?')) return;
	const res = await fetch(`${API_BASE}/admin/submissions/${id}`, {
		method: 'DELETE',
		headers: { Authorization: authHeader.value },
	});
	if (!res.ok) return alert(`Failed: ${res.status}`);
	await fetchItems();
}

function formatDate(ts) {
	if (!ts) return '';
	return new Date(ts).toLocaleString();
}

useHead({
	title: 'Gallery Admin — Eise.app',
	meta: [{ name: 'robots', content: 'noindex, nofollow' }],
});
</script>

<style scoped>
.admin-login {
	max-width: 380px;
	margin: 1rem 0;
}
.admin-login form {
	margin-top: 1rem;
}
.form-row {
	margin-bottom: 1rem;
}
.form-row label {
	display: block;
	font-weight: bold;
	font-size: 13px;
	margin-bottom: 4px;
}
.form-row input {
	width: 100%;
	padding: 10px;
	border: 1px solid #ccc;
	border-radius: 5px;
	font-size: 14px;
	box-sizing: border-box;
}
.form-row input:focus {
	outline: none;
	border-color: #8CCF7E;
}
.error-msg {
	background: #fee;
	color: #a33;
	padding: 8px 12px;
	border-radius: 5px;
	font-size: 13px;
	margin-bottom: 12px;
}
.btn-primary {
	background: #8CCF7E;
	color: #111;
	border: none;
	border-radius: 5px;
	padding: 10px 20px;
	font-size: 14px;
	font-weight: bold;
	cursor: pointer;
}
.btn-secondary {
	background: #eee;
	color: #333;
	border: none;
	border-radius: 5px;
	padding: 8px 16px;
	font-size: 13px;
	cursor: pointer;
}
.admin-toolbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin: 1rem 0;
	gap: 1rem;
}
.filter-tabs {
	display: flex;
	gap: 4px;
}
.filter-tabs button {
	padding: 6px 14px;
	background: #f0f0f0;
	border: 1px solid #ddd;
	border-radius: 4px;
	cursor: pointer;
	font-size: 13px;
	text-transform: capitalize;
}
.filter-tabs button.active {
	background: #8CCF7E;
	color: #111;
	font-weight: bold;
	border-color: #7ABF6E;
}
.admin-msg {
	text-align: center;
	padding: 2rem 1rem;
	color: #666;
}
.admin-msg.error { color: #a33; }
.admin-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}
.admin-table th,
.admin-table td {
	padding: 10px;
	text-align: left;
	border-bottom: 1px solid #e5e5e5;
	vertical-align: top;
}
.admin-table th {
	background: #f7f7f7;
	font-weight: bold;
	font-size: 12px;
	text-transform: uppercase;
	color: #555;
}
.col-thumb { width: 100px; }
.col-thumb img {
	width: 90px;
	height: 90px;
	object-fit: contain;
	background: #000;
	border-radius: 4px;
	display: block;
}
.col-status { width: 100px; }
.col-actions { width: 180px; }
.submission-title { font-weight: bold; margin-bottom: 2px; }
.submission-name { color: #666; margin-bottom: 4px; }
.submission-captured { color: #333; font-size: 12px; margin-bottom: 4px; }
.submission-desc { color: #444; white-space: pre-wrap; margin-bottom: 4px; }
.submission-link { margin-bottom: 4px; }
.submission-link a { color: #1a5a99; }
.submission-meta { color: #888; font-size: 12px; }
.badge {
	display: inline-block;
	padding: 3px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: bold;
	text-transform: capitalize;
}
.badge-pending  { background: #fff4d6; color: #7a5a00; }
.badge-approved { background: #d6f0d6; color: #2a5a2a; }
.badge-rejected { background: #f0d6d6; color: #7a2a2a; }
.action {
	display: block;
	width: 100%;
	margin-bottom: 4px;
	padding: 6px 10px;
	border: none;
	border-radius: 4px;
	font-size: 12px;
	font-weight: bold;
	cursor: pointer;
}
.action.approve { background: #8CCF7E; color: #111; }
.action.approve:hover { background: #7ABF6E; }
.action.reject { background: #e8e8e8; color: #333; }
.action.reject:hover { background: #d8d8d8; }
.action.danger { background: #f0d6d6; color: #7a2a2a; }
.action.danger:hover { background: #e0b6b6; }
</style>
