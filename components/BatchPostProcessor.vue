<template>
<div class="batch-post-processor">
	<!-- Navigation header -->
	<div class="batch-nav-header">
		<div class="nav-controls">
			<button class="nav-btn" @click="prevImage" :disabled="currentIndex <= 0 || isNavigating">&larr;</button>
			<span class="nav-title">
				{{ currentResult?.name || 'Image' }}
				<span class="nav-index">({{ currentIndex + 1 }}/{{ results.length }})</span>
				<span v-if="isNavigating" class="nav-saving">saving...</span>
                
                <!-- Continuous stacking sharpness info -->
                <div v-if="isContinuousMode && currentResult" class="sharpness-info">
                    S: <span class="score">{{ formatScore(currentResult.sharpness) }}</span> 
                    (T: <span class="score">{{ formatScore(currentResult.tenengrad) }}</span>, 
                    L: <span class="score">{{ formatScore(currentResult.laplacian) }}</span>)
                </div>
			</span>
			<button class="nav-btn" @click="nextImage" :disabled="currentIndex >= results.length - 1 || isNavigating">&rarr;</button>
		</div>
		<div class="header-actions">
			<button v-if="!isContinuousMode" class="btn-secondary btn-small" @click="alignAllStacks" :disabled="isAligning || results.length < 2">
				{{ isAligning ? 'Aligning...' : 'Align Stacks' }}
			</button>
			<div class="export-dropdown" ref="exportDropdownRef">
				<button class="btn-primary btn-small" @click="toggleExportMenu" :disabled="isExporting || isProcessingAll || isEncodingVideo">
					{{ isProcessingAll ? processingAllProgress : (isExporting ? 'Exporting...' : (isEncodingVideo ? videoProgress : 'Export All')) }} <span class="dropdown-arrow">▾</span>
				</button>
				<div class="dropdown-menu" v-if="showExportMenu">
					<button @click="exportAll('processed')" :disabled="isProcessingAll || isExporting">
						Export all processed (PNG)
					</button>
					<button @click="exportAll('unprocessed')" :disabled="isExporting">
						Export all unprocessed (PNG)
					</button>
					<button
						v-if="videoEncodingSupported && !isContinuousMode"
						@click="exportVideo"
						:disabled="isEncodingVideo || isProcessingAll || results.length < 2"
					>
						Export video (MP4)
					</button>
					<hr />
					<button @click="selectExportDirectory">
						{{ exportDirHandle ? '✓ ' : '' }}Select export folder...
					</button>
					<div v-if="exportDirName" class="export-dir-name">{{ exportDirName }}</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Main post processor wrapper (grows to fill space) -->
	<div class="post-processor-wrapper">
		<!-- Main post processor (no :key so settings persist across navigation) -->
		<PostProcessor
			ref="postProcessorRef"
			v-if="currentResult"
			:file="currentBlob"
			:float32Data="currentFloat32Data"
			:imageDimensions="currentDimensions"
			@processed="onProcessed"
		/>
	</div>
</div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import PostProcessor from '@/components/PostProcessor.vue';
import { alignStackedImages, float32ToBlob } from '@/utils/stackAlignment.js';
import { useProcessingState } from '@/composables/useProcessingState.js';
import { isVideoEncodingSupported, encodeFramesToMP4, downloadBlob as downloadVideoBlob } from '@/utils/videoEncoder.js';

const props = defineProps({
	results: {
		type: Array,
		required: true,
		default: () => []
	}
});

const emit = defineEmits(['close']);

// Get setInputFilename to update export filename when navigating
const { setInputFilename, getBatchStartIndex, setBatchStartIndex } = useProcessingState();

// State
const currentIndex = ref(0);

onMounted(() => {
    // Set initial index if provided via state
    const startIndex = getBatchStartIndex();
    if (startIndex >= 0 && startIndex < props.results.length) {
        currentIndex.value = startIndex;
        // Reset it so it doesn't affect future sessions
        setBatchStartIndex(0);
    }
});

// Check if we are in continuous stacking mode (filenames like "5% Stack")
const isContinuousMode = computed(() => {
    return props.results.some(r => r.name && r.name.includes('% Stack'));
});

function formatScore(val) {
    if (val === undefined || val === null) return 'N/A';
    return typeof val === 'number' ? val.toFixed(4) : val;
}

const isExporting = ref(false);
const isAligning = ref(false);
const isEncodingVideo = ref(false);
const videoProgress = ref('');
const videoEncodingSupported = ref(false);
const alignedResults = ref(null); // Store aligned versions
const processedResults = ref({}); // Store post-processed versions keyed by result id
const showExportMenu = ref(false);
const exportDropdownRef = ref(null);
const exportDirHandle = ref(null); // File System Access API directory handle
const exportDirName = ref(null);
const postProcessorRef = ref(null);

