<template>
	<div class="page-layout pp-layout">
		<div class="panel">
			<div class="panel-section">
				<h3 class="panel-label">Quality threshold</h3>
				<p class="panel-sub">Frames are sorted sharpest to blurriest. Choose how many of the best ones go into the stack.</p>

				<div class="threshold-readout">
					<span class="threshold-count">{{ selectedCount }}</span>
					<span class="threshold-total">/ {{ totalFrames }} frames</span>
					<span class="threshold-pct">{{ percentageText }}</span>
				</div>

				<div class="threshold-controls">
					<label class="visually-hidden" for="threshold-range">Frames to include</label>
					<input id="threshold-range" type="range" min="1" :max="totalFrames" v-model.number="selectedCount" @input="updateThreshold" :key="'slider-' + totalFrames" />
				</div>
				<div class="graph-labels">
					<span>SHARPEST</span>
					<span>BLURRIEST</span>
				</div>

				<div class="graph-container">
					<canvas ref="graphCanvas" @click="onGraphClick" @mousemove="onGraphHover"></canvas>
				</div>
				<div class="graph-scores">
					<span>sharpness {{ bestScoreText }}</span>
					<span>cut at {{ cutScoreText }}</span>
				</div>
			</div>

			<div class="panel-section panel-section-flush stack-actions">
				<button class="stack-btn" @click="proceedWithStacking">Stack {{ selectedCount }} frames</button>
				<button class="cancel-btn" @click="cancelSelection">Cancel</button>
			</div>
		</div>

		<div class="content">
			<div class="preview-section" v-if="previewFrame">
				<div class="preview-head">
					<div class="preview-title">
						<span class="preview-eyebrow">{{ isPlaying ? 'Playing' : 'Preview' }}</span>
						<span class="preview-frame-no">Frame #{{ previewFrameIndex + 1 }}</span>
					</div>
					<span class="verdict" :class="{ included: previewFrameIndex < selectedCount }">
						{{ previewFrameIndex < selectedCount ? 'Included in stack' : 'Excluded — below threshold' }}
					</span>
				</div>

				<div class="preview-stage">
					<canvas ref="previewCanvas" class="preview-canvas"></canvas>
				</div>

				<div class="frame-slider">
					<button class="play-button" @click="togglePlayback" :aria-label="isPlaying ? 'Pause' : 'Play frames'">
						<svg v-if="isPlaying" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>
						<svg v-else width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2 19 12 8 18.8z" /></svg>
					</button>
					<input type="range" min="0" :max="totalFrames - 1" v-model.number="previewFrameIndex" @input="onFrameSliderChange" />
					<span class="frame-position">{{ previewFrameIndex + 1 }} / {{ totalFrames }}</span>
				</div>

				<div class="frame-stats-grid">
					<div class="stat">
						<div class="stat-label">Sharpness</div>
						<div class="stat-value">{{ previewFrame.sharpness?.toFixed(2) || '?' }}</div>
						<div class="stat-sub">Tenengrad {{ previewFrame.tenengrad?.toFixed(2) || '?' }} · Laplacian {{ previewFrame.laplacian?.toFixed(2) || '?' }}</div>
					</div>
					<div class="stat">
						<div class="stat-label">Circularity</div>
						<div class="stat-value">{{ previewFrame.circularity?.toFixed(2) || '?' }}</div>
					</div>
					<div class="stat">
						<div class="stat-label">Rank</div>
						<div class="stat-value">{{ previewFrameIndex + 1 }} of {{ totalFrames }}</div>
					</div>
				</div>
			</div>
			<div v-else class="no-preview">
				<p>Use the slider or press Play to preview frames</p>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, watch, computed, nextTick, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { emit: eventBusEmit, on } = useEventBus();

const props = defineProps({
	frames: {
		type: Array,
		required: true
	},
	frameReReader: {
		type: Object,
		default: null
	}
});

const emit = defineEmits(['threshold-selected']);

const graphCanvas = ref(null);
const previewCanvas = ref(null);
const selectedCount = ref(1); // Will be recalculated to 30% in initializeFromFrames
const totalFrames = ref(0);
const sortedFrames = ref([]);
const previewFrameIndex = ref(0);
const previewFrame = ref(null);

