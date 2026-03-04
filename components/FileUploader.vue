<template>
<div class="page-layout">
	<div class="card">
		<!-- LoadingIndicator always mounted so it can receive events -->
		<LoadingIndicator />

		<!-- Status indicators (mobile only) -->
		<div v-if="isMobileClient" class="status-indicators">
			<span class="status-item" :class="{ active: useGPU }">
				<span class="status-check">{{ useGPU ? '✓' : '✗' }}</span> GPU
			</span>
			<span class="status-item" :class="{ active: !useGPU }">
				<span class="status-check">{{ !useGPU ? '✓' : '✗' }}</span> CPU
			</span>
		</div>

		<!-- Cancel button during processing -->
		<div v-if="isProcessing" class="action-buttons processing-actions">
			<button class="cancel-button" @click="cancelProcessing">Cancel</button>
		</div>

		<!-- Initial state: file selection and settings (hidden during processing) -->
		<template v-if="!isProcessing">
			<h3>Select file(s) for stacking and/or post processing</h3>
			<div class="file-input-wrapper">
				<input id="file-upload" ref="fileInput" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
				<label for="file-upload" class="file-label">
					{{ selectedFiles.length > 0 ? selectedFilesDescription : 'Choose files...' }}
				</label>
			</div>
			<p class="supported-formats">SER, AVI, MP4, PNG, TIFF, JPEG</p>

			<div v-if="liteModeClient" class="lite-mode-warning">
				Stacking on mobile devices will likely not work due to memory limitations. For best results, use eise.app on a laptop or desktop computer.
			</div>

			<div v-if="selectedFiles.length > 0" class="selected-files">
				<div v-if="showMemoryOptimization" class="memory-optimization-box">
					<p class="optimization-hint">
						Memory optimization options:
					</p>
					<label class="checkbox-option">
						<input type="checkbox" v-model="enablePreCrop" />
						Pre-crop video
						<span v-if="preCropAutoEnabled" class="auto-badge">auto</span>
					</label>
					<label class="checkbox-option">
						<input type="checkbox" v-model="enableMaxFrames" />
						Limit to
						<input type="number" v-model.number="selectedMaxFrames" min="100" max="5000" step="100" class="inline-number" :disabled="!enableMaxFrames" />
						frames
					</label>
				</div>

				<div class="action-buttons">
					<button class="start-button" @click="startProcessing">{{ startButtonText }}</button>
					<button class="clear-button" @click="clearSelection">Clear</button>
				</div>
			</div>

			<div v-if="errorMessage" class="error-message">
				<p>{{ errorMessage }}</p>
			</div>

			<div class="separator"></div>

			<h4>Target <span class="info-icon" @click="showTargetInfo = !showTargetInfo">ⓘ</span></h4>
			<div class="radio-group">
				<label class="radio-option">
					<input type="radio" v-model="targetType" value="planet" />
					Planet (or Moon fully in frame)
				</label>
				<label class="radio-option">
					<input type="radio" v-model="targetType" value="sun-moon" />
					Surface: Closeup of Sun or Moon
				</label>
			</div>
			<p v-if="showTargetInfo" class="info-text"><strong>Planet:</strong> For full-disk planets or Moon. Rejects frames where the object touches the edge.<br><strong>Surface:</strong> For Moon/Sun closeups. Disables edge detection and uses drift tracking for larger frame-to-frame motion.</p>

			<!-- Frame selection hidden in lite mode (defaults to 30%) -->
			<template v-if="!liteModeClient">
				<div class="separator"></div>

				<h4>Frame selection <span class="info-icon" @click="showFrameSelectionInfo = !showFrameSelectionInfo">ⓘ</span></h4>
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" v-model="qualityMode" value="manual" />
						Manually pick best frames threshold
					</label>
					<label class="radio-option">
						<input type="radio" v-model="qualityMode" value="percentage" />
						Stack best
						<input type="number" v-model.number="stackPercentage" min="1" max="100" class="percentage-input" :disabled="qualityMode !== 'percentage'" />%
					</label>
				</div>
				<p v-if="showFrameSelectionInfo" class="info-text"><strong>Manual:</strong> After analysis, you'll see a quality graph and can choose which frames to stack.<br><strong>Percentage:</strong> Automatically selects the sharpest frames. Recommended if you run into memory issues.</p>
			</template>

			<!-- Advanced options hidden in lite mode -->
			<template v-if="!liteModeClient">
				<div class="separator"></div>

				<h4>Stacking mode <span class="info-icon" @click="showStackingModeInfo = !showStackingModeInfo">ⓘ</span></h4>
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" v-model="drizzleMode" value="1.5x" />
						1.5x Drizzle (recommended)
					</label>
					<label class="radio-option">
						<input type="radio" v-model="drizzleMode" value="1x" />
						Normal (1x)
					</label>
				</div>

				<label class="checkbox-option">
					<input type="checkbox" v-model="useVngDemosaic" />
					VNG demosaicing
				</label>


				<label class="checkbox-option">
					AP size:
					<input type="number" min="10" max="64" step="2" v-model.number="apPatchSize" class="small-number-input" />
				</label>

				<label class="checkbox-option">
					AP quality threshold:
					<input type="number" min="0.1" max="0.9" step="0.05" v-model.number="minApQuality" class="small-number-input" />
				</label>

								<p v-if="showStackingModeInfo" class="info-text"><strong>Drizzle:</strong> Uses sub-pixel offsets to increase output resolution by 1.5x. Best with 100+ frames.<br><strong>Normal:</strong> Stacks at original resolution. Faster and uses less memory.<br><strong>AP quality threshold:</strong> Minimum NCC correlation score for alignment points. Higher values reject more uncertain matches, reducing artifacts but may leave gaps. Try 0.5-0.6 if you see polygon artifacts.<br><strong>AP size:</strong> Size of alignment point patches in pixels. Smaller = finer precision for local distortion correction, but needs enough features to match. Default 30 is a safe middle ground.<br><strong>VNG demosaicing:</strong> Variable Number of Gradients - higher quality color interpolation for raw Bayer data. When disabled, uses faster bilinear interpolation.</p>

				<template v-if="targetType !== 'sun-moon'">
					<div class="separator"></div>

					<h4>Crop margin <span class="info-icon" @click="showCropMarginInfo = !showCropMarginInfo">ⓘ</span></h4>
					<input type="range" min="5" max="50" step="5" v-model="cropMarginPercent" />
					{{ cropMarginPercent }}%
					<p v-if="showCropMarginInfo" class="info-text">Extra space around detected object. Increase for Saturn's rings, decrease for tighter crops.</p>
				</template>

				</template>

			<!-- Max frames - always visible (important for lite mode) -->
			<template v-if="!showMemoryOptimization">
				<div class="separator"></div>
				<h4>Max frames <span class="info-icon" @click="showMaxFramesInfo = !showMaxFramesInfo">ⓘ</span></h4>
				<label>
					<input type="checkbox" v-model="enableMaxFrames" />
					Limit frames
				</label>
				<input type="range" min="2" :max="liteModeClient ? 100 : 5000" step="1" v-model="selectedMaxFrames" :disabled="!enableMaxFrames" />
				{{ enableMaxFrames ? selectedMaxFrames : '∞' }}
				<p v-if="showMaxFramesInfo" class="info-text">Lower this if you experience memory issues.</p>
			</template>
		</template>
	</div>

	<!-- Welcome content: only show when not processing -->
	<div class="content" v-if="!isProcessing">
		<h2>Welcome to eise.app</h2>
		<h3>An easy image stacker for planetary astrophotography</h3>
		<p>Turn your blurry and shaky videos of planets, Moon, or Sun into one stacked and sharp image using <em>lucky imaging</em> - a classic astrophotography technique.</p>
		<ul>
			<li>Select one or more SER files for stacking followed by post processing. (Multiple SER files will be combined)</li>
			<li>Select one video file (AVI, MP4, etc.) for stacking followed by post processing.</li>
			<li>Select multiple image files (TIFF, PNG, JPG, etc.) for stacking and post processing.</li>
			<li>Select one image file for <NuxtLink to="/post-processor/">post processing</NuxtLink> only.</li>
		</ul>
		<p>When stacking, eise.app analyzes, crops, centers and ranks all frames by sharpness and circularity, and it drops frames that are (almost) cut-off. No need for PIPP!</p>
		<p><strong>Tip:</strong> For Moon or Sun surface closeups, select "Surface" mode above to handle larger frame-to-frame drift.</p>
		<h3>More information, bugs and feature requests?</h3>
		<p>Read more on the <NuxtLink to="/about/">About page</NuxtLink>, or head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on Github</a>. If you have feedback or you run into issues, <a href="#" @click.prevent="openFeedback()">Let me know!</a></p>

		<p class="build-date">Latest release: {{ buildDate }}</p>
		<div class="comparison-images">
			<img src="/jupiter-singleframe.png" alt="Single frame" />
			<span class="arrow">&rarr;</span>
			<img src="/jupiter-stacked.png" alt="Stacked result" />
		</div>
	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { computed, defineEmits, ref, onMounted, watch, inject } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useSerReader } from '@/composables/useSerReader';
