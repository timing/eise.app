<template>
<div>
	<div class="card">
		<!-- LoadingIndicator always mounted so it can receive events -->
		<LoadingIndicator />

		<!-- Cancel button during processing -->
		<div v-if="isProcessing" class="action-buttons processing-actions">
			<button class="cancel-button" @click="cancelProcessing">Cancel</button>
		</div>

		<!-- WebGPU warning -->
		<div v-if="!webGPUSupported" class="webgpu-warning">
			<strong>WebGPU not available</strong>
			<p>Your browser doesn't support WebGPU. Processing will be slower. For best performance, use Chrome, Edge, or Safari 18+.</p>
		</div>

		<!-- Initial state: file selection and settings (hidden during processing) -->
		<template v-if="!isProcessing">
			<label for="file-upload">
				<h3>Select file(s)</h3>
				<input id="file-upload" ref="fileInput" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
			</label>

			<div v-if="selectedFiles.length > 0" class="selected-files">
				<p><strong>Selected:</strong> {{ selectedFilesDescription }}</p>

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

			<h4>Frame selection</h4>
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
			<p v-if="qualityMode === 'manual'" class="info-text">After analysis, you'll see a quality graph and can choose which frames to stack.</p>
			<p v-if="qualityMode === 'percentage'" class="info-text">Stack best is recommended if you run into memory issues.</p>

			<div class="separator"></div>

			<h4>Stacking mode</h4>
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
			<p class="info-text">Drizzle uses sub-pixel offsets to increase resolution. Best with 100+ frames.</p>

			<label class="checkbox-option">
				<input type="checkbox" v-model="noiseRobustAlignment" />
				Pre-blur alignment
			</label>
			<p class="info-text">Aligns on blurred frames first, then refines. Better for turbulent seeing, slower.</p>

			<div class="separator"></div>

			<h4>Crop margin <span class="info-icon" @click="showCropMarginInfo = !showCropMarginInfo">ⓘ</span></h4>
			<input type="range" min="5" max="50" step="5" v-model="cropMarginPercent" />
			{{ cropMarginPercent }}%
			<p v-if="showCropMarginInfo" class="info-text">Extra space around detected object. Increase for Saturn's rings, decrease for tighter crops.</p>

			<div class="separator"></div>

			<template v-if="!showMemoryOptimization">
				<h4>Max frames <span class="info-icon" @click="showMaxFramesInfo = !showMaxFramesInfo">ⓘ</span></h4>
				<label>
					<input type="checkbox" v-model="enableMaxFrames" />
					Limit frames
				</label>
				<input type="range" min="2" max="5000" step="1" v-model="selectedMaxFrames" :disabled="!enableMaxFrames" />
				{{ enableMaxFrames ? selectedMaxFrames : '∞' }}
				<p v-if="showMaxFramesInfo" class="info-text">Lower this if you experience memory issues.</p>
			</template>
		</template>
	</div>

	<!-- Welcome content: only show when not processing -->
	<div class="content" v-if="!isProcessing">
		<h2>Welcome to eise.app</h2>
		<h3>An easy planetary image stacker for astrophotography</h3>
		<p>Turn your blurry and shaky videos of planets into one stacked and sharp image using <em>lucky imaging</em>.</p>
		<ul>
			<li>Select one or more SER files for stacking followed by post processing. (Multiple SER files will be combined)</li>
			<li>Select one video file (AVI, MP4, etc.) for stacking followed by post processing.</li>
			<li>Select multiple image files (TIFF, PNG, JPG, etc.) for stacking and post processing.</li>
			<li>Select one image file for post processing only.</li>
		</ul>
		<p>When stacking, eise.app analyzes all frames by sharpness, then you select which ones to include using a quality graph or percentage threshold.</p>
		<h3>More information, bugs and feature requests?</h3>
		<p>Read more about Eise.app on the <a href="#" @click.prevent="showAbout">About page</a>, or head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on Github</a>.</p>
		<p>Have feedback or running into issues? <a href="#" @click.prevent="openFeedback()">Let me know!</a></p>
	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { computed, defineEmits, ref, onMounted, watch } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useSerReader } from '@/composables/useSerReader';