// Playback state
const isPlaying = ref(false);
const playIndex = ref(0);
let playInterval = null;

const percentageText = computed(() => {
	if (totalFrames.value === 0) return '0%';
	return Math.round((selectedCount.value / totalFrames.value) * 100) + '%';
});

// Sharpness at the top of the sorted list and at the cut, shown under the graph.
const bestScoreText = computed(() => sortedFrames.value[0]?.sharpness?.toFixed(1) ?? '-');
const cutScoreText = computed(() => sortedFrames.value[selectedCount.value - 1]?.sharpness?.toFixed(1) ?? '-');

onMounted(() => {
	if (props.frames && props.frames.length > 0) {
		initializeFromFrames(props.frames);
	}
});

onUnmounted(() => {
	stopPlayback();
});

watch(() => props.frames, (newFrames) => {
	if (newFrames && newFrames.length > 0) {
		initializeFromFrames(newFrames);
	}
}, { immediate: true });

function initializeFromFrames(frames) {
	// Sort frames by sharpness (best first)
	sortedFrames.value = [...frames].sort((a, b) => b.sharpness - a.sharpness);
	totalFrames.value = sortedFrames.value.length;

	// Default to 30%
	selectedCount.value = Math.max(1, Math.floor(totalFrames.value * 0.3));

	// Set initial preview to best frame
	previewFrameIndex.value = 0;
	previewFrame.value = sortedFrames.value[0];

	nextTick(() => {
		drawGraph();
		drawPreview();
	});
}

function drawGraph() {
	const canvas = graphCanvas.value;
	if (!canvas || sortedFrames.value.length === 0) return;

	const ctx = canvas.getContext('2d');
	const dpr = window.devicePixelRatio || 1;

	// Set canvas size
	const width = canvas.parentElement.clientWidth || 400;
	const height = 128;
	canvas.width = width * dpr;
	canvas.height = height * dpr;
	canvas.style.width = width + 'px';
	canvas.style.height = height + 'px';
	ctx.scale(dpr, dpr);

	// Clear. The container paints the dark plot background, so stay transparent.
	ctx.clearRect(0, 0, width, height);

	// Find min/max sharpness for scaling
	const sharpnessValues = sortedFrames.value.map(f => f.sharpness);
	const maxSharpness = Math.max(...sharpnessValues);
	const minSharpness = Math.min(...sharpnessValues);
	const range = maxSharpness - minSharpness || 1;

	const padding = { left: 0, right: 0, top: 8, bottom: 0 };
	const graphWidth = width - padding.left - padding.right;
	const graphHeight = height - padding.top - padding.bottom;

	// Draw bars
	const barWidth = Math.max(1, graphWidth / sortedFrames.value.length);

	for (let i = 0; i < sortedFrames.value.length; i++) {
		const frame = sortedFrames.value[i];
		const normalizedSharpness = (frame.sharpness - minSharpness) / range;
		const barHeight = normalizedSharpness * graphHeight;

		const x = padding.left + (i / sortedFrames.value.length) * graphWidth;
		const y = padding.top + graphHeight - barHeight;

		// Color based on whether included in selection
		if (i < selectedCount.value) {
			ctx.fillStyle = 'rgba(217, 169, 74, 0.55)'; // Gilt for included
		} else {
			ctx.fillStyle = 'rgba(255, 255, 255, 0.09)'; // Faint for excluded
		}

		ctx.fillRect(x, y, Math.max(barWidth - 0.5, 1), barHeight);
	}

	// Draw threshold line (orange dashed)
	const thresholdX = padding.left + (selectedCount.value / sortedFrames.value.length) * graphWidth;
	ctx.strokeStyle = '#eec36c';
	ctx.lineWidth = 1.5;
	ctx.setLineDash([]);
	ctx.beginPath();
	ctx.moveTo(thresholdX, padding.top);
	ctx.lineTo(thresholdX, height - padding.bottom);
	ctx.stroke();
	ctx.setLineDash([]);

	// Draw play position indicator (yellow/gold, only when playing)
	if (isPlaying.value) {
		const playX = padding.left + ((playIndex.value + 0.5) / sortedFrames.value.length) * graphWidth;
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(playX, padding.top);
		ctx.lineTo(playX, height - padding.bottom);
		ctx.stroke();
	}

	// Draw preview position indicator (--eise-on-dark, when not playing).
	// Canvas 2D can't read CSS vars, so this hex must match html's --eise-on-dark.
	if (!isPlaying.value) {
		const previewX = padding.left + ((previewFrameIndex.value + 0.5) / sortedFrames.value.length) * graphWidth;
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(previewX, padding.top);
		ctx.lineTo(previewX, height - padding.bottom);
		ctx.stroke();
	}
}