import { useAviReader } from '@/composables/useAviReader';
import { useImageReader } from '@/composables/useImageReader';
import { useProcessingState } from '@/composables/useProcessingState';
import { reportError } from '@/composables/useSentryReporting';
import { useFeedback } from '@/composables/useFeedback';
import { useTracking } from '@/composables/useTracking';
import { useLiteMemoryLimits } from '@/composables/useLiteMemoryLimits';

// Lite mode: auto-enabled on mobile OR when WebGPU unavailable
// Limitations: max 100 frames, no drizzle, 8-bit, limited UI
const liteMode = inject('liteMode', ref(false));

/// GPU vs CPU: use GPU when available (even in lite mode on mobile)
const useGPU = inject('useGPU', ref(false));
const isMobile = inject('isMobile', ref(false));
const isMobileClient = ref(false); // Only true after mount to avoid hydration mismatch
const liteModeClient = ref(false); // Only true after mount to avoid hydration mismatch

// Build date from nuxt.config.ts (set at build time)
const config = useRuntimeConfig();
const buildDate = computed(() => {
	const ts = config.public.buildTimestamp;
	if (!ts) return '';
	return new Date(ts).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
});

const { track } = useTracking();
const { detectPlatform, checkFileSize } = useLiteMemoryLimits();

const { openFeedback } = useFeedback();
const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const enableMaxFrames = ref(false);
const selectedMaxFrames = ref(100);

const errorMessage = ref(null);

// Info toggle state
const showMaxFramesInfo = ref(false);
const showCropMarginInfo = ref(false);
const showPreCropInfo = ref(false);
const showTargetInfo = ref(false);
const showFrameSelectionInfo = ref(false);
const showStackingModeInfo = ref(false);

// Crop margin setting (percentage of detected object size to add as margin)
const cropMarginPercent = ref(10);

