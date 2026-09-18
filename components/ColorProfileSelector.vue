<template>
	<div class="page-layout pp-layout">
		<div class="panel">
			<div class="panel-section">
				<h3 class="panel-title">Select color profile</h3>
				<p class="panel-sub">Your SER file contains raw Bayer data that needs to be converted to color.</p>
				<p class="panel-note">Click the thumbnail that shows the <strong>correct colors</strong> for your subject. The auto-detected pattern is marked <span class="opt-badge gilt">auto</span>.</p>
			</div>
		</div>
		<div class="content">
			<h2 class="section-eyebrow">Select Bayer pattern</h2>
			<div v-if="!thumbnailsReady" class="loading-thumbnails">
				<p>Rendering previews…</p>
			</div>
			<div class="thumbnails" :class="{ hidden: !thumbnailsReady }">
				<button
					v-for="profile in profiles"
					:key="profile.id"
					type="button"
					class="thumbnail-wrapper"
					:class="{ autodetected: autoDetectedProfile === profile.id }"
					@click="confirmProfile(profile.id)"
				>
					<span class="thumbnail-frame">
						<canvas :ref="el => canvasRefs[profile.id] = el" class="thumbnail-canvas"></canvas>
					</span>
					<span class="profile-label">
						{{ profile.label }}
						<span v-if="autoDetectedProfile === profile.id" class="opt-badge gilt">auto</span>
					</span>
				</button>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, nextTick, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useWorkerUrl } from '@/composables/useWorkerUrl';

const { on, emit: eventBusEmit } = useEventBus();
const { workerUrl } = useWorkerUrl();

let gpuWorker = null;
let gpuReady = false;

const visible = ref(false);
const autoDetectedProfile = ref(null);
const canvasRefs = ref({});
const currentResolve = ref(null);
const frameData = ref(null);
const headerData = ref(null);
const thumbnailsReady = ref(false);

const profiles = [
	{ id: 'COLOR_BayerBG2RGB', label: 'RGGB' },
	{ id: 'COLOR_BayerRG2RGB', label: 'BGGR' },
	{ id: 'COLOR_BayerGR2RGB', label: 'GBRG' },
	{ id: 'COLOR_BayerGB2RGB', label: 'GRBG' },
	{ id: 'MONO', label: 'Mono' }
];

function confirmProfile(profileId) {
	if (currentResolve.value) {
		currentResolve.value(profileId);
		currentResolve.value = null;
	}
	visible.value = false;
	eventBusEmit('color-profile-selected', profileId);
}

async function initGpuWorker() {
	if (gpuWorker) return gpuReady;

	return new Promise((resolve) => {
		gpuWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' });
		gpuWorker.onmessage = (e) => {
			if (!e.data) {
				console.warn('GPU worker crashed');
				gpuReady = false;
				resolve(false);
				return;
			}
			if (e.data.type === 'ready') {
				gpuReady = true;
				resolve(true);
			} else if (e.data.type === 'init-error') {
				console.warn('GPU worker init failed:', e.data.error);
				gpuReady = false;
				resolve(false);
			}
		};
		gpuWorker.postMessage({ type: 'init' });
	});
}

async function renderThumbnailsGpu() {
	const { width, height, pixelDepth } = headerData.value;
	const buffer = frameData.value;

	// Calculate thumbnail size (max 150px, maintain aspect ratio)
	const maxSize = 150;
	const scale = Math.min(maxSize / width, maxSize / height);
	const thumbWidth = Math.floor(width * scale);
	const thumbHeight = Math.floor(height * scale);

	return new Promise((resolve, reject) => {
		const handler = (e) => {
			if (e.data.type === 'demosaic-thumbnails-result') {
				gpuWorker.removeEventListener('message', handler);

				for (const result of e.data.results) {
					const canvas = canvasRefs.value[result.id];
					if (!canvas) continue;

					canvas.width = thumbWidth;
					canvas.height = thumbHeight;

					const ctx = canvas.getContext('2d');
					const rgba = new Uint8ClampedArray(result.rgba);
					const imageData = new ImageData(rgba, thumbWidth, thumbHeight);
					ctx.putImageData(imageData, 0, 0);
				}
				resolve();
			} else if (e.data.type === 'demosaic-thumbnails-error') {
				gpuWorker.removeEventListener('message', handler);
				reject(new Error(e.data.error));
			}
		};
		gpuWorker.addEventListener('message', handler);

		// Send raw data (transfer buffer copy to avoid detaching original)
		const rawCopy = buffer.slice(0);
		gpuWorker.postMessage({
			type: 'demosaic-thumbnails',
			rawData: rawCopy,
			width,
			height,
			pixelDepth,
			thumbWidth,
			thumbHeight
		}, [rawCopy]);
	});
}

