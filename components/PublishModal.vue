<template>
	<div class="publish-popup-overlay" @click.self="close">
		<div class="publish-popup">
			<button class="popup-close-x" aria-label="Close" :disabled="submitting" @click="close">×</button>
			<h3>Publish to Eise Gallery</h3>
			<p class="publish-intro">
				Share your stack with the world in the
				<a href="/gallery/" target="_blank" rel="noopener">Eise Gallery</a>.
				Submissions are reviewed before appearing publicly.
			</p>

			<div v-if="submitted" class="publish-success">
				<p><strong>✓ Submitted for review!</strong></p>
				<p class="subtle">Your image will appear in the gallery once approved.</p>
			</div>

			<template v-else>
				<div v-if="previewUrl" class="publish-preview">
					<img :src="previewUrl" alt="Preview of your stack" />
				</div>

				<div class="publish-field">
					<label>Title (optional)</label>
					<input type="text" v-model="title" maxlength="120" :disabled="submitting" placeholder="Jupiter and Ganymede" @keydown.enter="submit" />
				</div>
				<div class="publish-field">
					<label>Your name <span class="required">*</span></label>
					<input type="text" v-model="name" maxlength="80" :disabled="submitting" placeholder="Anonymous Astronomer" @keydown.enter="submit" />
				</div>
				<div class="publish-field">
					<label>Capture details (optional)</label>
					<textarea v-model="description" maxlength="2000" rows="4" :disabled="submitting" placeholder="Telescope, camera, seeing conditions, notes..."></textarea>
				</div>
				<div class="publish-field">
					<label>Date of capture (optional)</label>
					<input type="date" v-model="capturedAt" :max="today" :disabled="submitting" />
				</div>
				<div class="publish-field">
					<label>Your Astrobin profile URL (optional)</label>
					<input type="url" v-model="astrobinUrl" :disabled="submitting" placeholder="https://astrobin.com/users/yourname/" />
					<p class="publish-field-help">We'll link to your Astrobin profile from your gallery entry.</p>
				</div>

				<div v-if="error" class="publish-error">{{ error }}</div>

				<div class="publish-popup-footer">
					<button class="btn-primary publish-submit" @click="submit" :disabled="!canSubmit">
						{{ submitting ? 'Uploading...' : 'Publish' }}
					</button>
				</div>
			</template>
		</div>
	</div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
	canvas: { type: null, default: null },
});
const emit = defineEmits(['close', 'published']);

const API_BASE = 'https://gallery.eise.app';

const name = ref('');
const title = ref('');
const description = ref('');
const astrobinUrl = ref('');
const capturedAt = ref('');
const submitting = ref(false);
const submitted = ref(false);
const error = ref('');
const previewUrl = ref('');
let thumbBlob = null;

const today = new Date().toISOString().slice(0, 10);

const canSubmit = computed(() =>
	name.value.trim().length > 0 &&
	!submitting.value &&
	!!props.canvas
);

function validAstrobin(url) {
	if (!url) return true;
	try {
		const u = new URL(url);
		return u.protocol === 'https:' && /(^|\.)astrobin\.com$/.test(u.hostname);
	} catch { return false; }
}

async function makeThumb(canvas) {
	const MAX = 400;
	const w = canvas.width;
	const h = canvas.height;
	const scale = Math.min(1, MAX / Math.max(w, h));
	const tw = Math.max(1, Math.round(w * scale));
	const th = Math.max(1, Math.round(h * scale));
	const off = new OffscreenCanvas(tw, th);
	off.getContext('2d').drawImage(canvas, 0, 0, tw, th);
	return await off.convertToBlob({ type: 'image/webp', quality: 0.85 });
}