async function drawPreview() {
	const canvas = previewCanvas.value;
	if (!canvas || !previewFrame.value) return;

	const ctx = canvas.getContext('2d');
	const frame = previewFrame.value;

	try {
		let img;
		let url = null;

		if (frame.blob) {
			// Use blob if available
			img = new Image();
			url = URL.createObjectURL(frame.blob);
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error('Failed to load frame preview'));
				img.src = url;
			});
		} else if (frame.uint8Buffer && frame.width && frame.height) {
			// Use Uint8 buffer directly (already 8-bit RGBA)
			const uint8Data = new Uint8ClampedArray(frame.uint8Buffer);
			const tempCanvas = document.createElement('canvas');
			tempCanvas.width = frame.width;
			tempCanvas.height = frame.height;
			const tempCtx = tempCanvas.getContext('2d');
			const imageData = new ImageData(uint8Data, frame.width, frame.height);
			tempCtx.putImageData(imageData, 0, 0);
			img = tempCanvas;
		} else if (frame.float32Buffer && frame.width && frame.height) {
			// Convert Float32Array (0.0-1.0) to Uint8ClampedArray for display
			const float32Data = new Float32Array(frame.float32Buffer);
			const uint8Data = new Uint8ClampedArray(float32Data.length);
			for (let i = 0; i < float32Data.length; i++) {
				uint8Data[i] = Math.round(float32Data[i] * 255);
			}
			const tempCanvas = document.createElement('canvas');
			tempCanvas.width = frame.width;
			tempCanvas.height = frame.height;
			const tempCtx = tempCanvas.getContext('2d');
			const imageData = new ImageData(uint8Data, frame.width, frame.height);
			tempCtx.putImageData(imageData, 0, 0);
			img = tempCanvas;
		} else if (props.frameReReader?.getPreviewBlob && frame.index !== undefined) {
			// Load preview on-demand from disk via frameReReader
			const blob = await props.frameReReader.getPreviewBlob(frame);
			if (blob) {
				img = new Image();
				url = URL.createObjectURL(blob);
				await new Promise((resolve, reject) => {
					img.onload = resolve;
					img.onerror = () => reject(new Error('Failed to load on-demand preview'));
					img.src = url;
				});
			} else {
				// Failed to load from disk
				canvas.width = 200;
				canvas.height = 50;
				ctx.fillStyle = '#333';
				ctx.fillRect(0, 0, 200, 50);
				ctx.fillStyle = '#999';
				ctx.font = '12px sans-serif';
				ctx.fillText('Preview load failed', 20, 30);
				return;
			}
		} else {
			// No preview data available
			canvas.width = 200;
			canvas.height = 50;
			ctx.fillStyle = '#333';
			ctx.fillRect(0, 0, 200, 50);
			ctx.fillStyle = '#999';
			ctx.font = '12px sans-serif';
			ctx.fillText('Preview not available', 20, 30);
			return;
		}

		// Scale to fit max 500px while maintaining aspect ratio
		const maxSize = 500;
		const imgWidth = img?.width || frame?.width || 200;
		const imgHeight = img?.height || frame?.height || 200;
		if (!imgWidth || !imgHeight) {
			console.warn('Invalid image dimensions, using placeholder');
			canvas.width = 200;
			canvas.height = 50;
			ctx.fillStyle = '#333';
			ctx.fillRect(0, 0, 200, 50);
			ctx.fillStyle = '#999';
			ctx.font = '12px sans-serif';
			ctx.fillText('Invalid dimensions', 20, 30);
			return;
		}
		const scale = Math.min(maxSize / imgWidth, maxSize / imgHeight, 1);
		const drawWidth = imgWidth * scale;
		const drawHeight = imgHeight * scale;

		canvas.width = drawWidth;
		canvas.height = drawHeight;
		ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

		if (url) URL.revokeObjectURL(url);
	} catch (e) {
		console.error('Error drawing preview:', e);
	}
}