// Quality threshold mode: 'manual' for interactive selection, 'percentage' for automatic
const qualityMode = ref('manual');
const stackPercentage = ref(30);
const drizzleMode = ref('1.5x'); // '1x' or '1.5x'
const noiseRobustAlignment = ref(false);
const useVngDemosaic = ref(true); // VNG demosaic (default) vs bilinear
const minApQuality = ref(0.3); // Alignment point quality threshold (NCC score)
const apPatchSize = ref(30); // Alignment point patch size in pixels
// Computed for checkbox binding - shows unchecked when GPU is on
const noiseRobustAlignmentVisible = computed({
	get: () => useGPU.value ? false : noiseRobustAlignment.value,
	set: (val) => { noiseRobustAlignment.value = val; }
});

// Target type: 'planet' or 'sun-moon' - affects cut-off frame detection
const targetType = ref('planet');
const surfaceMode = computed(() => targetType.value === 'sun-moon');

// Lite mode enforced settings (applies to mobile + no-GPU desktop)
const effectiveDrizzleScale = computed(() => liteMode.value ? 1.0 : (drizzleMode.value === '1.5x' ? 1.5 : 1.0));
const effectiveMaxFrames = computed(() => liteMode.value ? 100 : (enableMaxFrames.value ? selectedMaxFrames.value : -1));
const effectiveCropMargin = computed(() => liteMode.value ? 15 : cropMarginPercent.value);
const effectiveNoiseRobust = computed(() => (liteMode.value || useGPU.value) ? false : noiseRobustAlignment.value);
const effectiveQualityMode = computed(() => liteMode.value ? 'percentage' : qualityMode.value);
const effectiveStackPercentage = computed(() => liteMode.value ? 30 : stackPercentage.value);

// Memory optimized pre-crop for mobile videos
const enablePreCrop = ref(false);
const preCropAutoEnabled = ref(false); // Track if it was auto-enabled
// Load settings from localStorage
function loadSettings() {
	try {
		const saved = localStorage.getItem('eise-settings');
		if (saved) {
			const settings = JSON.parse(saved);
			if (settings.qualityMode) qualityMode.value = settings.qualityMode;
			if (settings.stackPercentage) stackPercentage.value = settings.stackPercentage;
			if (settings.drizzleMode) drizzleMode.value = settings.drizzleMode;
			if (settings.noiseRobustAlignment !== undefined) noiseRobustAlignment.value = settings.noiseRobustAlignment;
			if (settings.cropMarginPercent) cropMarginPercent.value = settings.cropMarginPercent;
			if (settings.enableMaxFrames !== undefined) enableMaxFrames.value = settings.enableMaxFrames;
			if (settings.selectedMaxFrames) selectedMaxFrames.value = settings.selectedMaxFrames;
			if (settings.targetType) targetType.value = settings.targetType;
			if (settings.useVngDemosaic !== undefined) useVngDemosaic.value = settings.useVngDemosaic;
			if (settings.minApQuality !== undefined) minApQuality.value = settings.minApQuality;
			if (settings.apPatchSize !== undefined) apPatchSize.value = settings.apPatchSize;
		}
	} catch (e) {
		console.warn('Failed to load settings:', e);
	}
}

// Save settings to localStorage
function saveSettings() {
	try {
		const settings = {
			qualityMode: qualityMode.value,
			stackPercentage: stackPercentage.value,
			drizzleMode: drizzleMode.value,
			noiseRobustAlignment: noiseRobustAlignment.value,
			cropMarginPercent: cropMarginPercent.value,
			enableMaxFrames: enableMaxFrames.value,
			selectedMaxFrames: selectedMaxFrames.value,
			targetType: targetType.value,
			useVngDemosaic: useVngDemosaic.value,
			minApQuality: minApQuality.value,
			apPatchSize: apPatchSize.value
		};
		localStorage.setItem('eise-settings', JSON.stringify(settings));
	} catch (e) {
		console.warn('Failed to save settings:', e);
	}
}

// Watch all settings and save on change
watch([qualityMode, stackPercentage, drizzleMode, noiseRobustAlignment, cropMarginPercent, enableMaxFrames, selectedMaxFrames, targetType, useVngDemosaic, minApQuality, apPatchSize], saveSettings);

onMounted(async () => {
	loadSettings();
	isMobileClient.value = isMobile.value;
	liteModeClient.value = liteMode.value;

	// In lite mode, enable max frames with default of 100
	if (liteMode.value) {
		enableMaxFrames.value = true;
		selectedMaxFrames.value = 100;
	}
});

const selectedFiles = ref([]);
const isProcessing = ref(false);
const fileInput = ref(null);

const emit = defineEmits(['postProcessing', 'processing-started']);

const selectedFilesDescription = computed(() => {
	if (selectedFiles.value.length === 0) return '';
	if (selectedFiles.value.length === 1) return selectedFiles.value[0].name;
	return `${selectedFiles.value.length} files`;
});

const startButtonText = computed(() => {
	if (selectedFiles.value.length === 1) {
		const file = selectedFiles.value[0];
		if (file.type.startsWith('image/')) {
			return 'Post process';
		}
	}
	return 'Stack';
});

// Show pre-crop option for video files that might need FFmpeg (not SER)
const showPreCropOption = computed(() => {
	if (selectedFiles.value.length !== 1) return false;
	const file = selectedFiles.value[0];
	if (file.name.toLowerCase().endsWith('.ser')) return false;
	// Show for any video file (including AVI that might need FFmpeg)
	return file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.avi');
});

// Detect mobile device
const isMobileDevice = computed(() => {
	if (typeof navigator === 'undefined') return false;
	return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
});

// Show memory optimization box only on mobile (hidden in lite mode - already constrained)
const showMemoryOptimization = computed(() => {
	if (liteMode.value) return false;
	if (!showPreCropOption.value) return false;
	return isMobileDevice.value;
});