// Current result (use aligned if available)
const currentResult = computed(() => {
	if (props.results.length === 0 || currentIndex.value < 0) return null;
	const original = props.results[currentIndex.value];

	// If we have aligned results, merge the aligned data
	if (alignedResults.value && alignedResults.value[currentIndex.value]) {
		return {
			...original,
			result: {
				...original.result,
				...alignedResults.value[currentIndex.value]
			}
		};
	}
	return original;
});

// Current blob for PostProcessor
const currentBlob = computed(() => {
	return currentResult.value?.result?.blob || null;
});

// Current float32 data for PostProcessor
const currentFloat32Data = computed(() => {
	return currentResult.value?.result?.float32Data || null;
});

// Current dimensions
const currentDimensions = computed(() => {
	const result = currentResult.value?.result;
	if (!result) return { width: 0, height: 0 };
	return { width: result.width, height: result.height };
});

// Save current processed data to processedResults (waits for processing to complete)
async function saveCurrentProcessedData() {
	// Wait for any in-progress processing to complete
	if (postProcessorRef.value?.waitForProcessing) {
		await postProcessorRef.value.waitForProcessing();
	}

	const result = props.results[currentIndex.value];
	if (result?.id && postProcessorRef.value?.getProcessedData) {
		const processed = postProcessorRef.value.getProcessedData();
		if (processed?.float32Data) {
			processedResults.value[result.id] = processed;
			console.log(`[Batch] Saved processed data for ${result.name}`);
		}
	}
}

// Navigation state to prevent double-clicks during async save
const isNavigating = ref(false);

// Navigation
async function prevImage() {
	if (currentIndex.value > 0 && !isNavigating.value) {
		isNavigating.value = true;
		await saveCurrentProcessedData();
		currentIndex.value--;
		isNavigating.value = false;
	}
}

async function nextImage() {
	if (currentIndex.value < props.results.length - 1 && !isNavigating.value) {
		isNavigating.value = true;
		await saveCurrentProcessedData();
		currentIndex.value++;
		isNavigating.value = false;
	}
}

// Handle processed data from PostProcessor
function onProcessed(data) {
	const result = props.results[currentIndex.value];
	if (result?.id) {
		processedResults.value[result.id] = data;
		console.log(`[Batch] Stored processed result for ${result.name}`);
	}
}

// Process all images by visiting each one and waiting for processing
const isProcessingAll = ref(false);
const processingAllProgress = ref('');

async function processAllImages(onProgress = null) {
	if (props.results.length === 0) return;

	const originalIndex = currentIndex.value;
	isProcessingAll.value = true;

	try {
		for (let i = 0; i < props.results.length; i++) {
			const result = props.results[i];

			// Skip if already processed
			if (processedResults.value[result.id]?.float32Data) {
				console.log(`[Batch] Skipping ${result.name} (already processed)`);
				continue;
			}

			const msg = `Processing ${i + 1}/${props.results.length}: ${result.name}`;
			processingAllProgress.value = msg;
			if (onProgress) onProgress(i + 1, props.results.length, msg);
			console.log(`[Batch] ${msg}`);

			// Navigate to this image
			currentIndex.value = i;

			// Wait for Vue to update the PostProcessor with new props
			await nextTick();

			// Wait a small moment for PostProcessor to start processing
			await new Promise(r => setTimeout(r, 100));

			// Wait for processing to complete
			if (postProcessorRef.value?.waitForProcessing) {
				await postProcessorRef.value.waitForProcessing();
			}

			// Save the processed data
			await saveCurrentProcessedData();
		}

		// Restore original index
		currentIndex.value = originalIndex;
		await nextTick();

		console.log(`[Batch] All ${props.results.length} images processed`);
	} finally {
		isProcessingAll.value = false;
		processingAllProgress.value = '';
	}
}

// Toggle export dropdown menu
function toggleExportMenu() {
	showExportMenu.value = !showExportMenu.value;
}

// Close dropdown when clicking outside
function handleClickOutside(e) {
	if (exportDropdownRef.value && !exportDropdownRef.value.contains(e.target)) {
		showExportMenu.value = false;
	}
}

// Select export directory using File System Access API
async function selectExportDirectory() {
	try {
		const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
		exportDirHandle.value = handle;
		exportDirName.value = handle.name;
		showExportMenu.value = false;
		console.log('[Export] Selected directory:', handle.name);
	} catch (err) {
		if (err.name === 'AbortError') {
			return;
		}
		console.warn('[Export] Directory picker failed:', err.message);
		alert('Directory selection failed. Exports will download normally instead.');
	}
}