async function renderThumbnails() {
	await nextTick();
	thumbnailsReady.value = false;

	try {
		// Try GPU first (faster, no OpenCV needed)
		const gpuOk = await initGpuWorker();
		if (gpuOk) {
			await renderThumbnailsGpu();
			thumbnailsReady.value = true;
			return;
		}
	} catch (err) {
		console.warn('GPU thumbnail generation failed:', err);
	}

	// Fallback: simple CPU demosaic (no OpenCV)
	await renderThumbnailsCpu();
	thumbnailsReady.value = true;
}

async function renderThumbnailsCpu() {
	const { width, height, pixelDepth } = headerData.value;
	const buffer = frameData.value;

	const maxSize = 150;
	const scale = Math.min(maxSize / width, maxSize / height);
	const thumbWidth = Math.floor(width * scale);
	const thumbHeight = Math.floor(height * scale);

	const src = pixelDepth > 8 ? new Uint16Array(buffer) : new Uint8Array(buffer);
	const srcScale = pixelDepth > 8 ? 1/256 : 1;

	// Simple bilinear demosaic patterns
	// OpenCV uses inverted naming: BG=RGGB, RG=BGGR, GB=GRBG, GR=GBRG
	const patternConfigs = [
		{ id: 'COLOR_BayerBG2RGB', rX: 0, rY: 0, bX: 1, bY: 1 },  // Industry RGGB
		{ id: 'COLOR_BayerRG2RGB', rX: 1, rY: 1, bX: 0, bY: 0 },  // Industry BGGR
		{ id: 'COLOR_BayerGR2RGB', rX: 0, rY: 1, bX: 1, bY: 0 },  // Industry GBRG
		{ id: 'COLOR_BayerGB2RGB', rX: 1, rY: 0, bX: 0, bY: 1 },  // Industry GRBG
		{ id: 'MONO', mono: true }
	];

	for (const config of patternConfigs) {
		const canvas = canvasRefs.value[config.id];
		if (!canvas) continue;

		canvas.width = thumbWidth;
		canvas.height = thumbHeight;

		const ctx = canvas.getContext('2d');
		const imageData = ctx.createImageData(thumbWidth, thumbHeight);
		const data = imageData.data;

		// Simple nearest-neighbor sampling with basic demosaic
		const xRatio = width / thumbWidth;
		const yRatio = height / thumbHeight;

		let minVal = 255, maxVal = 0;

		// First pass: demosaic and find min/max
		const tempRgb = new Float32Array(thumbWidth * thumbHeight * 3);
		for (let ty = 0; ty < thumbHeight; ty++) {
			for (let tx = 0; tx < thumbWidth; tx++) {
				const sx = Math.floor(tx * xRatio);
				const sy = Math.floor(ty * yRatio);
				const tidx = (ty * thumbWidth + tx) * 3;

				if (config.mono) {
					const v = src[sy * width + sx] * srcScale;
					tempRgb[tidx] = tempRgb[tidx + 1] = tempRgb[tidx + 2] = v;
				} else {
					// Very simple demosaic: sample nearest R, G, B from 2x2 block
					const bx = sx & ~1;
					const by = sy & ~1;
					const getVal = (x, y) => src[Math.min(y, height-1) * width + Math.min(x, width-1)] * srcScale;

					const rPos = { x: bx + config.rX, y: by + config.rY };
					const bPos = { x: bx + config.bX, y: by + config.bY };
					const g1 = { x: bx + (1 - config.rX), y: by + config.rY };
					const g2 = { x: bx + config.rX, y: by + (1 - config.rY) };

					tempRgb[tidx] = getVal(rPos.x, rPos.y);
					tempRgb[tidx + 1] = (getVal(g1.x, g1.y) + getVal(g2.x, g2.y)) / 2;
					tempRgb[tidx + 2] = getVal(bPos.x, bPos.y);
				}

				const lum = (tempRgb[tidx] + tempRgb[tidx + 1] + tempRgb[tidx + 2]) / 3;
				minVal = Math.min(minVal, lum);
				maxVal = Math.max(maxVal, lum);
			}
		}

		// Second pass: auto-stretch and write to image data
		const range = maxVal - minVal || 1;
		const stretchScale = 255 / range;

		for (let i = 0; i < thumbWidth * thumbHeight; i++) {
			const tidx = i * 3;
			const didx = i * 4;
			data[didx] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx] - minVal) * stretchScale)));
			data[didx + 1] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 1] - minVal) * stretchScale)));
			data[didx + 2] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 2] - minVal) * stretchScale)));
			data[didx + 3] = 255;
		}

		ctx.putImageData(imageData, 0, 0);
	}
}

