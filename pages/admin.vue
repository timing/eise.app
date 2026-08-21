<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Admin</h2>

			<div v-if="!authed" class="admin-login">
				<p>Enter admin credentials.</p>
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
				<nav class="admin-tabs">
					<NuxtLink to="/admin" class="admin-tab" active-class="active" exact-active-class="active" :exact="true">Submissions</NuxtLink>
					<NuxtLink to="/admin/analytics" class="admin-tab" active-class="active">Analytics</NuxtLink>
					<span class="admin-tabs-spacer" />
					<button class="btn-secondary" @click="logout">Sign out</button>
				</nav>
				<NuxtPage />
			</template>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, provide, computed } from 'vue';

definePageMeta({ ssr: false });

const STORAGE_KEY = 'eise-gallery-admin-auth';
const API_BASE = typeof window !== 'undefined' && window.location.hostname === 'localhost'
	? 'http://localhost:8787'
	: 'https://gallery.eise.app';

const authHeader = ref('');
const authed = ref(false);
const loginUser = ref('admin');
const loginPass = ref('');
const loginError = ref('');

onMounted(() => {
	const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
	if (stored) {
		authHeader.value = stored;
		authed.value = true;
	}
});

async function doLogin() {
	loginError.value = '';
	const header = 'Basic ' + btoa(`${loginUser.value}:${loginPass.value}`);
	const res = await fetch(`${API_BASE}/admin/submissions?status=pending`, {
		headers: { Authorization: header },
		credentials: 'include',
	});
	if (res.status === 401) { loginError.value = 'Invalid credentials.'; return; }
	if (!res.ok) { loginError.value = `Login failed (${res.status})`; return; }
	authHeader.value = header;
	authed.value = true;
	sessionStorage.setItem(STORAGE_KEY, header);
	loginPass.value = '';
}

function logout() {
	sessionStorage.removeItem(STORAGE_KEY);
	authHeader.value = '';
	authed.value = false;
}

provide('adminAuth', {
	apiBase: API_BASE,
	authHeader: computed(() => authHeader.value),
	logout,
});

useHead({
	title: 'Admin — Eise.app',
	meta: [{ name: 'robots', content: 'noindex, nofollow' }],
});
</script>

<style scoped>
.admin-login { max-width: 380px; margin: 1rem 0; }
.admin-login form { margin-top: 1rem; }
.form-row { margin-bottom: 1rem; }
.form-row label { display: block; font-weight: bold; font-size: 13px; margin-bottom: 4px; }
.form-row input {
	width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 5px;
	font-size: 14px; box-sizing: border-box;
}
.form-row input:focus { outline: none; border-color: #8CCF7E; }
.error-msg {
	background: #fee; color: #a33; padding: 8px 12px;
	border-radius: 5px; font-size: 13px; margin-bottom: 12px;
}
.btn-primary {
	background: #8CCF7E; color: #111; border: none; border-radius: 5px;
	padding: 10px 20px; font-size: 14px; font-weight: bold; cursor: pointer;
}
.btn-secondary {
	background: #eee; color: #333; border: none; border-radius: 5px;
	padding: 8px 16px; font-size: 13px; cursor: pointer;
}
.admin-tabs {
	display: flex; align-items: center; gap: 4px;
	margin: 1rem 0 1.5rem; border-bottom: 1px solid #e5e5e5;
}
.admin-tab {
	padding: 8px 16px; text-decoration: none; color: #555;
	border-bottom: 2px solid transparent; font-size: 14px;
	margin-bottom: -1px;
}
.admin-tab:hover { color: #111; }
.admin-tab.active {
	color: #111; font-weight: bold; border-bottom-color: #8CCF7E;
}
.admin-tabs-spacer { flex: 1; }
</style>