// Export all images (processed or unprocessed)
async function exportAll(type) {
	showExportMenu.value = false;

	// Process all images first when exporting processed
	if (type === 'processed') {
		await processAllImages();
	}

	// Try to select export folder if not already selected
	if (!exportDirHandle.value) {
		try {
			const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
			exportDirHandle.value = handle;
			exportDirName.value = handle.name;
			console.log('[Export] Selected directory:', handle.name);
		} catch (err) {
			// User cancelled or API not available - continue with downloads
			if (err.name !== 'AbortError') {
				console.log('[Export] Directory picker not available, using downloads');
			}
		}
	}

	isExporting.value = true;

	try {
		for (let i = 0; i < props.results.length; i++) {
			const result = props.results[i];
			let blob;
			let suffix = '';

			if (type === 'processed') {
				let processed;

				// For current image, get directly from PostProcessor
				if (i === currentIndex.value && postProcessorRef.value?.getProcessedData) {
					processed = postProcessorRef.value.getProcessedData();
				} else {
					processed = processedResults.value[result.id];
				}

				if (processed?.float32Data) {
					blob = await float32ToBlob(processed.float32Data, processed.width, processed.height);
					suffix = '_processed';
				} else {
					console.warn(`[Export] No processed data for ${result.name} - using original. Visit image to process it.`);
					if (alignedResults.value?.[i]?.blob) {
						blob = alignedResults.value[i].blob;
						suffix = '_aligned';
					} else {
						blob = result.result?.blob;
					}
				}
			} else {
				// Unprocessed: use the original stacked blob (not aligned)
				blob = result.result?.blob;
			}

			if (!blob) continue;

			const baseName = result.name.replace(/\.[^/.]+$/, '');
			const index = String(i + 1).padStart(3, '0');
			const filename = `${baseName}_eise_stacked${suffix}_${index}.png`;

			if (exportDirHandle.value) {
				// Write directly to selected directory
				await writeToDirectory(exportDirHandle.value, filename, blob);
			} else {
				// Fallback to download
				await downloadBlob(blob, filename);
			}
		}
		console.log(`[Export] Completed exporting ${props.results.length} images`);
	} catch (err) {
		console.error('[Export] Failed:', err);
		// If directory access was revoked, clear the handle
		if (err.name === 'NotAllowedError') {
			exportDirHandle.value = null;
			exportDirName.value = null;
		}
	} finally {
		isExporting.value = false;
	}
}

// Write blob to directory using File System Access API
async function writeToDirectory(dirHandle, filename, blob) {
	const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
	const writable = await fileHandle.createWritable();
	await writable.write(blob);
	await writable.close();
}

// Download blob as file (fallback)
async function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	// Small delay between downloads
	await new Promise(resolve => setTimeout(resolve, 300));
}

// Export video (MP4) from all processed frames
async function exportVideo() {
	showExportMenu.value = false;

	if (props.results.length < 2) {
		console.warn('[Video] Need at least 2 frames for video');
		return;
	}

	isEncodingVideo.value = true;
	videoProgress.value = 'Processing all images...';

	try {
		// Process all images first to ensure we have processed data
		await processAllImages((current, total, msg) => {
			videoProgress.value = msg;
		});

		// Collect all frames (prefer processed, fall back to aligned, then original)
		const frames = [];
		for (let i = 0; i < props.results.length; i++) {
			const result = props.results[i];
			let frameData = null;

			// Try processed data first
			const processed = processedResults.value[result.id];
			if (processed?.float32Data) {
				frameData = processed;
			}
			// Try aligned data
			else if (alignedResults.value?.[i]?.float32Data) {
				frameData = alignedResults.value[i];
			}
			// Fall back to original
			else if (result.result?.float32Data) {
				frameData = result.result;
			}

			if (frameData?.float32Data) {
				frames.push({
					float32Data: frameData.float32Data,
					width: frameData.width,
					height: frameData.height
				});
			}
		}

		if (frames.length < 2) {
			console.warn('[Video] Not enough frames with data');
			alert('Not enough frames with image data. Please ensure images are loaded.');
			return;
		}

		console.log(`[Video] Encoding ${frames.length} frames to MP4...`);

		// Encode to MP4
		const videoBlob = await encodeFramesToMP4(frames, {
			fps: 12,
			pingPong: true,
			holdFirstFrame: 6,
			holdLastFrame: 6,
			onProgress: (current, total, message) => {
				videoProgress.value = message;
			}
		});

		// Generate filename from first result
		const baseName = props.results[0]?.name?.replace(/\.[^/.]+$/, '') || 'eise_video';
		const filename = `${baseName}_eise_animation.mp4`;

		// Download the video
		downloadVideoBlob(videoBlob, filename);

		console.log(`[Video] Export complete: ${filename} (${(videoBlob.size / 1024 / 1024).toFixed(1)} MB)`);
	} catch (err) {
		console.error('[Video] Export failed:', err);
		alert(`Video export failed: ${err.message}`);
	} finally {
		isEncodingVideo.value = false;
		videoProgress.value = '';
	}
}

