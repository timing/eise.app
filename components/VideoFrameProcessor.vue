<template>
	<div class="page-layout pp-layout">
		<div class="panel">
			<!-- What is being stacked, named for the whole run. -->
			<div v-if="sourceFile" class="panel-section">
				<FileMetaCard :file="sourceFile" :profile="sourceColorProfile" />
			</div>

			<div class="panel-section">
				<LoadingIndicator />

				<!-- Where we are in the run (display only, see stageSteps). -->
				<ol class="stage-steps">
					<li v-for="step in stageSteps" :key="step.label" class="stage-step" :class="step.state">
						<span class="step-dot" aria-hidden="true"></span>
						<span class="step-name">{{ step.label }}</span>
						<span class="step-meta">{{ step.meta }}</span>
					</li>
				</ol>
			</div>

			<div v-if="!showCancelledMessage && !uploadError" class="panel-section panel-section-flush processing-actions">
				<button class="cancel-btn" @click="cancelProcessing">Cancel</button>
				<p class="processing-hint">Stacking can take a while, but the results are hopefully worth the wait!</p>
			</div>

			<div v-if="skippedFrames > 0" class="skipped-info panel-inset">
				<p>{{ skippedFrames }} frames skipped (couldn't crop)</p>
			</div>

			<div v-if="uploadError" class="error-message panel-inset">
				<p>Error: {{ uploadError }}</p>
				<p class="feedback-prompt">
					Something went wrong? <a href="https://github.com/timing/eise.app/issues" @click="openErrorFeedback">Let me know what happened</a> so I can fix it.
				</p>
			</div>

			<!-- Cancelled message -->
			<div v-if="showCancelledMessage" class="cancelled-message panel-inset">
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
					<h4 class="preview-label">Sharpest frame{{ bestFrame?.grayBlob ? ' (analysis vs color)' : '' }}</h4>
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
					<p class="frame-stats">Sharpness: {{ bestFrame.sharpness?.toFixed(2) }} (Tenengrad) · Circularity: {{ bestFrame.circularity?.toFixed(2) || '?' }}</p>
				</div>

				<div v-if="processingStage === 'analyzing' && refCandidate" class="preview-frame">
					<h4 class="preview-label">Reference candidate</h4>
					<canvas ref="refCandidateCanvas"></canvas>
					<p class="frame-stats">Sharpness: {{ refCandidate.sharpness?.toFixed(2) }} (Tenengrad) · Circularity: {{ refCandidate.circularity?.toFixed(2) || '?' }}</p>
				</div>
			</div>

			<div v-if="processingStage === 'stacking' && referenceFrame" class="preview-frame" :class="{ 'dual-preview': alignmentOverlay }">
				<h4 class="preview-label">{{ apReviewOpen ? 'Alignment Points editor' : 'Reference frame for alignment' }}{{ alignmentOverlay && !apReviewOpen ? ' (frame vs alignment points)' : '' }}</h4>
				<div class="dual-canvas-row">
					<div class="canvas-wrapper">
						<span v-if="alignmentOverlay" class="canvas-label">Reference frame</span>
						<canvas ref="referenceFrameCanvas"></canvas>
					</div>
					<div v-if="alignmentOverlay" class="canvas-wrapper">
						<span class="canvas-label">Alignment points (stretched)</span>
						<canvas ref="alignmentCanvas"></canvas>
					</div>
				</div>
				<div v-if="apReviewOpen" class="ap-review-bar">
					<span>Paused so you can check the alignment points.</span>
					<label class="ap-review-field">
						AP size
						<input type="number" min="10" step="2" v-model.number="apSizeDraft" class="number-input" />
						px
					</label>
					<span v-if="apRebuilding" class="ap-review-status">rebuilding…</span>
					<button type="button" class="ap-review-continue" @click="continueFromApReview">Continue stacking</button>
				</div>
				<p v-if="alignmentOverlay" class="frame-stats">
					{{ alignmentOverlay.alignmentPoints.length }} alignment points · {{ alignmentOverlay.patchSize }}px patches{{ alignmentOverlay.autoPatchSize === false ? ' (manual)' : ' (measured)' }} · {{ alignmentOverlay.searchRadius }}px search
					<template v-if="alignmentOverlay.overlapPct != null"> · {{ alignmentOverlay.overlapPct }}% overlap</template>
					<template v-if="alignmentOverlay.localWarp === false"><br>local de-warping off, aligning globally</template>
				</p>
			</div>

			<!-- Nothing to show yet: hold the space so the column does not pop. -->
			<div v-if="processingStage === 'analyzing' && !bestFrame && !refCandidate" class="preview-placeholder">
				<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4d6874" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3.6 9.5h16.8M3.6 14.5h16.8" /></svg>
				<span>Reference frame appears once analysis completes</span>
			</div>
		</div>
	</div>
</template>

<script setup>
import { onMounted, ref, computed, watch, defineProps, onBeforeUpdate, nextTick } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import FileMetaCard from '@/components/FileMetaCard.vue';
import { useTracking } from '@/composables/useTracking';
import { useProcessingState } from '@/composables/useProcessingState';
import { useStackLogTelemetry } from '@/composables/useStackLogTelemetry';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useFeedback } from '@/composables/useFeedback';