// Auto-enable pre-crop for mobile devices OR lite mode (saves memory)
watch([selectedFiles, isMobileDevice, liteMode], () => {
	if (showPreCropOption.value && (isMobileDevice.value || liteMode.value)) {
		enablePreCrop.value = true;
		preCropAutoEnabled.value = true;
	} else {
		// Reset pre-crop when not needed
		if (preCropAutoEnabled.value) {
			enablePreCrop.value = false;
		}
		preCropAutoEnabled.value = false;
	}
}, { immediate: true });

const { addLog, emit: eventBusEmit, on, logs } = useEventBus();
const { setMinApQuality: setSharedMinApQuality, setApPatchSize: setSharedApPatchSize } = useProcessingState();

// Sync stacking settings to shared state for stacker to use
watch(minApQuality, (val) => setSharedMinApQuality(val), { immediate: true });
watch(apPatchSize, (val) => setSharedApPatchSize(val), { immediate: true });

// Listen for upload errors to display them
on('upload-error', (message) => {
	errorMessage.value = message;
});

function onFileChanged(event){
	errorMessage.value = null; // Clear previous error
	selectedFiles.value = Array.from(event.target.files);
	eventBusEmit('stop-loading');
}

// Pre-crop detection: sample frames and find planet bounds
async function detectPreCropRegion(filename) {
	addLog('Sampling frames to detect crop region...');
	eventBusEmit('set-caption', 'Detecting crop region...');

	// Get video info from FFmpeg output
	let videoWidth = 0;
	let videoHeight = 0;
	let duration = 0;

	// Probe video by running FFmpeg briefly
	$ffmpeg.setLogger(({ type, message }) => {
		if (typeof message !== 'string') return;
		// Parse resolution: "Stream #0:0: Video: h264, 1920x1080"
		const resMatch = message.match(/(\d{3,4})x(\d{3,4})/);
		if (resMatch && !videoWidth) {
			videoWidth = parseInt(resMatch[1], 10);
			videoHeight = parseInt(resMatch[2], 10);
		}
		// Parse duration: "Duration: 00:01:30.50"
		const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
		if (durMatch) {
			duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
		}
	});

	// Run brief probe
	try {
		await $ffmpeg.run('-i', filename, '-f', 'null', '-t', '0.001', '-');
	} catch (e) {
		// FFmpeg exits with error for -f null, that's fine
	}

	addLog(`Video: ${videoWidth}x${videoHeight}, duration: ${duration.toFixed(1)}s`);

	if (!videoWidth || !videoHeight) {
		addLog('Could not detect video dimensions, skipping pre-crop');
		return null;
	}

	// Sample 10 frames spread across the video, extracting ONE AT A TIME to minimize memory
	const sampleCount = 10;
	const allBounds = [];

	// Calculate time positions for each sample (skip first/last 10% of video)
	const startTime = duration * 0.1;
	const endTime = duration * 0.9;
	const timeStep = (endTime - startTime) / (sampleCount - 1);

	eventBusEmit('update-loading', { progress: 10, current: 0, total: sampleCount });

	// Suppress FFmpeg info output during sampling
	$ffmpeg.setLogger(() => {});

	// Extract and process one frame at a time to minimize peak memory
	for (let i = 0; i < sampleCount; i++) {
		const seekTime = startTime + (i * timeStep);
		const sampleFile = 'sample.png';

		eventBusEmit('set-caption', `Sampling frame ${i + 1}/${sampleCount}...`);
		eventBusEmit('update-loading', { progress: 10 + ((i + 1) / sampleCount) * 40, current: i + 1, total: sampleCount });

		try {
			// Extract single frame at this time position
			await $ffmpeg.run(
				'-ss', seekTime.toFixed(2),
				'-i', filename,
				'-vframes', '1',
				'-y',  // Overwrite previous sample
				sampleFile
			);

			const pngData = $ffmpeg.FS('readFile', sampleFile);
			$ffmpeg.FS('unlink', sampleFile);

			// Decode PNG and detect bounds using canvas
			const blob = new Blob([pngData], { type: 'image/png' });
			const bitmap = await createImageBitmap(blob);

			// Create canvas to get pixel data
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext('2d');
			ctx.drawImage(bitmap, 0, 0);
			const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

			// Simple bright object detection
			const bounds = detectBrightObjectBounds(imageData.data, bitmap.width, bitmap.height);
			if (bounds) {
				allBounds.push(bounds);
				addLog(`Sample ${i + 1}: planet at (${bounds.x}, ${bounds.y}) size ${bounds.width}x${bounds.height}`);
			}
		} catch (e) {
			addLog(`Sample ${i + 1} extraction failed: ${e.message}`);
		}
	}

	if (allBounds.length === 0) {
		addLog('No planet detected in samples, skipping pre-crop');
		return null;
	}

	// Calculate encompassing region with margin
	const minX = Math.min(...allBounds.map(b => b.x));
	const minY = Math.min(...allBounds.map(b => b.y));
	const maxX = Math.max(...allBounds.map(b => b.x + b.width));
	const maxY = Math.max(...allBounds.map(b => b.y + b.height));

	const regionWidth = maxX - minX;
	const regionHeight = maxY - minY;
	const margin = Math.max(regionWidth, regionHeight) * (cropMarginPercent.value / 100);

	// Calculate crop with margin, ensuring it stays within bounds and is even (for video codecs)
	let cropX = Math.max(0, Math.floor(minX - margin));
	let cropY = Math.max(0, Math.floor(minY - margin));
	let cropW = Math.min(videoWidth - cropX, Math.ceil(regionWidth + margin * 2));
	let cropH = Math.min(videoHeight - cropY, Math.ceil(regionHeight + margin * 2));

	// Make dimensions even for video codec compatibility
	cropW = Math.floor(cropW / 2) * 2;
	cropH = Math.floor(cropH / 2) * 2;

	addLog(`Pre-crop region: ${cropW}x${cropH} at (${cropX}, ${cropY})`);
	addLog(`Memory reduction: ${((1 - (cropW * cropH) / (videoWidth * videoHeight)) * 100).toFixed(0)}%`);

	return { x: cropX, y: cropY, width: cropW, height: cropH };
}