import { useAviReader } from '@/composables/useAviReader';
import { useImageReader } from '@/composables/useImageReader';
import { useProcessingState } from '@/composables/useProcessingState';
import { reportError } from '@/composables/useSentryReporting';
import { useFeedback } from '@/composables/useFeedback';
import { useTracking } from '@/composables/useTracking';

const { track } = useTracking();

const { openFeedback } = useFeedback();
const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const enableMaxFrames = ref(false);
const selectedMaxFrames = ref(100);

// Always enable auto-crop and client-side stacking
const enableAutoCrop = true;
const enableClientSideStacking = true;

const errorMessage = ref(null);

// Info toggle state
const showMaxFramesInfo = ref(false);
const showCropMarginInfo = ref(false);
const showPreCropInfo = ref(false);

// Crop margin setting (percentage of detected object size to add as margin)
const cropMarginPercent = ref(10);

// Quality threshold mode: 'manual' for interactive selection, 'percentage' for automatic
const qualityMode = ref('manual');
const stackPercentage = ref(30);
const drizzleMode = ref('1.5x'); // '1x' or '1.5x'
const noiseRobustAlignment = ref(false);

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
			selectedMaxFrames: selectedMaxFrames.value
		};
		localStorage.setItem('eise-settings', JSON.stringify(settings));
	} catch (e) {
		console.warn('Failed to save settings:', e);
	}
}

// Watch all settings and save on change
watch([qualityMode, stackPercentage, drizzleMode, noiseRobustAlignment, cropMarginPercent, enableMaxFrames, selectedMaxFrames], saveSettings);

onMounted(async () => {
	loadSettings();

	// Check WebGPU support
	if (!navigator.gpu) {
		webGPUSupported.value = false;
	} else {
		try {
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter) {
				webGPUSupported.value = false;
			}
		} catch (e) {
			webGPUSupported.value = false;
		}
	}
});

const selectedFiles = ref([]);
const isProcessing = ref(false);
const fileInput = ref(null);
const webGPUSupported = ref(true); // Assume supported until checked

const emit = defineEmits(['frames', 'postProcessing', 'processing-started', 'showAbout']);

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

// Show memory optimization box when appropriate
const showMemoryOptimization = computed(() => {
	if (!showPreCropOption.value) return false;
	// Show if on mobile, or if file is large (>500MB), or if already enabled
	const file = selectedFiles.value[0];
	return isMobileDevice.value || file?.size > 500 * 1024 * 1024 || enablePreCrop.value || enableMaxFrames.value;
});

// Auto-enable pre-crop for mobile devices with video files
watch([selectedFiles, isMobileDevice], () => {
	if (showPreCropOption.value && isMobileDevice.value) {
		enablePreCrop.value = true;
		preCropAutoEnabled.value = true;
	} else {
		preCropAutoEnabled.value = false;
	}
}, { immediate: true });