onMounted(() => {
	on('show-color-profile-selector', async (data) => {
		frameData.value = data.frameBuffer;
		headerData.value = data.header;
		autoDetectedProfile.value = data.autoDetectedProfile;
		currentResolve.value = data.resolve;
		visible.value = true;

		await nextTick();

		// If pre-rendered thumbnails are provided, use them directly
		if (data.thumbnails) {
			displayPreRenderedThumbnails(data.thumbnails);
		} else {
			renderThumbnails();
		}
	});
});

function displayPreRenderedThumbnails(thumbnails) {
	const maxSize = 150;

	for (const thumb of thumbnails) {
		const canvas = canvasRefs.value[thumb.id];
		if (!canvas) continue;

		// Scale to max 150px while maintaining aspect ratio
		const scale = Math.min(maxSize / thumb.width, maxSize / thumb.height);
		const displayWidth = Math.floor(thumb.width * scale);
		const displayHeight = Math.floor(thumb.height * scale);

		canvas.width = displayWidth;
		canvas.height = displayHeight;

		const ctx = canvas.getContext('2d');

		// Create temp canvas at original size
		const tempCanvas = new OffscreenCanvas(thumb.width, thumb.height);
		const tempCtx = tempCanvas.getContext('2d');
		const rgba = new Uint8ClampedArray(thumb.rgba);
		const imageData = new ImageData(rgba, thumb.width, thumb.height);
		tempCtx.putImageData(imageData, 0, 0);

		// Draw scaled
		ctx.drawImage(tempCanvas, 0, 0, displayWidth, displayHeight);
	}
	thumbnailsReady.value = true;
}

onUnmounted(() => {
	if (gpuWorker) {
		gpuWorker.terminate();
		gpuWorker = null;
	}
});
</script>

<style scoped>
.section-eyebrow {
	margin: 0 0 16px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--eise-label);
}
.thumbnails {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
	gap: 16px;
	max-width: 900px;
}
.thumbnails.hidden {
	display: none;
}
/* Each pattern is a picker tile: framed preview + name. */
.thumbnail-wrapper {
	display: flex;
	flex-direction: column;
	gap: 11px;
	padding: 10px;
	background: rgba(255, 255, 255, 0.04);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 10px;
	cursor: pointer;
	transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.thumbnail-wrapper:hover {
	background: rgba(255, 255, 255, 0.07);
	border-color: rgba(217, 169, 74, 0.55);
	transform: translateY(-2px);
}
.thumbnail-wrapper:focus-visible {
	outline: 2px solid var(--eise-gilt);
	outline-offset: 2px;
}
/* The auto-detected guess, gilt like every other "current choice" in the app. */
.thumbnail-wrapper.autodetected {
	border-color: rgba(217, 169, 74, 0.45);
	background: rgba(217, 169, 74, 0.1);
}
.thumbnail-frame {
	display: grid;
	place-items: center;
	width: 100%;
	aspect-ratio: 1 / 1;
	background: #030d13;
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 8px;
	overflow: hidden;
}
.thumbnail-canvas {
	display: block;
	max-width: 100%;
	max-height: 100%;
}
.profile-label {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	font-size: 13.5px;
	font-weight: 500;
	color: var(--eise-bright);
}
.loading-thumbnails {
	display: grid;
	place-items: center;
	width: 100%;
	max-width: 900px;
	min-height: 220px;
	border: 1px dashed rgba(255, 255, 255, 0.18);
	border-radius: 10px;
	background: rgba(0, 0, 0, 0.16);
	color: #6b8792;
	font-size: 13px;
}
.loading-thumbnails p {
	margin: 0;
}
</style>
