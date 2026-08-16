<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Eise Gallery</h2>
			<p>Stacks published by the community, made with Eise.app. Want yours here? <NuxtLink to="/">Stack an image</NuxtLink> and hit Publish.</p>

			<div v-if="loading" class="gallery-msg">Loading gallery…</div>
			<div v-else-if="error" class="gallery-msg error">{{ error }}</div>
			<div v-else-if="items.length === 0" class="gallery-msg">
				No published stacks yet — the gallery just launched on 16 August 2026. Be the first.
			</div>

			<div v-else class="gallery-grid">
				<button v-for="item in items" :key="item.id" class="gallery-card" @click="selected = item" :title="cardTitle(item)">
					<img :src="item.thumb_url" :alt="item.title || item.name" loading="lazy" />
					<div class="gallery-card-name">
						<span v-if="item.title" class="card-title">{{ item.title }}</span>
						<span class="card-by">by {{ item.name }}</span>
					</div>
				</button>
			</div>
		</div>

		<div v-if="selected" class="lightbox" @click.self="selected = null">
			<div class="lightbox-panel">
				<img :src="selected.image_url" :alt="selected.name" />
				<div class="lightbox-meta">
					<h3>
						<span v-if="selected.title" class="lightbox-title">{{ selected.title }}</span>
						<span class="lightbox-by">by {{ selected.name }}</span>
					</h3>
					<p v-if="selected.captured_at" class="lightbox-captured">Captured on {{ formatCapture(selected.captured_at) }}</p>
					<p v-if="selected.description" class="lightbox-desc">{{ selected.description }}</p>
					<p v-if="selected.astrobin_url">
						<a :href="selected.astrobin_url" target="_blank" rel="noopener">View astronomer on Astrobin →</a>
					</p>
					<div class="lightbox-footer">
						<a :href="selected.image_url" target="_blank" rel="noopener" class="download-link">⬇ Full resolution</a>
						<button class="close-btn" @click="selected = null">Close</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const API_BASE = 'https://gallery.eise.app';
const items = ref([]);
const loading = ref(true);
const error = ref('');
const selected = ref(null);

onMounted(async () => {
	try {
		const res = await fetch(`${API_BASE}/submissions`);
		if (!res.ok) throw new Error(`Failed to load gallery (${res.status})`);
		const body = await res.json();
		items.value = body.items || [];
	} catch (e) {
		error.value = e.message;
	} finally {
		loading.value = false;
	}
});

function formatCapture(iso) {
	const d = new Date(iso + 'T00:00:00Z');
	if (isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function cardTitle(item) {
	return item.title ? `${item.title} by ${item.name}` : `by ${item.name}`;
}

useHead({
	title: 'Gallery — Eise.app',
	meta: [
		{ name: 'description', content: 'Community-published planetary stacks made with Eise.app.' },
	],
});
</script>

<style scoped>
.gallery-msg {
	text-align: center;
	padding: 3rem 1rem;
	color: #666;
}
.gallery-msg.error {
	color: #a33;
}
.gallery-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
	gap: 1rem;
	margin-top: 1.5rem;
}
.gallery-card {
	background: #111;
	border: 1px solid #333;
	border-radius: 6px;
	padding: 0;
	cursor: pointer;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	transition: transform 0.15s, border-color 0.15s;
}
.gallery-card:hover {
	transform: translateY(-2px);
	border-color: #8CCF7E;
}
.gallery-card img {
	width: 100%;
	aspect-ratio: 1;
	object-fit: contain;
	background: #000;
	display: block;
}
.gallery-card-name {
	padding: 0.5rem 0.6rem;
	font-size: 0.85rem;
	color: #eee;
	text-align: left;
	background: #1a1a1a;
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}
.card-title {
	font-weight: bold;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card-by {
	color: #999;
	font-size: 0.78rem;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.lightbox {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.85);
	display: flex;
	justify-content: center;
	align-items: center;
	z-index: 1000;
	padding: 1rem;
}
.lightbox-panel {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	max-width: 92vw;
	max-height: 92vh;
	overflow: auto;
	display: flex;
	flex-direction: column;
}
.lightbox-panel img {
	max-width: 100%;
	max-height: 70vh;
	object-fit: contain;
	background: #000;
	display: block;
	border-radius: 10px 10px 0 0;
}
.lightbox-meta {
	padding: 20px 25px;
}
.lightbox-meta h3 {
	margin: 0 0 8px 0;
	font-size: 18px;
	font-weight: normal;
}
.lightbox-title {
	font-weight: bold;
	color: #222;
	margin-right: 6px;
}
.lightbox-by {
	color: #888;
	font-size: 15px;
}
.lightbox-captured {
	color: #666;
	margin: 0 0 8px 0;
	font-size: 13px;
}
.lightbox-desc {
	white-space: pre-wrap;
	color: #444;
	margin: 0 0 12px 0;
	font-size: 14px;
}
.lightbox-footer {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
	margin-top: 15px;
	padding-top: 15px;
	border-top: 1px solid #eee;
}
.download-link {
	color: #1a5a99;
	font-size: 14px;
	text-decoration: none;
}
.download-link:hover { text-decoration: underline; }
.close-btn {
	padding: 8px 20px;
	background-color: #eee;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
}
.close-btn:hover { background-color: #ddd; }
</style>