const { addLog, emit: eventBusEmit, on, logs } = useEventBus();

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

	// Sample 10 frames spread across the video
	const sampleCount = 10;
	const allBounds = [];

	for (let i = 1; i <= sampleCount; i++) {
		const timestamp = (duration * i / (sampleCount + 1)).toFixed(2);
		const sampleFile = `sample_${i}.png`;

		eventBusEmit('update-loading', { progress: (i / sampleCount) * 50, current: i, total: sampleCount });

		try {
			await $ffmpeg.run('-ss', timestamp, '-i', filename, '-vframes', '1', '-f', 'image2', sampleFile);

			// Read the sample frame
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
				addLog(`Sample ${i}: planet at (${bounds.x}, ${bounds.y}) size ${bounds.width}x${bounds.height}`);
			}
		} catch (e) {
			addLog(`Sample ${i} failed: ${e.message}`);
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

function showAbout() {
	emit('showAbout');
}

async function processFiles(files) {
	const { setInputFilename } = useProcessingState();

	const videoFiles = files.filter(file => file.type.startsWith('video/') || file.name.endsWith('.ser') || file.name.endsWith('.avi'));
	const imageFiles = files.filter(file => file.type.startsWith('image/'));

	// Set the input filename for output file naming
	const primaryFile = videoFiles[0] || imageFiles[0];
	if (primaryFile) {
		setInputFilename(primaryFile.name);
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

	// Handle multiple SER files (combined stacking)
	if (serFiles.length > 1) {
		emit('processing-started');
		const { readSerFiles } = useSerReader();
		const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
		addLog(`Processing ${serFiles.length} SER files for combined stacking`);
		const drizzleScale = drizzleMode.value === '1.5x' ? 1.5 : 1.0;
		await readSerFiles(serFiles, maxFramesValue, enableAutoCrop, enableClientSideStacking, qualityMode.value === 'manual', cropMarginPercent.value, stackPercentage.value, drizzleScale, noiseRobustAlignment.value, true);
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

		// Handle SER files with direct reader
		if (fileToProcess.name.endsWith('.ser')) {
			emit('processing-started');
			const { readSerFile } = useSerReader();
			const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
			const drizzleScale = drizzleMode.value === '1.5x' ? 1.5 : 1.0;
			await readSerFile(fileToProcess, maxFramesValue, enableAutoCrop, enableClientSideStacking, qualityMode.value === 'manual', cropMarginPercent.value, stackPercentage.value, drizzleScale, noiseRobustAlignment.value);
			return;
		}

		let needsFfmpeg = !fileToProcess.name.endsWith('.avi'); // Non-AVI always needs FFmpeg
		let expectedFrameCount = null; // From AVI header if available

		if (fileToProcess.name.endsWith('.avi')) {
			// First, just check the header (only 5MB) to see if we can process directly
			const { readAviFile, checkAviFormat } = useAviReader();

			addLog('Checking AVI format...');
			const headerProbeSize = Math.min(fileToProcess.size, 1024 * 1024 * 5);
			const headerSlice = fileToProcess.slice(0, headerProbeSize);
			const headerBuffer = await headerSlice.arrayBuffer();

			const formatInfo = await checkAviFormat(headerBuffer);

			if (formatInfo.isSupported) {
				// Can process directly - readAviFile handles both uncompressed and MJPEG
				emit('processing-started');
				const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
				const drizzleScale = drizzleMode.value === '1.5x' ? 1.5 : 1.0;
				await readAviFile(fileToProcess, maxFramesValue, enableAutoCrop, enableClientSideStacking, qualityMode.value === 'manual', cropMarginPercent.value, stackPercentage.value, drizzleScale, noiseRobustAlignment.value, true);
				return;
			} else {
				addLog(`AVI format '${formatInfo.fourCC}' needs FFmpeg processing.`);
				needsFfmpeg = true;
				expectedFrameCount = formatInfo.frameCount; // Use frame count from header
			}
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
			$ffmpeg.FS('writeFile', fileToProcess.name, await fetchFile(fileToProcess));
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

			// Exit and reload FFmpeg to clear WASM memory after pre-crop sampling
			// Pre-crop runs FFmpeg 11 times which accumulates internal state
			addLog('Reloading FFmpeg to free memory after pre-crop...');
			try {
				$ffmpeg.exit();
			} catch (e) {
				// exit() may throw if not fully initialized, that's ok
			}
			await $loadFFmpeg();
			// Re-write the input file to the fresh FFmpeg instance
			$ffmpeg.FS('writeFile', fileToProcess.name, await fetchFile(fileToProcess));
			addLog('FFmpeg reloaded');
		}

		// Set up progress tracking for FFmpeg
		let lastFrameCount = 0;
		let lastLoggedFrame = 0;
		const totalFramesTarget = enableMaxFrames.value ? selectedMaxFrames.value : expectedFrameCount;

		$ffmpeg.setLogger(({ type, message }) => {
			if (typeof message !== 'string') return;

			// Log important FFmpeg messages
			if (type === 'fferr') {
				if (message.includes('Stream') || message.includes('Duration') || message.includes('Output') || message.includes('Error') || message.includes('error')) {
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

		eventBusEmit('set-caption', 'Extracting frames from video');

		try {
			const frameLimit = enableMaxFrames.value ? ['-vframes', '' + selectedMaxFrames.value + ''] : [];

			// Build video filter chain
			const videoFilters = [];
			if (preCropRegion) {
				videoFilters.push(`crop=${preCropRegion.width}:${preCropRegion.height}:${preCropRegion.x}:${preCropRegion.y}`);
			}
			const vfArgs = videoFilters.length > 0 ? ['-vf', videoFilters.join(',')] : [];

			// Output PNG files
			const ffmpegArgs = ['-i', videoFiles[0].name, ...vfArgs, ...frameLimit, 'out%d.png'];
			addLog(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

			await $ffmpeg.run(...ffmpegArgs);
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
		const drizzleScale = drizzleMode.value === '1.5x' ? 1.5 : 1.0;
		const skipAutoCrop = preCropRegion !== null;

		await processFFmpegFrames($ffmpeg, pngFiles, enableAutoCrop && !skipAutoCrop, enableClientSideStacking, qualityMode.value === 'manual', stackPercentage.value, drizzleScale, noiseRobustAlignment.value, true);
	
	} else if (imageFiles.length > 1) {
		// Multiple images selected - analyze and stack them
		emit('processing-started');
		addLog(`${imageFiles.length} images selected for stacking`);

		const { readImageFiles } = useImageReader();
		const drizzleScale = drizzleMode.value === '1.5x' ? 1.5 : 1.0;
		await readImageFiles(imageFiles, $ffmpeg, $loadFFmpeg, qualityMode.value === 'manual', false, stackPercentage.value, drizzleScale, noiseRobustAlignment.value, true);

	} else if (imageFiles.length == 1) {
		// Single image - go directly to post processing
		if (['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].indexOf(imageFiles[0].type) == -1) {

			addLog('One image selected that is not natively supported by browsers, converting..');

			await $loadFFmpeg();

			$ffmpeg.FS('writeFile', imageFiles[0].name, await fetchFile(imageFiles[0]));

			await $ffmpeg.run('-i', imageFiles[0].name, imageFiles[0].name + '.png');

			const data = $ffmpeg.FS('readFile', imageFiles[0].name + '.png');

			const blob = new Blob([data.buffer], { type: 'image/png' });

			$ffmpeg.FS('unlink', imageFiles[0].name);
			$ffmpeg.FS('unlink', imageFiles[0].name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob);
		} else {

			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', imageFiles[0]);
		}
	}
}
</script>

<style>
.error-message {
	background-color: #ffcccc;
	color: #D9534F;
	padding: 10px;
	margin-top: 10px;
	border-radius: 5px;
	font-weight: bold;
}
.webgpu-warning {
	background-color: #fff3cd;
	color: #856404;
	padding: 10px;
	margin-bottom: 10px;
	border-radius: 5px;
	border: 1px solid #ffc107;
}
.webgpu-warning p {
	margin: 5px 0 0 0;
	font-size: 0.9em;
}
.file-upload-wrapper {
	display: block;
	color: #003366;
	border: 3px dashed #003366;
	border-radius: 10px;
	margin: 20px auto;
	padding: 20px 40px;
	cursor: pointer;
}
.file-upload-wrapper ul {
	padding-left: 0;
}
.file-upload-wrapper:hover {
	background: #ffeeff;
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
</style>