function updateThreshold() {
	drawGraph();
}

function onGraphClick(e) {
	const canvas = graphCanvas.value;
	const rect = canvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const width = rect.width;

	const padding = { left: 10, right: 10 };
	const graphWidth = width - padding.left - padding.right;

	const clickPosition = (x - padding.left) / graphWidth;
	const newThreshold = Math.max(1, Math.min(Math.round(clickPosition * sortedFrames.value.length), sortedFrames.value.length));

	// Update threshold (how many frames to include)
	selectedCount.value = newThreshold;
	drawGraph();
}

function onGraphHover(e) {
	// Could add hover effects here
}

function onFrameSliderChange() {
	// Stop playback when manually changing frame
	if (isPlaying.value) {
		stopPlayback();
	}

	previewFrame.value = sortedFrames.value[previewFrameIndex.value];
	drawGraph();
	drawPreview();
}

function togglePlayback() {
	if (isPlaying.value) {
		stopPlayback();
	} else {
		startPlayback();
	}
}

function startPlayback() {
	isPlaying.value = true;
	// Continue from current position (don't reset to 0)
	playIndex.value = previewFrameIndex.value;

	drawGraph();

	// Play at ~10 fps (100ms per frame)
	playInterval = setInterval(() => {
		playIndex.value++;

		if (playIndex.value >= sortedFrames.value.length) {
			// Loop back to start
			playIndex.value = 0;
		}

		previewFrameIndex.value = playIndex.value;
		previewFrame.value = sortedFrames.value[playIndex.value];
		drawGraph();
		drawPreview();
	}, 100);
}

function stopPlayback() {
	isPlaying.value = false;
	if (playInterval) {
		clearInterval(playInterval);
		playInterval = null;
	}
	drawGraph();
}

// Abandon the run and go back to the home state. A reload is what the other
// start-over paths do: it also frees the analysed frames and workers.
function cancelSelection() {
	stopPlayback();
	window.location.href = '/';
}

function proceedWithStacking() {
	// Stop playback before stacking
	stopPlayback();

	// Get the frames to stack (top N by sharpness)
	const framesToStack = sortedFrames.value.slice(0, selectedCount.value);

	emit('threshold-selected', {
		frames: framesToStack,
		threshold: selectedCount.value,
		percentage: selectedCount.value / totalFrames.value
	});
}
</script>

<style scoped>
.threshold-readout {
	display: flex;
	align-items: baseline;
	gap: 8px;
	margin-bottom: 4px;
}
.threshold-count {
	font-family: var(--eise-mono);
	font-size: 26px;
	font-weight: 500;
	letter-spacing: -0.02em;
	color: var(--eise-gilt-lt);
}
.threshold-total,
.threshold-pct {
	font-family: var(--eise-mono);
	font-size: 13px;
	color: #8fa9b1;
}
.threshold-pct {
	margin-left: auto;
}
.threshold-controls input[type="range"] {
	width: 100%;
	margin: 6px 0 4px;
}
.visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip: rect(0 0 0 0);
	white-space: nowrap;
	border: 0;
}
.graph-labels {
	display: flex;
	justify-content: space-between;
	font-family: var(--eise-mono);
	font-size: 10.5px;
	letter-spacing: 0.05em;
	color: var(--eise-label);
}
.graph-container {
	position: relative;
	height: 128px;
	margin-top: 16px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.22);
	border: 1px solid rgba(255, 255, 255, 0.09);
	overflow: hidden;
}
.graph-container canvas {
	display: block;
	width: 100%;
	cursor: crosshair;
}
.graph-scores {
	display: flex;
	justify-content: space-between;
	margin-top: 7px;
	font-family: var(--eise-mono);
	font-size: 10.5px;
	color: var(--eise-label);
}
/* Own class, not .action-buttons: that global rule is a flex row. */
.stack-actions {
	padding-top: 0;
	padding-bottom: 22px;
}
.stack-btn {
	width: 100%;
	padding: 11px 16px;
	border: none;
	border-radius: 7px;
	background: var(--eise-gilt);
	color: var(--eise-panel);
	font: inherit;
	font-size: 14px;
	font-weight: 600;
	cursor: pointer;
	transition: background 120ms ease;
}
.stack-btn:hover {
	background: #f3d290;
	color: var(--eise-panel);
}
.cancel-btn {
	width: 100%;
	margin-top: 10px;
	padding: 10px 16px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.18);
	color: #f0d6d6;
	font: inherit;
	font-size: 13.5px;
	font-weight: 500;
	cursor: pointer;
	transition: background 120ms ease, border-color 120ms ease;
}
.cancel-btn:hover {
	background: rgba(196, 92, 84, 0.22);
	border-color: rgba(226, 120, 110, 0.6);
	color: #ffdcd6;
}

