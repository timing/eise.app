<template>
	<div class="page-layout">
		<div class="card">
			<LoadingIndicator />

			<div class="action-buttons processing-actions">
				<button class="btn-danger" @click="cancelProcessing">Cancel</button>
			</div>

			<div v-if="skippedFrames > 0" class="skipped-info">
				<p>{{ skippedFrames }} frames skipped (couldn't crop)</p>
			</div>

			<div v-if="uploadError" class="error-message">
				<p>Error: {{ uploadError }}</p>
				<p class="feedback-prompt">
					Something went wrong? <a href="https://github.com/timing/eise.app/issues" @click="openErrorFeedback">Let me know what happened</a> so I can fix it.
				</p>
			</div>

			<!-- Cancelled message -->
			<div v-if="showCancelledMessage" class="cancelled-message">
				<p>Processing cancelled.</p>
				<p class="feedback-prompt">
					Was something not working? <a href="https://github.com/timing/eise.app/issues" @click="openCancelFeedback">Let me know</a> so I can improve things.
				</p>
				<button class="reload-button" @click="reloadPage">Start over</button>
			</div>
		</div>

		<div class="content" v-if="processingStage === 'analyzing' || processingStage === 'stacking'">
			<div class="preview-frames-row">
				<div v-if="processingStage === 'analyzing' && bestFrame" class="preview-frame" :class="{ 'dual-preview': bestFrame?.grayBlob }">
					<h4>Sharpest Frame{{ bestFrame?.grayBlob ? ' (Analysis vs Color)' : '' }}</h4>
					<div class="dual-canvas-row">
						<div v-if="bestFrame?.grayBlob" class="canvas-wrapper">
							<span class="canvas-label">Grayscale (used for analysis)</span>
							<canvas ref="bestFrameGrayCanvas"></canvas>
						</div>
						<div class="canvas-wrapper">
							<span v-if="bestFrame?.grayBlob" class="canvas-label">Color (used for stacking)</span>
							<canvas ref="bestFrameCanvas"></canvas>
						</div>
					</div>
					<p class="frame-stats">Sharpness: {{ bestFrame.sharpness?.toFixed(2) }} (Tenengrad: {{ bestFrame.tenengrad?.toFixed(2) }}, Laplacian: {{ bestFrame.laplacian?.toFixed(2) }}) · Circularity: {{ bestFrame.circularity?.toFixed(2) || '?' }}</p>
				</div>

				<div v-if="processingStage === 'analyzing' && refCandidate" class="preview-frame">
					<h4>Reference Candidate</h4>
					<canvas ref="refCandidateCanvas"></canvas>
					<p class="frame-stats">Sharpness: {{ refCandidate.sharpness?.toFixed(2) }} (Tenengrad: {{ refCandidate.tenengrad?.toFixed(2) }}, Laplacian: {{ refCandidate.laplacian?.toFixed(2) }}) · Circularity: {{ refCandidate.circularity?.toFixed(2) || '?' }}</p>
				</div>
			</div>

			<div v-if="processingStage === 'stacking' && referenceFrame" class="preview-frame">
				<h4>Reference Frame for Alignment</h4>
				<canvas ref="referenceFrameCanvas"></canvas>
			</div>
		</div>
	</div>
</template>

<script setup>
import { onMounted, ref, watch, defineProps, onBeforeUpdate, nextTick } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useTracking } from '@/composables/useTracking';
import { useProcessingState } from '@/composables/useProcessingState';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useFeedback } from '@/composables/useFeedback';

const { on, addLog, emit } = useEventBus();
const { track } = useTracking();
const { getTrackingContext } = useProcessingState();
const { workerUrl } = useWorkerUrl();
const { openFeedback } = useFeedback();

async function openErrorFeedback(event) {
	const opened = await openFeedback({
		formTitle: 'Report an issue',
		messagePlaceholder: 'What were you trying to do when this error occurred?',
	});
	if (opened) {
		event.preventDefault();
	}
}

async function openCancelFeedback(event) {
	const opened = await openFeedback({
		formTitle: 'What went wrong?',
		messagePlaceholder: 'Why did you cancel? Was something not working or taking too long?',
	});
	if (opened) {
		event.preventDefault();
	}
}

const { $ffmpeg } = useNuxtApp();