const { on, addLog, emit } = useEventBus();
const { track } = useTracking();
const { getTrackingContext, getStackJobProps, sourceFile, sourceColorProfile } = useProcessingState();
const { getLogTail } = useStackLogTelemetry();
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

// Run progress shown in the panel. Display only - it never drives processing.
//
// processingStage alone is not enough to label the phase: the readers only flip
// it to 'analyzing' on the first `best-frame-updated`, which lands well after
// analysis actually starts (and not at all for short clips), so the panel would
// still claim "Importing" while the caption already reads "Analyzing frames".
// The readers do announce the switch through the caption, so that is used as a
// second signal. Worst case a caption is renamed and a step lights up late -
// the caption itself always shows the true current step.
const ANALYSIS_CAPTION = /analy/i;
const sawAnalysisCaption = ref(false);
const STAGE_LABELS = ['Importing frames', 'Analyzing frames', 'Aligning and stacking'];
const displayStage = computed(() => {
	if (processingStage.value === 'stacking') return 2;
	if (processingStage.value === 'analyzing' || sawAnalysisCaption.value) return 1;
	return 0;
});
// Frame counts for the analysis step's meta. `update-loading` counts frames
// analysed during analysis and frames stacked afterwards, so the analysis
// figure is latched at the handover rather than read live.
const ANALYSIS_STAGE = STAGE_LABELS.indexOf('Analyzing frames');
const loadingCurrent = ref(0);
const loadingTotal = ref(0);
const analyzedFrames = ref(0);
const stageSteps = computed(() => STAGE_LABELS.map((label, i) => {
	const state = displayStage.value > i ? 'done' : displayStage.value === i ? 'active' : 'pending';
	let meta = state === 'done' ? 'done' : state === 'active' ? 'in progress' : 'queued';
	if (i === ANALYSIS_STAGE) {
		if (state === 'active' && loadingTotal.value > 0) meta = `${loadingCurrent.value}/${loadingTotal.value}`;
		else if (state === 'done' && analyzedFrames.value > 0) meta = `${analyzedFrames.value} frames`;
	}
	return { label, state, meta };
}));
const uploadError = ref(null); // New ref for upload errors
const showCancelledMessage = ref(false);

const bestFrame = ref(null);
const referenceFrame = ref(null);
const refCandidate = ref(null);  // Most circular from top frames
const bestFrameCanvas = ref(null);
const bestFrameGrayCanvas = ref(null);  // Grayscale preview for side-by-side comparison
const referenceFrameCanvas = ref(null);
const alignmentOverlay = ref(null);
const alignmentCanvas = ref(null);
const apReviewOpen = ref(false);

const apSizeDraft = ref(null);
const apRebuilding = ref(false);
let apResizeTimer = null;

function continueFromApReview() {
	clearTimeout(apResizeTimer);
	apReviewOpen.value = false;
	emit('ap-review-continue');
}

