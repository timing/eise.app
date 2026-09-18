<template>
	<div class="page-layout gallery-page">
		<div class="gallery-content">
			<div class="gallery-head">
				<h1>Eise Gallery</h1>
				<p class="gallery-lede">Stacks published by the community, made with Eise.app. Want yours here? <NuxtLink to="/">Stack an image</NuxtLink> and hit Publish, or <button type="button" class="link-btn" @click="triggerUpload">upload an Eise stack</button> you've already saved.</p>
			</div>

			<input ref="uploadInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="handleFileSelect" />

			<div v-if="uploadError" class="gallery-msg error">{{ uploadError }}</div>

			<div v-if="loading" class="gallery-msg">Loading gallery…</div>
			<div v-else-if="error" class="gallery-msg error">{{ error }}</div>
			<div v-else-if="items.length === 0" class="gallery-msg">
				No published stacks yet — the gallery just launched on 16 August 2026. Be the first.
			</div>

			<div v-else class="gallery-grid">
				<button v-for="item in items" :key="item.id" class="gallery-card" @click="selected = item" :title="cardTitle(item)">
					<span class="gallery-card-frame">
						<img :src="item.thumb_url" :alt="item.title || item.name" loading="lazy" />
					</span>
					<span class="gallery-card-caption">
						<span class="card-title">{{ item.title || 'Untitled' }}</span>
						<span class="card-by">{{ item.name }}</span>
					</span>
				</button>
			</div>

			<div class="gallery-cta">
				<h3>Show off your work</h3>
				<p>Publish a stack straight from Eise, or upload an Eise stack you've already saved.</p>
				<div class="gallery-cta-actions">
					<NuxtLink to="/" class="btn-primary">Stack an image</NuxtLink>
					<button type="button" class="btn-primary" @click="triggerUpload">Upload an Eise stack</button>
				</div>
			</div>
		</div>

		<PublishModal
			v-if="uploadCanvas"
			:canvas="uploadCanvas"
			@close="closeUploadModal"
			@published="onPublished"
		/>

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
import PublishModal from '@/components/PublishModal.vue';

const API_BASE = 'https://gallery.eise.app';
const items = ref([]);
const loading = ref(true);
const error = ref('');
const selected = ref(null);

const uploadInput = ref(null);
const uploadCanvas = ref(null);
const uploadError = ref('');

function triggerUpload() {
	uploadError.value = '';
	uploadInput.value?.click();
}

async function handleFileSelect(event) {
	const file = event.target.files?.[0];
	event.target.value = '';
	if (!file) return;
	uploadError.value = '';
	try {
		uploadCanvas.value = await fileToCanvas(file);
	} catch (e) {
		uploadError.value = e.message || 'Could not read that image.';
	}
}

async function fileToCanvas(file) {
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		const w = img.naturalWidth;
		const h = img.naturalHeight;
		if (!w || !h) throw new Error('Image has zero dimensions.');
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		canvas.getContext('2d').drawImage(img, 0, 0);
		return canvas;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function closeUploadModal() {
	uploadCanvas.value = null;
}

function onPublished() {
	fetch(`${API_BASE}/submissions`).then(r => r.ok && r.json()).then(body => {
		if (body?.items) items.value = body.items;
	}).catch(() => {});
}

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
.gallery-page {
	max-width: 1400px;
	margin: 0 auto;
	padding: 48px 28px 96px;
	box-sizing: border-box;
}
/* Deliberately not `.content`: that global class forces `color: inherit` on
   links, which would kill the lede link colour below. */
.gallery-content {
	flex: 1;
	width: 100%;
	min-width: 0;
	line-height: 1.65;
}
.gallery-head {
	padding-bottom: 22px;
	border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.gallery-head h1 {
	margin: 0 0 10px;
	font-size: 32px;
	line-height: 1.15;
	font-weight: 600;
	letter-spacing: -0.025em;
	color: #ffffff;
}
.gallery-lede {
	margin: 0;
	max-width: 62ch;
	font-size: 15px;
	line-height: 1.65;
	color: #b7ccd2;
	text-wrap: pretty;
}
.gallery-lede :deep(a),
.link-btn {
	color: #8fcfe0;
	text-decoration: none;
	border-bottom: 1px solid rgba(143, 207, 224, 0.35);
}
.gallery-lede :deep(a:hover),
.link-btn:hover {
	background: none;
	color: #b7e4f2;
	border-bottom-color: rgba(183, 228, 242, 0.6);
}
.link-btn {
	background: none;
	border: none;
	border-bottom: 1px solid rgba(143, 207, 224, 0.35);
	border-radius: 0;
	padding: 0;
	cursor: pointer;
	font: inherit;
}
.gallery-msg {
	text-align: center;
	padding: 3rem 1rem;
	color: var(--eise-muted);
}
.gallery-msg.error {
	color: #e58a8a;
}
/* Design uses minmax(280px); we go one step denser so every viewport fits one
   extra column (5 at the 1400px cap, 4 around 1000px, 3 around 800px). */
.gallery-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
	gap: 22px;
	margin-top: 32px;
}
@media (max-width: 600px) {
	.gallery-page { padding: 28px 16px 64px; }
	.gallery-grid {
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 14px;
	}
}
.gallery-card {
	background: none;
	border: none;
	border-radius: 0;
	padding: 0;
	margin: 0;
	cursor: pointer;
	display: flex;
	flex-direction: column;
	gap: 11px;
	min-width: 0;
	text-align: left;
	transition: transform 0.15s;
}
.gallery-card:hover {
	background: none;
	transform: translateY(-2px);
}
.gallery-card-frame {
	position: relative;
	width: 100%;
	aspect-ratio: 1 / 1;
	border-radius: 10px;
	overflow: hidden;
	background: #030d13;
	border: 1px solid rgba(255, 255, 255, 0.1);
	display: block;
	transition: border-color 0.15s;
}
.gallery-card:hover .gallery-card-frame {
	border-color: rgba(217, 169, 74, 0.55);
}
.gallery-card img {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
}
.gallery-card-caption {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 2px 12px;
	min-width: 0;
}
.card-title {
	flex: 0 1 auto;
	min-width: 0;
	font-size: 14px;
	font-weight: 500;
	color: #f1f7f8;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* Never shrinks, so a long author name wraps to its own line (pushed right by
   margin-left: auto) instead of being ellipsised down to a single letter. */
.card-by {
	flex: 0 0 auto;
	max-width: 100%;
	margin-left: auto;
	font-size: 12.5px;
	color: var(--eise-muted);
	text-align: right;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.gallery-cta {
	margin-top: 64px;
	padding: 32px 1rem 0;
	text-align: center;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.gallery-cta h3 {
	margin: 0 0 0.5rem 0;
	font-size: 19px;
	font-weight: 600;
	letter-spacing: -0.015em;
	color: #ffffff;
}
.gallery-cta p {
	margin: 0 0 1.25rem 0;
	font-size: 15px;
	color: #b7ccd2;
}
.gallery-cta-actions {
	display: flex;
	gap: 0.75rem;
	justify-content: center;
	flex-wrap: wrap;
}
.gallery-cta-actions .btn-primary {
	font-size: 15px;
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