// Align all stacks for wobble-free animation
async function alignAllStacks() {
	if (props.results.length < 2) return;

	isAligning.value = true;

	try {
		// Collect results with float32Data (include blob for export)
		const stackedResults = props.results
			.filter(r => r.result?.float32Data)
			.map(r => ({
				float32Data: r.result.float32Data,
				width: r.result.width,
				height: r.result.height,
				blob: r.result.blob
			}));

		if (stackedResults.length < 2) {
			console.warn('[Alignment] Not enough images with float32Data');
			return;
		}

		console.log(`[Alignment] Aligning ${stackedResults.length} stacks...`);

		// Run alignment
		const aligned = await alignStackedImages(stackedResults, {
			onProgress: (current, total, message) => {
				console.log(`[Alignment] ${message}`);
			}
		});

		// Store aligned results
		alignedResults.value = aligned;

		console.log('[Alignment] Complete!');
	} catch (err) {
		console.error('[Alignment] Failed:', err);
	} finally {
		isAligning.value = false;
	}
}

// Keyboard navigation
function handleKeydown(e) {
	if (e.key === 'ArrowLeft') {
		prevImage();
	} else if (e.key === 'ArrowRight') {
		nextImage();
	}
}

onMounted(async () => {
	window.addEventListener('keydown', handleKeydown);
	document.addEventListener('click', handleClickOutside);
	// Check if video encoding is supported
	videoEncodingSupported.value = await isVideoEncodingSupported();
});

onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
	document.removeEventListener('click', handleClickOutside);
});

// Update export filename when navigating between images
watch(currentResult, (result) => {
	if (result?.name) {
		// Remove extension for cleaner export filename
		const baseName = result.name.replace(/\.[^/.]+$/, '');
		setInputFilename(baseName);
	}
}, { immediate: true });
</script>

<style scoped>
.batch-post-processor {
	display: flex;
	flex-direction: column;
	min-height: 100vh;
	width: 100%;
}

.batch-nav-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 15px;
	background: #1a1a2e;
	border-bottom: 1px solid #333;
	flex-shrink: 0;
}

.nav-controls {
	display: flex;
	align-items: center;
	gap: 15px;
	flex: 1;
	justify-content: center;
}

.btn-small {
	padding: 6px 12px;
	font-size: 13px;
}

.nav-btn {
	background: #333;
	color: white;
	border: none;
	padding: 8px 15px;
	border-radius: 4px;
	cursor: pointer;
	font-size: 16px;
}

.nav-btn:hover:not(:disabled) {
	background: #444;
}

.nav-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.nav-title {
	font-size: 14px;
	color: white;
}

.nav-index {
	color: #888;
	margin-left: 5px;
}

.nav-saving {
	color: #f0ad4e;
	margin-left: 8px;
	font-size: 12px;
}

.sharpness-info {
    font-size: 12px;
    color: #888;
    margin-top: 2px;
    font-weight: normal;
}

.sharpness-info .score {
    color: #4caf50;
    font-weight: bold;
    font-family: monospace;
}

.header-actions {
	display: flex;
	gap: 10px;
}

/* Export dropdown - uses kebab-dropdown pattern from design system */
.export-dropdown {
	position: relative;
}

.dropdown-arrow {
	margin-left: 4px;
	font-size: 10px;
}

.dropdown-menu {
	position: absolute;
	top: 100%;
	right: 0;
	margin-top: 4px;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
	min-width: 200px;
	z-index: 200;
	overflow: hidden;
}

.dropdown-menu button {
	display: block;
	width: 100%;
	padding: 10px 15px;
	background: none;
	border: none;
	color: #333;
	text-align: left;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}

.dropdown-menu button:hover {
	background: #f0f0f0;
}

.dropdown-menu hr {
	border: none;
	border-top: 1px solid #eee;
	margin: 4px 0;
}

.export-dir-name {
	padding: 6px 15px 10px;
	font-size: 11px;
	color: #666;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* PostProcessor wrapper - fills available space */
.post-processor-wrapper {
	flex: 1;
	min-height: 0;
	overflow: auto;
}
</style>
