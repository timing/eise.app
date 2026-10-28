<template>
	<div class="publish-popup-overlay" @click.self="close">
		<div class="publish-popup" role="dialog" aria-label="Publish to Eise Gallery">
			<div class="modal-head">
				<div class="modal-head-text">
					<h3>Publish to Eise Gallery</h3>
					<p class="publish-intro">
						Share your stack with the world in the
						<a href="/gallery/" target="_blank" rel="noopener">Eise Gallery</a>.
						Submissions are reviewed before appearing publicly.
					</p>
				</div>
				<button class="popup-close-x" aria-label="Close" :disabled="submitting" @click="close">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
				</button>
			</div>

			<div v-if="submitted" class="publish-success">
				<p><strong>✓ Submitted for review!</strong></p>
				<p class="subtle">Your image will appear in the gallery once approved.</p>
			</div>

			<div v-else class="modal-grid">
				<div class="publish-preview">
					<img v-if="previewUrl" :src="previewUrl" alt="Preview of your stack" />
				</div>

				<div class="modal-controls">
					<div class="field-pair">
						<label class="publish-field">
							<span class="publish-label">Title <span class="optional">(optional)</span></span>
							<input type="text" v-model="title" maxlength="120" :disabled="submitting" placeholder="Jupiter and Ganymede" @keydown.enter="submit" />
						</label>
						<label class="publish-field">
							<span class="publish-label">Your name <span class="required">*</span></span>
							<input type="text" v-model="name" maxlength="80" :disabled="submitting" placeholder="Anonymous Astronomer" @keydown.enter="submit" />
						</label>
					</div>

					<label class="publish-field">
						<span class="publish-label">Capture details <span class="optional">(optional)</span></span>
						<textarea v-model="description" maxlength="2000" rows="4" :disabled="submitting" placeholder="Telescope, camera, seeing conditions, notes..."></textarea>
					</label>

					<div class="field-pair field-pair-date">
						<label class="publish-field">
							<span class="publish-label">Date of capture <span class="optional">(optional)</span></span>
							<input type="date" v-model="capturedAt" :max="today" :disabled="submitting" />
						</label>
						<label class="publish-field">
							<span class="publish-label">Your Astrobin profile URL <span class="optional">(optional)</span></span>
							<input type="url" v-model="astrobinUrl" :disabled="submitting" placeholder="https://astrobin.com/users/yourname/" />
						</label>
					</div>
					<p class="publish-field-help">We'll link to your Astrobin profile from your gallery entry.</p>

					<div v-if="error" class="publish-error">{{ error }}</div>

					<div class="publish-popup-footer">
						<button class="publish-back" :disabled="submitting" @click="goBack">
							{{ fromExport ? 'Back' : 'Cancel' }}
						</button>
						<button class="publish-submit" @click="submit" :disabled="!canSubmit">
							{{ submitting ? 'Uploading...' : 'Publish' }}
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
	canvas: { type: null, default: null },
	// Opened from the export modal rather than the toolbar, so the secondary
	// button returns there instead of dropping the user back on the image with
	// the export flow abandoned.
	fromExport: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'published', 'back']);

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

function goBack() {
	if (submitting.value) return;
	emit(props.fromExport ? 'back' : 'close');
}
</script>

<style scoped>
/* Clears the sticky chrome rather than fighting it: layouts/default.vue puts
   .app-content in its own stacking context (position: relative; z-index: 1),
   so the header (z-index 20) and the Logger bar (20) paint over any overlay
   rendered inside it no matter how high its z-index. Sitting below the header
   instead of behind it needs no z-index at all. */