// Simple bright object detection for pre-crop sampling
function detectBrightObjectBounds(pixels, width, height) {
	// Convert to grayscale and find threshold
	const gray = new Uint8Array(width * height);
	let maxVal = 0;

	for (let i = 0; i < width * height; i++) {
		const r = pixels[i * 4];
		const g = pixels[i * 4 + 1];
		const b = pixels[i * 4 + 2];
		gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		if (gray[i] > maxVal) maxVal = gray[i];
	}

	// Threshold at 30% of max brightness
	const threshold = maxVal * 0.3;

	let minX = width, minY = height, maxX = 0, maxY = 0;
	let found = false;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (gray[y * width + x] > threshold) {
				found = true;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	if (!found || maxX <= minX || maxY <= minY) return null;

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY
	};
}

async function startProcessing() {
	if (selectedFiles.value.length === 0) return;
	errorMessage.value = null;
	isProcessing.value = true;
	eventBusEmit('start-loading', 'Preparing...');

	if (liteMode.value) {
		addLog('Lite Mode: max 100 frames, best 30%, 1x stacking, CPU processing');
	}

	try {
		await processFiles(selectedFiles.value);
	} catch (error) {
		console.error('Processing error:', error);
		const filename = selectedFiles.value?.[0]?.name;
		reportError(error, {
			component: 'FileUploader',
			action: 'processFiles',
			filename,
			logs: logs.value
		});
		track('stack_failed');
		errorMessage.value = error.message || 'An error occurred during processing';
		isProcessing.value = false;
		eventBusEmit('show-error');
	}
}

function cancelProcessing() {
	track('stack_cancelled');
	isProcessing.value = false;
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	eventBusEmit('stop-loading');
	eventBusEmit('cancel-processing');
	window.location.reload();
}

function clearSelection() {
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	errorMessage.value = null;
}

// Unsupported RAW camera formats
const RAW_EXTENSIONS = ['.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf'];
const isRawFile = (file) => RAW_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));

