<template>
<div class="batch-post-processor">
	<!-- Everything this component contributes now lives in the post processor's
	     toolbar and canvas (the #nav, #status and #export-menu slots below), so
	     there is no bar of its own above the canvas any more. -->

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
		>
			<template #nav>
				<div class="nav-group">
					<div class="variant-nav">
						<button class="variant-arrow" aria-label="Previous stack" @click="prevImage" :disabled="currentIndex <= 0 || isNavigating">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
						</button>
						<div class="variant-label">
							<div class="variant-title">
								<span class="variant-name">{{ currentResult?.name || 'Image' }}</span>
								<span class="variant-index">{{ currentIndex + 1 }}/{{ results.length }}</span>
							</div>
							<div v-if="isNavigating" class="variant-sub is-saving">saving…</div>
							<div v-else-if="isContinuousMode && currentResult" class="variant-sub">sharpness <span class="variant-score">{{ formatScore(currentResult.sharpness) }}</span></div>
						</div>
						<button class="variant-arrow" aria-label="Next stack" @click="nextImage" :disabled="currentIndex >= results.length - 1 || isNavigating">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
						</button>
					</div>
					<!-- Aligns the stacks you step through with those arrows, so it
					     belongs beside them. Continuous runs already share one
					     reference frame, so there is nothing to align. -->
					<button
						v-if="!isContinuousMode"
						class="align-btn"
						@click="alignAllStacks"
						:disabled="isAligning || results.length < 2"
					>
						{{ isAligning ? 'Aligning…' : 'Align Stacks' }}
					</button>
				</div>
			</template>

			<!-- Progress for a whole-set export. Over the canvas, opposite the
			     zoom pill, because it comes and goes for minutes at a time and
			     must not move anything when it does. -->
			<template #status>
				<span v-if="exportStatus" class="export-status">{{ exportStatus }}</span>
			</template>

			<!-- Hangs off the Export button's chevron: the whole-set options,
			     next to the single-image export they belong with. -->
			<template #export-menu>
				<button class="export-menu-item" @click="exportAll('processed')" :disabled="isProcessingAll || isExporting">
					Export all processed (PNG)
					<small>{{ results.length }} stacks with current adjustments</small>
				</button>
				<button class="export-menu-item" @click="exportAll('unprocessed')" :disabled="isExporting">
					Export all unprocessed (PNG)
					<small>{{ results.length }} stacks as stacked</small>
				</button>
				<button
					v-if="videoEncodingSupported && !isContinuousMode"
					class="export-menu-item"
					@click="exportVideo"
					:disabled="isEncodingVideo || isProcessingAll || results.length < 2"
				>
					Export video (MP4)
				</button>
				<div class="export-menu-sep"></div>
				<button class="export-menu-item" @click="selectExportDirectory">
					{{ exportDirHandle ? '✓ ' : '' }}Select export folder…
					<small v-if="exportDirName">{{ exportDirName }}</small>
				</button>
			</template>
		</PostProcessor>
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

// What the leftover header bar reports while a whole-set export runs. The menu
// that starts these lives in the post processor toolbar now, so the progress
// can no longer ride on its button label.
const exportStatus = computed(() => {
	if (isProcessingAll.value) return processingAllProgress.value;
	if (isEncodingVideo.value) return videoProgress.value;
	if (isExporting.value) return 'Exporting…';
	return '';
});

// Select export directory using File System Access API
async function selectExportDirectory() {
	try {
		const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
		exportDirHandle.value = handle;
		exportDirName.value = handle.name;
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
				// Unprocessed: re-encode from float32 so the export keeps the full
				// 16-bit stack. result.blob is an 8-bit canvas PNG, which throws
				// away most of the range on a dim linear stack.
				if (result.result?.float32Data) {
					blob = await float32ToBlob(result.result.float32Data, result.result.width, result.result.height);
				} else {
					blob = result.result?.blob;
				}
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
	// Check if video encoding is supported
	videoEncodingSupported.value = await isVideoEncodingSupported();
});

onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
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

/* The navigator and the action that operates on what it steps through. */
.nav-group {
	display: flex;
	align-items: center;
	gap: 8px;
}

/* Matches the toolbar's other secondary buttons (Rate, Publish). Styled here
   rather than in PostProcessor because scoped CSS does not reach into another
   component's slot content. */
.align-btn {
	padding: 8px 15px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.16);
	color: var(--eise-bright);
	font: inherit;
	font-size: 14px;
	font-weight: 500;
	line-height: 1;
	cursor: pointer;
	transition: background 120ms ease;
}
.align-btn:hover:not(:disabled) {
	background: rgba(255, 255, 255, 0.11);
	color: #ffffff;
}
.align-btn:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