// Rebuild as the number changes, rather than behind a button.
//
// Debounced because a number input emits on every keystroke: typing "80" goes
// 8 then 80, and "120" goes 1, 12, 120, so firing on each one would rebuild
// the grid at sizes nobody asked for. The review bar deliberately stays open
// during the rebuild; the stacker re-publishes the grid and the overlay
// redraws underneath, which is the whole point of changing the value here.
const AP_RESIZE_DEBOUNCE_MS = 450;
watch(apSizeDraft, (val) => {
	if (!apReviewOpen.value) return;
	clearTimeout(apResizeTimer);
	const size = Math.round(Number(val));
	if (!Number.isFinite(size) || size < 10) return;
	// Seeding the field from a rebuilt grid must not trigger another rebuild.
	if (size === alignmentOverlay.value?.patchSize) return;
	apResizeTimer = setTimeout(() => {
		apRebuilding.value = true;
		emit('ap-review-continue', { patchSize: size });
	}, AP_RESIZE_DEBOUNCE_MS);
});
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
				if (!e.data) {
					clearTimeout(timeout);
					worker.removeEventListener('message', handler);
					reject(new Error('Worker crashed - try reloading the page'));
					return;
				}
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

	// Reset frame previews when a new batch file starts processing
	on('batch-file-status', ({ status }) => {
		if (status === 'analyzing') {
			bestFrame.value = null;
			referenceFrame.value = null;
			refCandidate.value = null;
			alignmentOverlay.value = null;
			apReviewOpen.value = false;
			apRebuilding.value = false;
			clearTimeout(apResizeTimer);
		}
	});

	on('set-caption', (text) => {
		if (ANALYSIS_CAPTION.test(text || '')) sawAnalysisCaption.value = true;
	});

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

	on('update-loading', (data) => {
		if (typeof data !== 'object' || !data) return;
		if (data.current !== undefined) loadingCurrent.value = data.current;
		if (data.total !== undefined) loadingTotal.value = data.total;
	});

	on('stacking-started', (data) => {
		processingStage.value = 'stacking';
		analyzedFrames.value = loadingTotal.value;
		if (data && data.referenceFrame) {
			referenceFrame.value = data.referenceFrame;
			updateReferenceFrameCanvas();
		}
	});

	// Emitted once the AP grid is built, which is after stacking-started, so the
	// frame may already be on the canvas. Redraw rather than depend on ordering.
	on('alignment-points', (data) => {
		alignmentOverlay.value = data;
		// Set after the overlay, so the watcher above sees them equal and does
		// not bounce straight into another rebuild.
		apSizeDraft.value = data.patchSize;
		apRebuilding.value = false;
		updateReferenceFrameCanvas();
	});

	on('ap-review-open', () => { apReviewOpen.value = true; });
	// Closed by the stacker itself too, so cancelling mid-review clears the bar.
	on('ap-review-closed', () => { apReviewOpen.value = false; });

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
	const tail = getLogTail();
	track('stack_cancelled', { ...getStackJobProps(), ...(tail || {}), reason: 'user_click' });
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
		// Drawn bigger than the plain preview: at half size a 28px patch is 14
		// wide and the grid collapses into texture.
		if (referenceFrame.value && alignmentCanvas.value && alignmentOverlay.value) {
			const blob = referenceFrame.value instanceof Blob ? referenceFrame.value : referenceFrame.value?.blob;
			if (blob) {
				drawImageOnCanvas(alignmentCanvas.value, blob, drawAlignmentPoints, { minSize: 260, stretch: true });
			}
		}
	});
}

// Draw the AP grid over the reference frame: every patch at its true size and
// position, translucent fill with a solid border.
//
// Overlap shows itself through the fill, so the fill has to be strong enough to
// see. Coverage is not uniform: at 50% overlap a pixel sits under 1, 2, 3 or 4
// patches depending on where it falls between centres, and stacked alpha turns
// those counts into distinct brightness levels. That banding IS the overlap,
// which is why PSS's view reads the way it does.
//
// Measured at these settings the four levels land at opacity 0.15 / 0.28 /
// 0.39 / 0.48. Borders stay visible but step back, because at full strength
// they dominate the very banding that carries the information.
const AP_OVERLAY_FILL_ALPHA = 0.15;
const AP_OVERLAY_EDGE_ALPHA = 0.55;