async function processFiles(files) {
	const { setInputFilename } = useProcessingState();

	const videoFiles = files.filter(file => file.type.startsWith('video/') || file.name.endsWith('.ser') || file.name.endsWith('.avi'));
	const imageFiles = files.filter(file => file.type.startsWith('image/'));

	// Set the input filename for output file naming
	const primaryFile = videoFiles[0] || imageFiles[0];
	if (primaryFile) {
		setInputFilename(primaryFile.name);
		addLog(`File: ${primaryFile.name}`);
	}

	// Multiple SER files are allowed - they'll be combined for stacking
	// But mixing video types or mixing videos with images is not allowed
	const serFiles = videoFiles.filter(f => f.name.endsWith('.ser'));
	const nonSerVideos = videoFiles.filter(f => !f.name.endsWith('.ser'));

	if (serFiles.length > 0 && nonSerVideos.length > 0) {
		alert('Please select either SER files or other video files, not both.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if (nonSerVideos.length > 1) {
		alert('Please select only one video file (multiple SER files are supported).');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if (videoFiles.length >= 1 && imageFiles.length > 0) {
		alert('Please select either a video file or image files, not both.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	// Handle multiple SER files (combined stacking) - not available in lite mode
	if (serFiles.length > 1 && !liteMode.value) {
		emit('processing-started');
		const { readSerFiles } = useSerReader();
		addLog(`Processing ${serFiles.length} SER files for combined stacking`);
		await readSerFiles(serFiles, effectiveMaxFrames.value, effectiveQualityMode.value === 'manual', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveNoiseRobust.value, surfaceMode.value, useVngDemosaic.value);
		return;
	} else if (serFiles.length > 1 && liteMode.value) {
		alert('Multiple SER files are not supported in Lite Mode. Please select a single file.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if( videoFiles.length == 1 ){
		let fileToProcess = videoFiles[0];

		const MAX_SIZE = 1.9 * 1024 * 1024 * 1024;
		if (!fileToProcess.name.endsWith('.ser') && !fileToProcess.name.endsWith('.avi') && fileToProcess.size > MAX_SIZE) {
			if (confirm('The selected file is larger than 2GB. Do you want to trim it to 2GB? This might not work for all video formats.')) {
				const trimmedBlob = fileToProcess.slice(0, MAX_SIZE);
				fileToProcess = new File([trimmedBlob], fileToProcess.name, { type: fileToProcess.type });
				addLog('File trimmed to fit within the memory limit');
			}
		}

		// Handle SER files with direct reader (not in lite mode - lite mode uses FFmpeg)
		if (fileToProcess.name.endsWith('.ser') && !liteMode.value) {
			emit('processing-started');
			const { readSerFile } = useSerReader();
			await readSerFile(fileToProcess, effectiveMaxFrames.value, effectiveQualityMode.value === 'manual', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveNoiseRobust.value, surfaceMode.value, useVngDemosaic.value);
			return;
		}

		let needsFfmpeg = !fileToProcess.name.endsWith('.avi'); // Non-AVI always needs FFmpeg
		let expectedFrameCount = null; // From AVI header if available

		if (fileToProcess.name.endsWith('.avi') && !liteMode.value) {
			// First, just check the header (only 5MB) to see if we can process directly
			const { readAviFile, checkAviFormat } = useAviReader();

			addLog('Checking AVI format...');
			const headerProbeSize = Math.min(fileToProcess.size, 1024 * 1024 * 5);
			const headerSlice = fileToProcess.slice(0, headerProbeSize);
			const headerBuffer = await headerSlice.arrayBuffer();

			const formatInfo = await checkAviFormat(headerBuffer, fileToProcess.size);

			if (formatInfo.isSupported) {
				// Can process directly - readAviFile handles both uncompressed and MJPEG
				// Pass pre-parsed header to avoid parsing twice
				emit('processing-started');
				await readAviFile(fileToProcess, effectiveMaxFrames.value, effectiveQualityMode.value === 'manual', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveNoiseRobust.value, useGPU.value, null, surfaceMode.value, useVngDemosaic.value, formatInfo.aviHeader);
				return;
			} else {
				addLog(`AVI format '${formatInfo.fourCC}' needs FFmpeg processing.`);
				needsFfmpeg = true;
				expectedFrameCount = formatInfo.frameCount; // Use frame count from header
			}
		} else if (fileToProcess.name.endsWith('.avi') && liteMode.value) {
			// Lite mode: force FFmpeg for AVI files too
			addLog('Lite mode: using FFmpeg for AVI processing');
			needsFfmpeg = true;
		}

		if (!needsFfmpeg) return;

		eventBusEmit('set-caption', 'Loading FFmpeg...');
		try {
			await $loadFFmpeg();
		} catch (err) {
			reportError(err, { component: 'FileUploader', action: 'loadFFmpeg', logs: logs.value });
			eventBusEmit('upload-error', err.message || 'Failed to load FFmpeg. Please refresh and try again.');
			eventBusEmit('show-error');
			return;
		}

		eventBusEmit('set-caption', 'Importing frames from video');

		addLog('Storing video in memory');
		try {
			// Fetch file content first - Safari can throw InvalidStateError if file changed after selection
			let fileData;
			try {
				fileData = await fetchFile(fileToProcess);
			} catch (fetchErr) {
				// Safari-specific: InvalidStateError when file handle becomes invalid
				const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
				if (fetchErr.name === 'InvalidStateError' || fetchErr.code === 11) {
					console.error('File fetch error (possible file change):', fetchErr);
					const msg = isSafari
						? 'The file could not be read. Safari may have lost access to the file. Please re-select the file and try again.'
						: 'The file could not be read. It may have been modified or moved. Please re-select the file.';
					eventBusEmit('upload-error', msg);
					eventBusEmit('show-error');
					return;
				}
				throw fetchErr; // Re-throw other errors
			}
			$ffmpeg.FS('writeFile', fileToProcess.name, fileData);
		} catch(err) {
			console.error('FFmpeg writeFile error:', err);
			reportError(err, {
				component: 'FileUploader',
				action: 'ffmpegWriteFile',
				filename: fileToProcess.name,
				logs: logs.value,
				extra: { fileSize: fileToProcess.size }
			});
			addLog(`ffmpeg: Storing video in memory failed: ${err.message || err}`);
			eventBusEmit('upload-error', 'Failed to load video into memory. The file may be too large. Try using a SER file instead, or enable frame limiting.');
			eventBusEmit('show-error');
			return;
		}
		addLog('Storing video in memory done');

		// Only switch to processing view after we know the file loaded successfully
		emit('processing-started');

		// Run pre-crop detection if enabled
		let preCropRegion = null;
		if (enablePreCrop.value) {
			preCropRegion = await detectPreCropRegion(fileToProcess.name);
			addLog('Pre-crop detection complete, continuing with extraction...');
		}

		// Set up progress tracking for FFmpeg
		let lastFrameCount = 0;
		let lastLoggedFrame = 0;
		const totalFramesTarget = effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : expectedFrameCount;

		$ffmpeg.setLogger(({ type, message }) => {
			if (typeof message !== 'string') return;

			// Log ALL FFmpeg output for debugging
			console.log(`[ffmpeg ${type}] ${message}`);

			// Log important FFmpeg messages
			if (type === 'fferr') {
				if (message.includes('Stream') || message.includes('Duration') || message.includes('Output') || message.includes('Error') || message.includes('error') || message.includes('crop')) {
					addLog(`[ffmpeg] ${message}`);
				}
			}

			// Parse frame count from FFmpeg output: "frame=  304 fps= 36 ..."
			const frameMatch = message.match(/frame=\s*(\d+)/);
			if (frameMatch) {
				const currentFrame = parseInt(frameMatch[1], 10);
				if (currentFrame !== lastFrameCount) {
					lastFrameCount = currentFrame;
					// Log approximately every 500 frames (handles jumps in frame count)
					if (currentFrame - lastLoggedFrame >= 500) {
						addLog(`Extracting frame ${currentFrame}...`);
						lastLoggedFrame = currentFrame;
					}
					if (totalFramesTarget) {
						const progress = Math.min((currentFrame / totalFramesTarget) * 100, 100);
						eventBusEmit('update-loading', { progress, current: currentFrame, total: totalFramesTarget });
					} else {
						eventBusEmit('update-loading', { progress: -1, current: currentFrame, total: '?' });
					}
				}
			}
		});

		// Lite mode: check file size fits in FFmpeg WASM memory
		if (liteMode.value) {
			const fileSizeMB = fileToProcess.size / (1024 * 1024);
			const platform = detectPlatform();
			const sizeCheck = checkFileSize(fileSizeMB, platform);
			if (!sizeCheck.canProcess) {
				addLog(`File too large for Lite mode: ${Math.round(fileSizeMB)}MB`);
				eventBusEmit('upload-error', sizeCheck.reason);
				eventBusEmit('stop-loading');
				return;
			}
			addLog(`File size OK for Lite mode: ${Math.round(fileSizeMB)}MB (${platform})`);
		}

		// Lite mode: use memory-optimized batched extraction + analysis
		if (liteMode.value) {
			// Get video duration for batched processing
			let videoDuration = 0;
			$ffmpeg.setLogger(({ type, message }) => {
				if (typeof message !== 'string') return;
				const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
				if (durMatch) {
					videoDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
				}
			});
			try {
				await $ffmpeg.run('-i', fileToProcess.name, '-f', 'null', '-t', '0.001', '-');
			} catch (e) { /* FFmpeg exits with error for -f null */ }

			if (videoDuration <= 0) {
				addLog('Could not determine video duration, using fallback');
				videoDuration = 60; // Assume 1 minute
			}
			addLog(`Video duration: ${videoDuration.toFixed(1)}s`);

			const { processBatchedVideoFrames } = useAviReader();
			const totalFrames = effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : 100;

			await processBatchedVideoFrames($ffmpeg, fileToProcess.name, totalFrames, videoDuration, {
				preCropRegion,
				manualThreshold: effectiveQualityMode.value === 'manual',
				stackPercentage: effectiveStackPercentage.value,
				drizzleScale: effectiveDrizzleScale.value,
				noiseRobustAlignment: effectiveNoiseRobust.value,
				surfaceMode: surfaceMode.value
			});

		} else {
			// Normal mode: extract all frames first, then process
			eventBusEmit('set-caption', 'Extracting frames from video');
			eventBusEmit('update-loading', { progress: 0, current: 0, total: effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : '?' });

			try {
				const frameLimit = effectiveMaxFrames.value > 0 ? ['-vframes', '' + effectiveMaxFrames.value + ''] : [];

				// Build video filter chain
				const videoFilters = [];
				if (preCropRegion) {
					videoFilters.push(`crop=${preCropRegion.width}:${preCropRegion.height}:${preCropRegion.x}:${preCropRegion.y}`);
				}
				const vfArgs = videoFilters.length > 0 ? ['-vf', videoFilters.join(',')] : [];

				// Output PNG files
				const ffmpegArgs = ['-i', videoFiles[0].name, ...vfArgs, ...frameLimit, 'out%d.png'];
				addLog(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

				addLog('Starting FFmpeg extraction...');
				await $ffmpeg.run(...ffmpegArgs);
				addLog('FFmpeg extraction completed');
			} catch(err){
				console.log(err);
				addLog('FFmpeg forcefully exited, but continuing!');
			}

			// Clear the logger
			$ffmpeg.setLogger(({ message }) => {});

			// Get list of PNG files created by FFmpeg
			const pngFiles = $ffmpeg.FS('readdir', '/').filter(f => f.endsWith('.png')).sort((a, b) => {
				const numA = parseInt(a.match(/\d+/)?.[0] || '0');
				const numB = parseInt(b.match(/\d+/)?.[0] || '0');
				return numA - numB;
			});

			// Free source video memory
			$ffmpeg.FS('unlink', videoFiles[0].name);

			addLog(`Extracted ${pngFiles.length} PNG frames`);

			if (pngFiles.length === 0) {
				addLog('No frames extracted from video');
				eventBusEmit('upload-error', 'Failed to extract frames from video. The file may be corrupted or unsupported.');
				eventBusEmit('show-error');
				return;
			}

			// Route PNG frames through AVI reader - it will read and delete files from $ffmpeg
			const { processFFmpegFrames } = useAviReader();
			const skipAutoCrop = preCropRegion !== null;

			await processFFmpegFrames($ffmpeg, pngFiles, effectiveQualityMode.value === 'manual', effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveNoiseRobust.value, useGPU.value, surfaceMode.value);
		}
	
	} else if (imageFiles.length > 1) {
		// Multiple images selected - analyze and stack them
		const rawFile = imageFiles.find(isRawFile);
		if (rawFile) {
			eventBusEmit('upload-error', `RAW camera files (${rawFile.name.split('.').pop().toUpperCase()}) are not supported. For planetary imaging, please use SER or AVI format from your capture software.`);
			eventBusEmit('stop-loading');
			return;
		}

		emit('processing-started');
		addLog(`${imageFiles.length} images selected for stacking`);

		const { readImageFiles } = useImageReader();
		await readImageFiles(imageFiles, $ffmpeg, $loadFFmpeg, effectiveQualityMode.value === 'manual', effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveNoiseRobust.value, useGPU.value, surfaceMode.value);

	} else if (imageFiles.length == 1) {
		// Single image - go directly to post processing
		if (isRawFile(imageFiles[0])) {
			eventBusEmit('upload-error', `RAW camera files (${imageFiles[0].name.split('.').pop().toUpperCase()}) are not supported. For planetary imaging, please use SER or AVI format from your capture software.`);
			eventBusEmit('stop-loading');
			return;
		}

		const file = imageFiles[0];
		const fileName = file.name?.toLowerCase() || '';
		const isTiff = file.type === 'image/tiff' || fileName.endsWith('.tif') || fileName.endsWith('.tiff');
		const isNativeFormat = ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type);

		if (isTiff) {
			// Use lightweight TIFF decoder (no FFmpeg needed)
			addLog('One TIFF image selected, decoding...');
			const { decodeTIFF } = await import('@/utils/tiffDecoder.js');
			const buffer = await file.arrayBuffer();
			const decoded = await decodeTIFF(buffer);

			// Convert Float32 to PNG blob for post processor
			const pixelCount = decoded.width * decoded.height;
			const uint8Data = new Uint8ClampedArray(pixelCount * 4);
			const float32 = decoded.float32Data;

			for (let i = 0; i < pixelCount; i++) {
				uint8Data[i * 4] = Math.round(Math.min(1, Math.max(0, float32[i * 4])) * 255);
				uint8Data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, float32[i * 4 + 1])) * 255);
				uint8Data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, float32[i * 4 + 2])) * 255);
				uint8Data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, float32[i * 4 + 3])) * 255);
			}

			const imageData = new ImageData(uint8Data, decoded.width, decoded.height);
			const canvas = new OffscreenCanvas(decoded.width, decoded.height);
			const ctx = canvas.getContext('2d');
			ctx.putImageData(imageData, 0, 0);
			const blob = await canvas.convertToBlob({ type: 'image/png' });

			addLog('Load post processing');
			emit('postProcessing', blob);
		} else if (!isNativeFormat) {
			addLog('One image selected that is not natively supported by browsers, converting..');

			await $loadFFmpeg();

			let imageData;
			try {
				imageData = await fetchFile(file);
			} catch (fetchErr) {
				if (fetchErr.name === 'InvalidStateError' || fetchErr.code === 11) {
					eventBusEmit('upload-error', 'The file could not be read. Please re-select the file and try again.');
					eventBusEmit('show-error');
					return;
				}
				throw fetchErr;
			}
			$ffmpeg.FS('writeFile', file.name, imageData);

			await $ffmpeg.run('-i', file.name, file.name + '.png');

			const data = $ffmpeg.FS('readFile', file.name + '.png');

			const blob = new Blob([data.buffer], { type: 'image/png' });

			$ffmpeg.FS('unlink', file.name);
			$ffmpeg.FS('unlink', file.name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob);
		} else {
			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', file);
		}
	}
}
</script>