/* Variant navigator, rendered into the post processor's toolbar. Steps through
   the set this component holds: the continuous stacks, or a batch of files. */
.variant-nav {
	display: flex;
	align-items: center;
	gap: 2px;
	height: 38px;
	box-sizing: border-box;
	padding: 3px;
	border-radius: 7px;
	background: rgba(0, 0, 0, 0.22);
	border: 1px solid rgba(217, 169, 74, 0.3);
}

.variant-arrow {
	width: 24px;
	height: 30px;
	display: grid;
	place-items: center;
	padding: 0;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--eise-gilt-lt);
	cursor: pointer;
}

.variant-arrow:hover:not(:disabled) {
	background: rgba(217, 169, 74, 0.16);
}

.variant-arrow:disabled {
	opacity: 0.35;
	cursor: not-allowed;
}

.variant-label {
	padding: 0 2px;
	text-align: center;
	line-height: 1.2;
}

.variant-title {
	display: flex;
	align-items: baseline;
	justify-content: center;
	gap: 7px;
}

.variant-name {
	font-size: 14px;
	font-weight: 600;
	color: #ffffff;
	white-space: nowrap;
}

.variant-index {
	font-family: var(--eise-mono);
	font-size: 11px;
	color: var(--eise-muted);
}

.variant-sub {
	font-family: var(--eise-mono);
	font-size: 11px;
	color: var(--eise-muted-2);
	white-space: nowrap;
}

.variant-score {
	color: #8CCF7E;
}

.variant-sub.is-saving {
	color: var(--eise-gilt-lt);
}

/* Entries for the Export button's dropdown in the post processor toolbar. The
   dropdown itself is PostProcessor's (the kebab-dropdown pattern); these are
   slotted in from here, so they are styled here — scoped CSS does not reach
   across into another component's slot content. */
.export-menu-item {
	display: block;
	width: 100%;
	padding: 8px 12px;
	background: none;
	border: none;
	color: #333;
	text-align: left;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}

.export-menu-item:hover:not(:disabled) {
	background: #f0f0f0;
}

.export-menu-item:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.export-menu-item small {
	display: block;
	margin-top: 1px;
	font-size: 11px;
	font-weight: normal;
	color: #888;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.export-menu-sep {
	height: 1px;
	margin: 4px 6px;
	background: #eee;
}

/* Progress for a whole-set export. A floating pill in the canvas's top-right,
   mirroring the zoom pill opposite it, so showing and hiding it reflows
   nothing — an export runs for minutes and the page used to jump twice. */
.export-status {
	position: absolute;
	top: 12px;
	right: 12px;
	z-index: 3;
	display: inline-flex;
	align-items: center;
	padding: 6px 12px;
	border-radius: 8px;
	background: rgba(9, 52, 66, 0.88);
	backdrop-filter: blur(8px);
	border: 1px solid rgba(217, 169, 74, 0.3);
	box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
	font-family: var(--eise-mono);
	font-size: 12px;
	color: var(--eise-gilt-lt);
	white-space: nowrap;
}

/* PostProcessor wrapper - fills available space */
.post-processor-wrapper {
	flex: 1;
	min-height: 0;
	overflow: auto;
}
</style>