.publish-popup-overlay {
	position: fixed;
	inset: 0;
	display: grid;
	place-items: center;
	padding: 72px 16px 52px;
	box-sizing: border-box;
	background: rgba(3, 16, 22, 0.6);
	backdrop-filter: blur(3px);
	z-index: 1000;
}
.publish-popup {
	width: 100%;
	max-width: 1080px;
	max-height: 100%;
	overflow-y: auto;
	box-sizing: border-box;
	background: var(--eise-panel);
	border: 1px solid var(--eise-panel-border);
	border-radius: 14px;
	box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
	color: var(--eise-body);
}
.modal-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 20px;
	padding: 22px 24px 0;
}
.modal-head-text { min-width: 0; }
.publish-popup h3 {
	margin: 0 0 6px;
	font-size: 18px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--eise-bright);
}
.publish-intro {
	margin: 0;
	max-width: 68ch;
	font-size: 14px;
	line-height: 1.55;
	color: var(--eise-muted-2);
	text-wrap: pretty;
}
.publish-intro a {
	color: var(--eise-link);
	text-decoration: none;
	border-bottom: 1px solid rgba(143, 207, 224, 0.35);
}
.publish-intro a:hover { color: #b7e4f2; }
.popup-close-x {
	flex: 0 0 auto;
	width: 32px;
	height: 32px;
	display: grid;
	place-items: center;
	padding: 0;
	border-radius: 7px;
	background: transparent;
	border: 1px solid var(--eise-panel-border);
	color: var(--eise-on-dark);
	cursor: pointer;
}
.popup-close-x:hover:not(:disabled) {
	background: rgba(255, 255, 255, 0.07);
	color: var(--eise-bright);
}
.popup-close-x:disabled { opacity: 0.4; cursor: not-allowed; }

/* Preview left, form right, same shell as the export modal. */
.modal-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
	gap: 24px;
	padding: 20px 24px 24px;
}
.publish-preview {
	display: grid;
	place-items: center;
	min-height: 280px;
	aspect-ratio: 1 / 1;
	/* Inset so the stack never butts against the frame. Without it the image
	   grows to the full box and its own black background runs into the rounded
	   corners, which reads as a rendering fault rather than as a frame. */
	padding: 10px;
	box-sizing: border-box;
	background: #000000;
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 10px;
	overflow: hidden;
}
.publish-preview img {
	/* A grid item's default min-height is auto, i.e. its intrinsic size, and
	   that beats max-height: 100%. A 400px-tall thumb in the 130px small-screen
	   frame therefore rendered at full height and was cropped by overflow
	   rather than scaled down. Zeroing both minimums restores the cap. */
	min-width: 0;
	min-height: 0;
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
	display: block;
}
.modal-controls {
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 14px;
}
/* Short fields pair up so the form does not become one long column that pushes
   the Publish button below the fold. */
.field-pair {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 12px;
}
.field-pair-date { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); }
.publish-field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
}
.publish-label {
	font-size: 12px;
	font-weight: 500;
	color: var(--eise-body);
}
.publish-label .optional {
	font-weight: 400;
	color: var(--eise-muted);
}
.publish-field .required { color: var(--eise-gilt-lt); }
.publish-field input,
.publish-field textarea {
	width: 100%;
	box-sizing: border-box;
	padding: 0 11px;
	height: 38px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid var(--eise-panel-border);
	color: var(--eise-bright);
	font-family: inherit;
	font-size: 14px;
}
.publish-field input[type="date"] { color-scheme: dark; }
.publish-field textarea {
	height: auto;
	padding: 9px 11px;
	line-height: 1.5;
	resize: vertical;
}
.publish-field input::placeholder,
.publish-field textarea::placeholder { color: #5d7580; }
.publish-field input:focus,
.publish-field textarea:focus {
	outline: none;
	border-color: rgba(217, 169, 74, 0.6);
}
.publish-field input:disabled,
.publish-field textarea:disabled { opacity: 0.55; }
.publish-field-help {
	margin: -6px 0 0;
	font-size: 12px;
	color: var(--eise-muted-2);
}
.publish-error {
	padding: 9px 12px;
	border-radius: 7px;
	background: rgba(196, 78, 78, 0.14);
	border: 1px solid rgba(196, 78, 78, 0.4);
	color: #f0b4b4;
	font-size: 14px;
}
.publish-success {
	padding: 40px 24px 44px;
	text-align: center;
	color: var(--eise-bright);
}
.publish-success .subtle {
	margin-top: 5px;
	font-size: 14px;
	color: var(--eise-muted-2);
}
.publish-popup-footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: 8px;
	margin-top: auto;
	padding-top: 6px;
}
.publish-back {
	height: 38px;
	padding: 0 16px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.16);
	color: var(--eise-bright);
	font-family: inherit;
	font-size: 14px;
	cursor: pointer;
}
.publish-back:hover:not(:disabled) { background: rgba(255, 255, 255, 0.11); }
.publish-back:disabled { opacity: 0.5; cursor: not-allowed; }
.publish-submit {
	height: 38px;
	padding: 0 20px;
	border: none;
	border-radius: 7px;
	background: var(--eise-gilt);
	color: var(--eise-panel);
	font-family: inherit;
	font-size: 14px;
	font-weight: 600;
	cursor: pointer;
}
.publish-submit:hover:not(:disabled) { background: #f3d290; }
.publish-submit:disabled {
	background: rgba(255, 255, 255, 0.08);
	color: #5d7580;
	cursor: not-allowed;
}
@media (max-width: 860px) {
	.modal-grid { grid-template-columns: minmax(0, 1fr); }
	/* Same reasoning as the export modal: stacked, a square preview buries the
	   form. It shrinks to a thumbnail so the fields and Publish stay reachable. */
	.publish-preview {
		aspect-ratio: auto;
		min-height: 0;
		height: 130px;
		max-width: 190px;
		margin: 0 auto;
	}
	/* Three rows shorter than stacking everything. The textarea gives up a row
	   too; it scrolls, and capture notes are usually one line. */
	.publish-field textarea { height: 76px; }
}
/* The pairs stay paired well below the point where the modal goes single
   column: at 860px two fields still have ~390px each, and collapsing them
   there pushed Publish below the fold. */
@media (max-width: 600px) {
	.field-pair,
	.field-pair-date { grid-template-columns: minmax(0, 1fr); }
}
</style>
