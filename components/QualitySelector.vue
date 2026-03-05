<template>
<div class="page-layout">
	<div class="card">
		<h3>Select Quality Threshold</h3>
		<p>Drag the slider to choose how many frames to include in the stack.</p>
		<p>Frames are sorted from sharpest (left) to blurriest (right).</p>

		<div class="threshold-controls">
			<label>
				<strong>Include top:</strong>
				<input type="range" min="1" :max="totalFrames" v-model.number="selectedCount" @input="updateThreshold" :key="'slider-' + totalFrames" />
				<span class="threshold-value">{{ selectedCount }} / {{ totalFrames }} frames ({{ percentageText }})</span>
			</label>
		</div>

		<div class="graph-container">
			<canvas ref="graphCanvas" @click="onGraphClick" @mousemove="onGraphHover"></canvas>
			<div class="graph-labels">
				<span>Best</span>
				<span>Worst</span>
			</div>
		</div>

		<div class="action-buttons">
			<button class="stack-button" @click="proceedWithStacking">Stack {{ selectedCount }} frames</button>
		</div>
	</div>

	<div class="content">
		<div class="preview-section" v-if="previewFrame">
			<h4>
				<span v-if="isPlaying">Playing: </span>
				<span v-else>Preview: </span>
				Frame #{{ previewFrameIndex + 1 }}
				<span class="sharpness-badge" :class="{ included: previewFrameIndex < selectedCount }">
					Sharpness: {{ previewFrame.sharpness?.toFixed(2) || '?' }} · Circularity: {{ previewFrame.circularity?.toFixed(2) || '?' }}
					<span v-if="previewFrameIndex < selectedCount">(included)</span>
					<span v-else>(excluded)</span>
				</span>
			</h4>
			<canvas ref="previewCanvas" class="preview-canvas"></canvas>
			<div class="frame-slider">
				<input type="range" min="0" :max="totalFrames - 1" v-model.number="previewFrameIndex" @input="onFrameSliderChange" />
				<span class="frame-position">{{ previewFrameIndex + 1 }} / {{ totalFrames }}</span>
			</div>
			<div class="playback-controls">
				<button class="play-button" @click="togglePlayback">
					{{ isPlaying ? '⏸ Pause' : '▶ Play' }}
				</button>
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
	const height = 150;
	canvas.width = width * dpr;
	canvas.height = height * dpr;
	canvas.style.width = width + 'px';
	canvas.style.height = height + 'px';
	ctx.scale(dpr, dpr);

	// Clear
	ctx.fillStyle = '#f5f5f5';
	ctx.fillRect(0, 0, width, height);

	// Find min/max sharpness for scaling
	const sharpnessValues = sortedFrames.value.map(f => f.sharpness);
	const maxSharpness = Math.max(...sharpnessValues);
	const minSharpness = Math.min(...sharpnessValues);
	const range = maxSharpness - minSharpness || 1;

	const padding = { left: 10, right: 10, top: 10, bottom: 25 };
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
			ctx.fillStyle = '#8CCF7E'; // Green for included
		} else {
			ctx.fillStyle = '#ccc'; // Gray for excluded
		}

		ctx.fillRect(x, y, Math.max(barWidth - 0.5, 1), barHeight);
	}

	// Draw threshold line (orange dashed)
	const thresholdX = padding.left + (selectedCount.value / sortedFrames.value.length) * graphWidth;
	ctx.strokeStyle = '#ff5722';
	ctx.lineWidth = 2;
	ctx.setLineDash([5, 3]);
	ctx.beginPath();
	ctx.moveTo(thresholdX, padding.top);
	ctx.lineTo(thresholdX, height - padding.bottom);
	ctx.stroke();
	ctx.setLineDash([]);

	// Draw play position indicator (yellow/gold, only when playing)
	if (isPlaying.value) {
		const playX = padding.left + ((playIndex.value + 0.5) / sortedFrames.value.length) * graphWidth;
		ctx.strokeStyle = '#FFC107';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(playX, padding.top);
		ctx.lineTo(playX, height - padding.bottom);
		ctx.stroke();
	}

	// Draw preview position indicator (cyan, when not playing)
	if (!isPlaying.value) {
		const previewX = padding.left + ((previewFrameIndex.value + 0.5) / sortedFrames.value.length) * graphWidth;
		ctx.strokeStyle = '#c6fffd';
		ctx.lineWidth = 2;
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
.threshold-controls {
	margin: 15px 0;
}

.threshold-controls input[type="range"] {
	width: 200px;
	margin: 0 10px;
}

.threshold-value {
	font-weight: bold;
	color: #8CCF7E;
}

.graph-container {
	margin: 20px 0;
	background: #f5f5f5;
	border-radius: 5px;
	padding: 10px;
}

.graph-container canvas {
	width: 100%;
	cursor: crosshair;
	border-radius: 3px;
}

.graph-labels {
	display: flex;
	justify-content: space-between;
	font-size: 11px;
	color: #666;
	margin-top: 5px;
}

.playback-controls {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 15px;
	margin-top: 20px;
}

.play-button {
	background-color: #27587c;
	color: white;
	padding: 8px 16px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
}

.play-button:hover {
	background-color: #1D4A66;
}

.play-status {
	color: #666;
	font-size: 13px;
}

.content {
	max-width: none;
	padding: 20px;
}

.preview-section {
	padding: 20px 0;
	overflow: hidden;
}

.preview-section h4 {
	margin: 0 0 15px 0;
	font-size: 14px;
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	color: #c6fffd;
}

.sharpness-badge {
	font-size: 12px;
	padding: 3px 8px;
	background: #eee;
	border-radius: 4px;
	color: #666;
}

.sharpness-badge.included {
	background: #e8f5e9;
	color: #2e7d32;
}

.preview-canvas {
	display: block;
	margin: 0 auto;
	border: 1px solid #ddd;
	border-radius: 5px;
	max-width: 100%;
}

.frame-slider {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 10px;
	margin-top: 15px;
}

.frame-slider input[type="range"] {
	width: 300px;
	max-width: 80%;
}

.frame-position {
	font-size: 13px;
	color: #c6fffd;
	min-width: 70px;
}

.no-preview {
	padding: 40px;
	text-align: center;
	color: #c6fffd;
}

.action-buttons {
	margin-top: 20px;
	text-align: center;
}

.stack-button {
	background-color: #8CCF7E;
	color: #111;
	padding: 12px 30px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 16px;
	font-weight: bold;
}

.stack-button:hover {
	background-color: #7ABF6E;
}

</style>