function drawAlignmentPoints(ctx, scale, img) {
	const overlay = alignmentOverlay.value;
	if (!overlay?.alignmentPoints?.length) return;
	// AP coordinates are in reference-frame pixels. If the canvas is showing a
	// differently sized frame the overlay belongs to another run, and drawing
	// it would put the markers in the wrong place rather than simply look odd.
	if (img && overlay.width && overlay.width !== img.width) return;

	const css = getComputedStyle(document.documentElement);
	// Muted when the points were measured but are not being applied, so the
	// overlay never implies de-warping that is not happening.
	const token = overlay.localWarp === false ? '--eise-muted' : '--eise-gilt';
	const colour = css.getPropertyValue(token).trim() || '#d9a94a';

	const points = overlay.alignmentPoints;
	const box = Math.max(2, Math.round(overlay.patchSize * scale));
	const corner = (ap) => [
		Math.round(ap.x * scale - box / 2),
		Math.round(ap.y * scale - box / 2),
	];

	ctx.save();
	ctx.lineWidth = 1;

	ctx.fillStyle = colour;
	ctx.globalAlpha = AP_OVERLAY_FILL_ALPHA;
	for (const ap of points) {
		const [x, y] = corner(ap);
		ctx.fillRect(x, y, box, box);
	}

	ctx.strokeStyle = colour;
	ctx.globalAlpha = AP_OVERLAY_EDGE_ALPHA;
	for (const ap of points) {
		const [x, y] = corner(ap);
		ctx.strokeRect(x + 0.5, y + 0.5, box, box);
	}
	ctx.restore();
}

// Linear display stretch for the preview.
//
// A dim capture can be perfectly good data and still show as near-black, which
// makes it impossible to judge whether the alignment points landed on the
// subject. Purely cosmetic: this touches the preview canvas only, never the
// greyscale the matcher sees or anything that is stacked.
//
// Black and white points come from percentiles rather than min/max, so one hot
// pixel or one dead pixel cannot flatten the whole stretch. The same scale is
// applied to all three channels so colour balance is preserved.
const STRETCH_LOW_PCT = 0.005;
const STRETCH_HIGH_PCT = 0.995;
function stretchCanvas(ctx, w, h) {
	if (!w || !h) return;
	let data;
	try {
		data = ctx.getImageData(0, 0, w, h);
	} catch (e) {
		return; // tainted canvas; not worth breaking the preview over
	}
	const px = data.data;
	const hist = new Uint32Array(256);
	for (let i = 0; i < px.length; i += 4) {
		hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++;
	}
	const total = px.length / 4;
	let lo = 0, hi = 255, acc = 0;
	for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * STRETCH_LOW_PCT) { lo = v; break; } }
	acc = 0;
	for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * (1 - STRETCH_HIGH_PCT)) { hi = v; break; } }
	if (hi - lo < 8) return; // already uses the range, or there is nothing there

	const scale = 255 / (hi - lo);
	const lut = new Uint8Array(256);
	for (let v = 0; v < 256; v++) {
		lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * scale)));
	}
	for (let i = 0; i < px.length; i += 4) {
		px[i] = lut[px[i]];
		px[i + 1] = lut[px[i + 1]];
		px[i + 2] = lut[px[i + 2]];
	}
	ctx.putImageData(data, 0, 0);
}