/* Preview column */
.content {
	max-width: 900px;
	padding: 0;
}
.preview-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}
.preview-title {
	display: flex;
	align-items: baseline;
	gap: 10px;
}
.preview-eyebrow {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--eise-label);
}
.preview-frame-no {
	font-family: var(--eise-mono);
	font-size: 13px;
	color: var(--eise-bright);
}
/* Verdict pill: whether this frame makes the cut. */
.verdict {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	padding: 4px 11px;
	border-radius: 999px;
	font-size: 12.5px;
	font-weight: 500;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.14);
	color: #8fa9b1;
}
.verdict.included {
	background: rgba(122, 178, 142, 0.14);
	border-color: rgba(122, 178, 142, 0.42);
	color: #a8dcb9;
}
/* Holds the design's 4:3 box, so the column keeps its shape while a frame is
   still decoding instead of collapsing to a black strip. */
.preview-stage {
	display: grid;
	place-items: center;
	width: 100%;
	aspect-ratio: 4 / 3;
	max-height: 68vh;
	background: #000000;
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 10px;
	overflow: hidden;
	box-shadow: 0 12px 44px rgba(0, 0, 0, 0.45);
}
.preview-canvas {
	display: block;
	max-width: 100%;
	max-height: 100%;
}
.frame-slider {
	display: flex;
	align-items: center;
	gap: 14px;
	margin-top: 14px;
}
.frame-slider input[type="range"] {
	flex: 1;
	min-width: 0;
	height: 4px;
	accent-color: var(--eise-gilt);
}
.play-button {
	flex: 0 0 auto;
	width: 38px;
	height: 38px;
	display: grid;
	place-items: center;
	padding: 0;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.18);
	color: var(--eise-gilt-lt);
	cursor: pointer;
}
.play-button:hover {
	background: rgba(217, 169, 74, 0.18);
	border-color: rgba(217, 169, 74, 0.5);
	color: var(--eise-gilt-lt);
}
.frame-position {
	flex: 0 0 auto;
	font-family: var(--eise-mono);
	font-size: 12.5px;
	color: #8fa9b1;
}
.frame-stats-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 1px 20px;
	margin-top: 22px;
	border-top: 1px solid var(--eise-panel-line);
}
.stat {
	padding: 13px 0;
	border-bottom: 1px solid var(--eise-panel-line);
	min-width: 0;
}
.stat-label {
	margin-bottom: 4px;
	font-size: 11px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--eise-label);
}
.stat-value {
	font-family: var(--eise-mono);
	font-size: 15px;
	color: var(--eise-bright);
}
.stat-sub {
	margin-top: 4px;
	font-family: var(--eise-mono);
	font-size: 10.5px;
	color: var(--eise-muted);
}
.no-preview {
	display: grid;
	place-items: center;
	width: 100%;
	aspect-ratio: 4 / 3;
	border: 1px dashed rgba(255, 255, 255, 0.18);
	border-radius: 10px;
	background: rgba(0, 0, 0, 0.16);
	color: #6b8792;
	font-size: 13px;
}
@media (max-width: 560px) {
	.frame-stats-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
