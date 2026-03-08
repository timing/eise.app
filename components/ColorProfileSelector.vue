<template>
	<div v-if="visible" class="page-layout">
		<div class="card">
			<h3>Select Color Profile</h3>
			<p>Your SER file contains raw Bayer data that needs to be converted to color.</p>
			<p>Click on the thumbnail that shows the <strong>correct colors</strong> for your subject.</p>
			<p>The auto-detected profile is highlighted with a blue border, but this may not always be correct.</p>
			<LoadingIndicator />
		</div>
		<div class="content">
			<h2>Select Bayer Pattern</h2>
			<div v-if="!thumbnailsReady" class="loading-thumbnails">
				<p>Rendering previews...</p>
			</div>
			<div class="thumbnails" :class="{ hidden: !thumbnailsReady }">
				<div
					v-for="profile in profiles"
					:key="profile.id"
					class="thumbnail-wrapper"
					:class="{ autodetected: autoDetectedProfile === profile.id }"
					@click="confirmProfile(profile.id)"
				>
					<canvas :ref="el => canvasRefs[profile.id] = el" class="thumbnail-canvas"></canvas>
					<div class="profile-label">
						{{ profile.label }}
						<span v-if="autoDetectedProfile === profile.id" class="auto-badge">auto</span>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, nextTick, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import LoadingIndicator from '@/components/LoadingIndicator.vue';

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
.thumbnails {
	display: flex;
	gap: 15px;
	flex-wrap: wrap;
	margin-top: 20px;
}

.thumbnail-wrapper {
	cursor: pointer;
	border: 3px solid #ddd;
	border-radius: 8px;
	padding: 8px;
	transition: all 0.2s ease;
	background: #f9f9f9;
}

.thumbnail-wrapper:hover {
	border-color: #8CCF7E;
	transform: scale(1.02);
	background: #e8f5e9;
}

.thumbnail-wrapper.autodetected {
	border-color: #27587c;
	border-style: dashed;
}

.thumbnail-canvas {
	display: block;
	border-radius: 4px;
}

.profile-label {
	text-align: center;
	margin-top: 8px;
	font-weight: bold;
	font-size: 14px;
	color: #333;
}

.auto-badge {
	background: #27587c;
	color: white;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 10px;
	margin-left: 5px;
	font-weight: normal;
}

.thumbnails.hidden {
	display: none;
}

.loading-thumbnails {
	text-align: center;
	padding: 40px;
	color: #666;
}
</style>