const props = defineProps({
	frames: Array
});

const bestFramesCount = ref(0);
const allFramesCount = ref(0);
const processingStage = ref('importing'); // Will be 'importing' initially, then 'analyzing', then 'stacking'
const uploadError = ref(null); // New ref for upload errors
const showCancelledMessage = ref(false);

const bestFrame = ref(null);
const referenceFrame = ref(null);
const refCandidate = ref(null);  // Most circular from top frames
const bestFrameCanvas = ref(null);
const bestFrameGrayCanvas = ref(null);  // Grayscale preview for side-by-side comparison
const referenceFrameCanvas = ref(null);
const refCandidateCanvas = ref(null);
const croppedSerData = ref(null);
const skippedFrames = ref(0);

let unifiedAnalyzeWorkers = new Array((navigator && navigator.hardwareConcurrency) || 4);
let workersInitialized = false;

// Define bestFramesForStacking outside processImageFrames to persist state across calls/worker responses
const bestFramesForStacking = []; // These will store {sharpness, blob}

// Initialize workers and wait for OpenCV to be ready
async function initializeWorkers() {
	if (workersInitialized) return;

	for (let i = 0; i < unifiedAnalyzeWorkers.length; i++) {
		unifiedAnalyzeWorkers[i] = new Worker(workerUrl('/unified_analyze_worker.js'));
		unifiedAnalyzeWorkers[i].onerror = (e) => { console.error(e); };
	}

	const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Worker ${i} initialization timed out.`)), 10000);
			const handler = (e) => {
				if (e.data.type === 'ready') {
					clearTimeout(timeout);
					worker.removeEventListener('message', handler);
					resolve();
				}
			};
			worker.addEventListener('message', handler);
			worker.postMessage({ type: 'init' });
		});
	});

	try {
		await Promise.all(workerPromises);
		workersInitialized = true;
		addLog('Analysis workers initialized.');
	} catch (error) {
		console.error('Worker initialization failed:', error);
		addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
	}
}

// Define rankFrame outside processImageFrames so it can be used by worker message listener
function rankFrame(frame) {
	// Update best frame if this one is sharper
	if (bestFrame.value === null || frame.sharpness > bestFrame.value.sharpness) {
		bestFrame.value = frame;
		updateBestFrameCanvas();
	}

	// Keep track of best frames for stacking (bestFramesCapacity will be set inside processImageFrames)
	if (bestFramesForStacking.length < bestFramesCapacity) {
		bestFramesForStacking.push(frame);
	} else {
		let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
			(currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

		if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
			bestFramesForStacking[minSharpnessIndex] = frame;
		}
	}
	bestFramesCount.value = bestFramesForStacking.length;

	// Update reference candidate: most circular from top 1% of sharpest frames
	updateRefCandidate();
}

function updateRefCandidate() {
	if (bestFramesForStacking.length === 0) return;

	// Sort by sharpness to get top frames
	const sorted = [...bestFramesForStacking].sort((a, b) => b.sharpness - a.sharpness);
	const topCount = Math.max(1, Math.ceil(sorted.length * 0.01));
	const topFrames = sorted.slice(0, topCount);

	// Find most circular among top frames
	const mostCircular = topFrames.reduce((best, f) =>
		(f.circularity || 0) > (best.circularity || 0) ? f : best
	);

	// Only update if different (avoid unnecessary redraws)
	if (!refCandidate.value || mostCircular.blob !== refCandidate.value.blob) {
		refCandidate.value = mostCircular;
		updateRefCandidateCanvas();
	}
}


onMounted(async () => {
	if (props.frames && props.frames.length > 0) {
		uploadError.value = null; // Reset error
		processingStage.value = 'analyzing';
		emit('set-caption', 'Analyzing frames');
		await processImageFrames(props.frames);
	}

	on('best-frame-updated', (frame) => {
		if (processingStage.value !== 'analyzing') {
			uploadError.value = null; // Reset error
			processingStage.value = 'analyzing';
		}
		// Only update if this frame is sharper than current best
		if (!bestFrame.value || frame.sharpness > bestFrame.value.sharpness) {
			bestFrame.value = frame;
			updateBestFrameCanvas();
		}
	});

	on('ref-candidate-updated', (frame) => {
		refCandidate.value = frame;
		updateRefCandidateCanvas();
	});

	on('stacking-started', (data) => {
		processingStage.value = 'stacking';
		if (data && data.referenceFrame) {
			referenceFrame.value = data.referenceFrame;
			updateReferenceFrameCanvas();
		}
	});

	on('upload-error', (message) => {
		uploadError.value = message;
		emit('show-error'); // Show error state in LoadingIndicator
	});

	on('cropped-ser-ready', (data) => {
		croppedSerData.value = data;
	});

	on('crop-stats-updated', (stats) => {
		skippedFrames.value = stats.skipped;
	});
});


function cancelProcessing() {
	track('stack_cancelled', getTrackingContext());
	emit('stop-loading');
	emit('cancel-processing');
	showCancelledMessage.value = true;
}

function reloadPage() {
	window.location.reload();
}

watch(() => props.frames, (newVal) => {
	if (newVal && newVal.length > 0) {
		uploadError.value = null; // Reset error
		processingStage.value = 'analyzing';
		processImageFrames(newVal);
	}
});

function updateBestFrameCanvas() {
	nextTick(() => {
		if (bestFrame.value) {
			// Draw color preview
			if (bestFrameCanvas.value) {
				const blob = bestFrame.value instanceof Blob ? bestFrame.value : bestFrame.value?.blob;
				if (blob) {
					drawImageOnCanvas(bestFrameCanvas.value, blob);
				}
			}
			// Draw grayscale preview (side-by-side comparison)
			if (bestFrameGrayCanvas.value && bestFrame.value?.grayBlob) {
				drawImageOnCanvas(bestFrameGrayCanvas.value, bestFrame.value.grayBlob);
			}
		}
	});
}

function updateReferenceFrameCanvas() {
	nextTick(() => {
		if (referenceFrame.value && referenceFrameCanvas.value) {
			const blob = referenceFrame.value instanceof Blob ? referenceFrame.value : referenceFrame.value?.blob;
			if (blob) {
				drawImageOnCanvas(referenceFrameCanvas.value, blob);
			}
		}
	});
}

function updateRefCandidateCanvas() {
	nextTick(() => {
		if (refCandidate.value && refCandidateCanvas.value) {
			const blob = refCandidate.value instanceof Blob ? refCandidate.value : refCandidate.value?.blob;
			if (blob) {
				drawImageOnCanvas(refCandidateCanvas.value, blob);
			}
		}
	});
}

function drawImageOnCanvas(canvas, blob) {
  const ctx = canvas.getContext('2d');
  createImageBitmap(blob).then(img => {
    // Scale to half size, but ensure minimum 120px display
    const minSize = 120;
    let scale = 0.5;
    if (img.width * scale < minSize || img.height * scale < minSize) {
      // Scale up to meet minimum size
      scale = Math.max(minSize / img.width, minSize / img.height);
    }
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }).catch(error => {
    console.error('Error drawing image to canvas:', error, 'Blob size:', blob.size, 'Blob type:', blob.type);
    // Optionally, draw a placeholder or error message on the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'red';
    ctx.font = '10px Arial';
    ctx.fillText('Error', 5, 15);
  });
}

let bestFramesCapacity; // Declare outside to be accessible by rankFrame

async function processImageFrames(files) {
	if (!files || files.length === 0) return;

	await initializeWorkers();

	if (!workersInitialized) {
		addLog('Cannot process frames - workers failed to initialize.');
		emit('stop-loading');
		return;
	}

	emit('set-caption', 'Analyzing frames'); // LoadingIndicator will display this caption

	bestFramesCapacity = Math.floor(files.length * 0.3); // Set here

	const usedFFmpeg = typeof files[0] === 'string';

	const resolveFunctions = new Array(files.length);
	const rejectFunctions = new Array(files.length);

	for (let i = 0; i < unifiedAnalyzeWorkers.length; i++) {
		unifiedAnalyzeWorkers[i].addEventListener('message', (e) => {
			const index = e.data.index;

			allFramesCount.value++;
			emit('update-loading', { progress: (allFramesCount.value / files.length) * 100, current: allFramesCount.value, total: files.length });

			// Worker returns { sharpness, pngBlob, index, circularity }
			if (e.data.sharpness !== undefined && e.data.pngBlob) {
				const currentFrame = {
					sharpness: e.data.sharpness,
					blob: e.data.pngBlob,
					circularity: e.data.circularity || 0
				};
				rankFrame(currentFrame);
				resolveFunctions[index]();
			} else if (e.data.error) {
				addLog('Failed analyzing frame ' + index + ': ' + e.data.error);
				rejectFunctions[index](new Error(e.data.error));
			} else {
				addLog('Failed analyzing frame ' + index);
				rejectFunctions[index](new Error("Processing failed."));
			}
		});
	}

	const promises = files.map((file, index) => {
		return new Promise((resolve, reject) => {
			resolveFunctions[index] = resolve;
			rejectFunctions[index] = reject;

			setTimeout(async () => {
				let data;
				if (usedFFmpeg) {
					data = $ffmpeg.FS('readFile', file);
					$ffmpeg.FS('unlink', file);
				} else {
					data = new Uint8Array(await file.arrayBuffer());
				}
				// Post message to unified worker - worker will return pngBlob directly
				const analyzeDataForWorker = data.slice(); // Create a copy for transfer
				unifiedAnalyzeWorkers[index % unifiedAnalyzeWorkers.length].postMessage({ type: 'ffmpeg', analyze: analyzeDataForWorker, index: index }, [analyzeDataForWorker.buffer]);
			}, 10);
		});
	});

	try {
		await Promise.all(promises);
	} catch(error){
		console.log('One or more frames failed analyzing. Trying to continue.', error);
		addLog('One or more frames failed analyzing. Trying to continue.');
	}

	addLog('Done analyzing frames. Cleaning up');
	if (usedFFmpeg) {
		try {
			$ffmpeg.exit();
		} catch(e) {}
	}
	addLog('Cleaning up done');
}
</script>

<style scoped>
	.preview-frames-row {
		display: flex;
		gap: 20px;
		justify-content: center;
		flex-wrap: wrap;
	}
	.preview-frame {
		text-align: center;
		margin-bottom: 20px;
	}
	.preview-frame h4 {
		margin: 0 0 10px 0;
		color: #c6fffd;
	}
	.preview-frame canvas {
		border: 1px solid #ccc;
		border-radius: 5px;
		max-width: 100%;
	}
	.sharpness-label, .frame-stats {
		margin: 8px 0 0 0;
		font-size: 13px;
		color: #c6fffd;
	}
	.error-message {
		background-color: #ffcccc;
		color: #D9534F;
		padding: 10px;
		margin-top: 10px;
		border-radius: 5px;
		font-weight: bold;
	}
	.error-message .feedback-prompt {
		font-weight: normal;
		font-size: 0.9em;
		margin-top: 8px;
	}
	.error-message .feedback-prompt a {
		color: #D9534F;
		text-decoration: underline;
	}
	.cancelled-message {
		background-color: #fff3cd;
		color: #856404;
		padding: 10px;
		margin-top: 10px;
		border-radius: 5px;
		text-align: left;
		font-weight: bold;
	}
	.cancelled-message .feedback-prompt {
		font-weight: normal;
		font-size: 0.9em;
		margin-top: 8px;
	}
	.cancelled-message .feedback-prompt a {
		color: #856404;
		text-decoration: underline;
	}
	.cancelled-message .reload-button {
		margin-top: 12px;
		padding: 8px 20px;
		background: #856404;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}
	.cancelled-message .reload-button:hover {
		background: #6d5203;
	}
	.skipped-info {
		background-color: #fff3cd;
		color: #856404;
		padding: 8px 12px;
		margin-top: 10px;
		border-radius: 5px;
		font-size: 12px;
	}
	.skipped-info p {
		margin: 0;
	}
	.action-buttons {
		display: flex;
		gap: 10px;
		margin-top: 10px;
	}
	.processing-actions {
		justify-content: center;
		margin-top: 20px;
	}
	/* Side-by-side grayscale/color preview */
	.dual-preview {
		min-width: 500px;
	}
	.dual-canvas-row {
		display: flex;
		gap: 15px;
		justify-content: center;
	}
	.canvas-wrapper {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.canvas-label {
		font-size: 11px;
		color: #999;
		margin-bottom: 5px;
	}
</style>