<style>
.status-indicators {
	display: flex;
	gap: 12px;
	margin-bottom: 15px;
	flex-wrap: wrap;
	font-size: 11px;
}
.status-item {
	display: flex;
	align-items: center;
	gap: 3px;
	color: #999;
}
.status-item .status-check {
	font-size: 10px;
}
.status-item.active {
	color: #333;
}
.status-item.active .status-check {
	color: #8CCF7E;
}
.error-message {
	background-color: #ffcccc;
	color: #D9534F;
	padding: 10px;
	margin-top: 10px;
	border-radius: 5px;
	font-weight: bold;
}
.file-input-wrapper {
	position: relative;
	margin-bottom: 10px;
}

.file-input-wrapper input[type="file"] {
	position: absolute;
	opacity: 0;
	width: 100%;
	height: 100%;
	cursor: pointer;
}

.file-label {
	display: block;
	padding: 10px 15px;
	background: #f5f5f5;
	border: 2px dashed #ccc;
	border-radius: 5px;
	text-align: center;
	cursor: pointer;
	transition: all 0.2s;
	color: #666;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.file-label:hover {
	border-color: #8CCF7E;
	background: #f0fff0;
}

.supported-formats {
	font-size: 12px;
	color: #888;
	margin: 0 0 15px 0;
}