function drawImageOnCanvas(canvas, blob, afterDraw = null, opts = {}) {
  const ctx = canvas.getContext('2d');
  createImageBitmap(blob).then(img => {
    // Scale to half size, but ensure a minimum display size
    const minSize = opts.minSize || 120;
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
    // Stretch before the overlay, never after: the overlay's colours are
    // chosen from design tokens and must not be rescaled with the image.
    if (opts.stretch) stretchCanvas(ctx, canvas.width, canvas.height);
    if (afterDraw) afterDraw(ctx, scale, img);
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
	/* Run steps under the progress bar. */
	.stage-steps {
		list-style: none;
		margin: 20px 0 0;
		padding: 0;
		border-top: 1px solid var(--eise-panel-line);
	}
	.stage-step {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 11px 0;
		border-bottom: 1px solid var(--eise-panel-line);
		font-size: 14px;
		color: #5d7580;
	}
	.stage-step.active {
		color: #ffffff;
		font-weight: 500;
	}
	.stage-step.done {
		color: #8fa9b1;
	}
	.step-dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		box-sizing: border-box;
		border: 1px solid rgba(255, 255, 255, 0.22);
	}
	.stage-step.active .step-dot {
		background: var(--eise-gilt);
		border: none;
	}
	.stage-step.done .step-dot {
		background: #5f9e7a;
		border: none;
	}
	.step-name {
		flex: 1;
	}
	.step-meta {
		font-family: var(--eise-mono);
		font-size: 12px;
		color: #5d7580;
	}
	.stage-step.active .step-meta,
	.stage-step.done .step-meta {
		color: #8fa9b1;
	}
	/* .cancel-btn itself now lives in app.vue, shared with the stack panel and
	   the continuous run so all three stop buttons read the same. */
	.preview-frames-row {
		display: flex;
		gap: 24px;
		justify-content: flex-start;
		flex-wrap: wrap;
	}
	.preview-frame {
		margin-bottom: 24px;
		min-width: 0;
	}
	.preview-label {
		margin: 0 0 12px 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--eise-label);
	}
	.preview-frame canvas {
		max-width: 100%;
		background: #000000;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		box-shadow: 0 12px 44px rgba(0, 0, 0, 0.45);
	}
	.ap-review-bar {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 12px;
		padding: 10px 14px;
		border: 1px solid rgba(217, 169, 74, 0.35);
		border-radius: 8px;
		background: rgba(217, 169, 74, 0.08);
		font-size: 14px;
		color: var(--eise-body);
	}
	.ap-review-field {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--eise-body);
	}
	.ap-review-field .number-input {
		width: 70px;
	}
	.ap-review-status {
		color: var(--eise-label);
		font-style: italic;
	}
	.ap-review-continue {
		padding: 6px 14px;
		border: 1px solid rgba(217, 169, 74, 0.5);
		border-radius: 6px;
		background: transparent;
		font-size: 14px;
		font-weight: 600;
		color: var(--eise-gilt);
		cursor: pointer;
	}
	.ap-review-continue:hover {
		background: rgba(217, 169, 74, 0.14);
	}
	.preview-placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		width: 100%;
		max-width: 900px;
		aspect-ratio: 4 / 3;
		border: 1px dashed rgba(255, 255, 255, 0.18);
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.16);
		font-size: 14px;
		color: #6b8792;
	}
	.sharpness-label, .frame-stats {
		margin: 10px 0 0 0;
		font-family: var(--eise-mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--eise-muted);
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
	.processing-actions {
		padding-top: 0;
		padding-bottom: 22px;
	}
	.processing-hint {
		margin: 12px 0 0 0;
		font-size: 12px;
		line-height: 1.55;
		color: #8fa9b1;
		text-wrap: pretty;
	}
	.skipped-info {
		background: rgba(217, 169, 74, 0.08);
		border: 1px solid rgba(217, 169, 74, 0.25);
		color: var(--eise-body);
	}
	/* Side-by-side grayscale/color preview */
	.dual-preview {
		min-width: 500px;
	}
	/* Left-aligned, not centred: the two canvases are different widths, so
	   centring each one made the pair drift sideways as the crop changed. */
	.dual-canvas-row {
		display: flex;
		gap: 15px;
		justify-content: flex-start;
		align-items: flex-start;
	}
	.canvas-wrapper {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}
	.canvas-label {
		font-size: 11px;
		color: var(--eise-label);
		margin-bottom: 5px;
	}
</style>