function makePng(canvas) {
	return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function refreshPreview(c) {
	if (!c || !c.width || !c.height) {
		console.warn('[PublishModal] no canvas or zero dimensions', c);
		return;
	}
	try {
		if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
		thumbBlob = await makeThumb(c);
		previewUrl.value = URL.createObjectURL(thumbBlob);
	} catch (e) {
		console.error('[PublishModal] thumb generation failed', e);
	}
}

onMounted(() => refreshPreview(props.canvas));
watch(() => props.canvas, c => refreshPreview(c));

onBeforeUnmount(() => {
	if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});

async function submit() {
	if (!canSubmit.value) return;
	if (!validAstrobin(astrobinUrl.value.trim())) {
		error.value = 'Astrobin URL must be a https://astrobin.com/… link';
		return;
	}
	error.value = '';
	submitting.value = true;
	try {
		const image = await makePng(props.canvas);
		const thumb = thumbBlob || await makeThumb(props.canvas);
		const fd = new FormData();
		fd.set('name', name.value.trim());
		fd.set('title', title.value.trim());
		fd.set('description', description.value.trim());
		fd.set('astrobin_url', astrobinUrl.value.trim());
		fd.set('captured_at', capturedAt.value);
		fd.set('image', image, 'stack.png');
		fd.set('thumb', thumb, 'thumb.webp');
		const res = await fetch(`${API_BASE}/submissions`, { method: 'POST', body: fd });
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error || `Upload failed (${res.status})`);
		}
		submitted.value = true;
		emit('published');
		setTimeout(close, 2500);
	} catch (e) {
		error.value = e.message || 'Upload failed';
	} finally {
		submitting.value = false;
	}
}

function close() {
	if (submitting.value) return;
	emit('close');
}
</script>

<style scoped>
.publish-popup-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.6);
	display: flex;
	justify-content: center;
	align-items: center;
	z-index: 1000;
}
.publish-popup {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	padding: 25px 30px;
	max-width: 460px;
	width: 90%;
	box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.publish-popup h3 {
	margin: 0 0 10px 0;
	color: #333;
	font-size: 18px;
}
.publish-intro {
	font-size: 13px;
	color: #666;
	margin: 0 0 20px 0;
}
.publish-field {
	margin-bottom: 15px;
}
.publish-field label {
	display: block;
	margin-bottom: 5px;
	font-weight: bold;
	font-size: 13px;
}
.publish-field .required {
	color: #c33;
	font-weight: normal;
}
.publish-field-help {
	margin: 5px 0 0 0;
	font-size: 12px;
	color: #666;
}
.publish-preview {
	display: flex;
	justify-content: center;
	background: #000;
	border-radius: 6px;
	padding: 8px;
	margin-bottom: 15px;
}
.publish-preview img {
	max-width: 100%;
	max-height: 180px;
	object-fit: contain;
	display: block;
}
.publish-intro a {
	color: #1a5a99;
	text-decoration: none;
}
.publish-intro a:hover { text-decoration: underline; }
.publish-field input,
.publish-field textarea {
	width: 100%;
	padding: 10px;
	border: 1px solid #ccc;
	border-radius: 5px;
	font-size: 14px;
	box-sizing: border-box;
	font-family: inherit;
	resize: vertical;
}
.publish-field input:focus,
.publish-field textarea:focus {
	outline: none;
	border-color: #8CCF7E;
}
.publish-error {
	background: #fee;
	color: #a33;
	padding: 8px 12px;
	border-radius: 5px;
	font-size: 13px;
	margin-bottom: 12px;
}
.publish-success {
	padding: 20px 0;
	text-align: center;
	color: #333;
}
.publish-success .subtle {
	font-size: 13px;
	color: #666;
	margin-top: 5px;
}
.publish-popup-footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: 10px;
	padding-top: 10px;
}
.publish-popup { position: relative; }
.popup-close-x {
	position: absolute;
	top: 12px;
	right: 12px;
	width: 32px;
	height: 32px;
	border: none;
	background: transparent;
	color: #666;
	font-size: 24px;
	line-height: 1;
	cursor: pointer;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 0;
}
.popup-close-x:hover:not(:disabled) { background: #f0f0f0; color: #111; }
.popup-close-x:disabled { opacity: 0.4; cursor: not-allowed; }
.publish-submit {
	padding: 8px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}
.publish-submit:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