.lite-mode-warning {
	background: #fff3cd;
	border: 1px solid #ffc107;
	color: #856404;
	padding: 10px 12px;
	border-radius: 5px;
	font-size: 12px;
	line-height: 1.4;
	margin-bottom: 15px;
}

.selected-files {
	margin-top: 15px;
	padding: 10px;
	background-color: #f0f8ff;
	border-radius: 5px;
}
.action-buttons {
	display: flex;
	gap: 10px;
	margin-top: 10px;
}
.start-button {
	background-color: #8CCF7E;
	color: #111;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}
.start-button:hover {
	background-color: #7ABF6E;
}
.clear-button {
	background-color: #888;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
}
.clear-button:hover {
	background-color: #666;
}
.cancel-button {
	background-color: #D9534F;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}
.cancel-button:hover {
	background-color: #C9302C;
}
.processing-actions {
	justify-content: center;
	margin-top: 20px;
}
.info-icon {
	cursor: pointer;
	color: #666;
	font-size: 0.9em;
	user-select: none;
}
.info-icon:hover {
	color: #333;
}
.info-text {
	font-size: 0.9em;
	color: #555;
	margin-top: 5px;
	padding: 8px;
	background: #f5f5f5;
	border-radius: 4px;
}
.info-text ul {
	margin: 0;
	padding-left: 20px;
}
.radio-group {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 10px 0;
}
.radio-option {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
}
.radio-option input[type="radio"] {
	margin: 0;
}
.checkbox-option {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	margin: 10px 0;
}
.checkbox-option.disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.checkbox-option input[type="checkbox"] {
	margin: 0;
}
.percentage-input {
	width: 50px;
	padding: 4px 6px;
	border: 1px solid #ccc;
	border-radius: 4px;
	text-align: center;
}
.percentage-input:disabled {
	background: #eee;
	color: #999;
}
.small-number-input {
	width: 55px;
	padding: 3px 5px;
	border: 1px solid #ccc;
	border-radius: 4px;
	text-align: center;
}
.memory-optimization-box {
	background: #fff8e1;
	border: 1px solid #ffcc80;
	border-radius: 5px;
	padding: 10px;
	margin: 10px 0;
}
.memory-optimization-box .checkbox-option {
	margin: 5px 0;
}
.optimization-hint {
	margin: 0 0 8px 0;
	font-size: 0.9em;
	color: #e65100;
	font-weight: 500;
}
.auto-badge {
	font-size: 0.7em;
	background: #4caf50;
	color: white;
	padding: 2px 5px;
	border-radius: 3px;
	margin-left: 5px;
	vertical-align: middle;
}
.inline-number {
	width: 60px;
	padding: 4px 6px;
	border: 1px solid #ccc;
	border-radius: 4px;
	text-align: center;
	margin: 0 4px;
}
.inline-number:disabled {
	background: #eee;
	color: #999;
}
.build-date {
	font-size: 0.85em;
	color: #888;
	margin-top: 20px;
}
</style>
