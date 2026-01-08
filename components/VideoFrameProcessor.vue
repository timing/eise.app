<template>
	<div>
		<div class="card">
			<LoadingIndicator />

			<div v-if="uploadError" class="error-message">
				<p>Error: {{ uploadError }}</p>
			</div>

			<div class="separator"></div>

			<div v-if="processingStage === 'analyzing'">
				<table>
					<tr><td>Amount analyzed</td><td>{{ allFramesCount }}</td></tr>
					<tr><td>Amount of best frames</td><td>{{ bestFramesCount }}</td></tr>
				</table>
			</div>
		</div>

		<div class="content" v-if="processingStage === 'analyzing'">
			<h4>Top 4 Sharpest Frames</h4>
			<div class="frame-container">
			  <canvas v-for="(frame, index) in topFrames" :key="'top-' + index" :ref="el => canvases.top[index] = el"></canvas>
			</div>
			<h4>Worst Frame</h4>
			<div class="frame-container">
			  <canvas v-if="worstFrame" :ref="el => canvases.worst = el"></canvas>
			</div>
		</div>
	</div>
</template>

<script setup>
import { onMounted, ref, watch, defineProps, onBeforeUpdate, nextTick } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

const { on, addLog, emit } = useEventBus();
const { uploadFrames } = useUploader();

const { $ffmpeg } = useNuxtApp();

const props = defineProps({
	frames: Array
});

const bestFramesCount = ref(0);
const allFramesCount = ref(0);
const processingStage = ref('importing'); // Will be 'importing' initially, then 'analyzing'
const uploadError = ref(null); // New ref for upload errors

const topFrames = ref([]);
const worstFrame = ref(null);
const canvases = ref({ top: [], worst: null });

let unifiedAnalyzeWorkers = new Array((navigator && navigator.hardwareConcurrency) || 4);

// Define bestFramesForStacking outside processImageFrames to persist state across calls/worker responses
const bestFramesForStacking = []; // These will store {sharpness, blob}

// Define rankFrame outside processImageFrames so it can be used by worker message listener
function rankFrame(frame) {
	// Update top 4 frames
	if (topFrames.value.length < 4) {
		topFrames.value.push(frame);
		topFrames.value.sort((a, b) => b.sharpness - a.sharpness);
	} else if (frame.sharpness > topFrames.value[3].sharpness) {
		topFrames.value.pop();
		topFrames.value.push(frame);
		topFrames.value.sort((a, b) => b.sharpness - a.sharpness);
	}

	// Update worst frame
	if (worstFrame.value === null || frame.sharpness < worstFrame.value.sharpness) {
		worstFrame.value = frame;
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
}


onMounted(() => {	
	for (let i = 0; i < unifiedAnalyzeWorkers.length; i++) {
		unifiedAnalyzeWorkers[i] = new Worker('/unified_analyze_worker.js', {type: 'module'});
		unifiedAnalyzeWorkers[i].onerror = (e) => { console.error(e); };
	}

	if (props.frames && props.frames.length > 0) {
		uploadError.value = null; // Reset error
		processingStage.value = 'analyzing';
		emit('set-caption', 'Analyzing frames');
		processImageFrames(props.frames);
	}

	on('ser-frames-updated', ({ top, worst }) => {
		if (processingStage.value !== 'analyzing') {
			uploadError.value = null; // Reset error
			processingStage.value = 'analyzing';
			emit('set-caption', 'Analyzing frames');
		}
		topFrames.value = top;
		worstFrame.value = worst;
		updateCanvases();
  	});

	on('upload-error', (message) => {
		uploadError.value = message;
		emit('stop-loading'); // Stop loading on error
	});
});

watch(() => props.frames, (newVal) => {
	if (newVal && newVal.length > 0) {
		uploadError.value = null; // Reset error
		processingStage.value = 'analyzing';
		processImageFrames(newVal);
	}
});

onBeforeUpdate(() => {
  canvases.value = { top: [], worst: null };
});

function updateCanvases() {
  nextTick(() => {
    topFrames.value.forEach((frame, index) => {
      const canvas = canvases.value.top[index];
      if (canvas) {
        const blob = frame instanceof Blob ? frame : frame.blob;
        drawImageOnCanvas(canvas, blob);
      }
    });

    if (worstFrame.value && canvases.value.worst) {
      const blob = worstFrame.value instanceof Blob ? worstFrame.value : worstFrame.value.blob;
      drawImageOnCanvas(canvases.value.worst, blob);
    }
  });
}

function drawImageOnCanvas(canvas, blob) {
  const ctx = canvas.getContext('2d');
  createImageBitmap(blob).then(img => {
    canvas.width = img.width / 2;
    canvas.height = img.height / 2;
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

	emit('set-caption', 'Analyzing frames'); // LoadingIndicator will display this caption

	bestFramesCapacity = Math.floor(files.length * 0.3); // Set here


	const usedFFmpeg = typeof files[0] === 'string';

	const resolveFunctions = new Array(files.length);
	const rejectFunctions = new Array(files.length);
	const filesMap = new Array(files.length); 

	for (let i = 0; i < unifiedAnalyzeWorkers.length; i++) {
		unifiedAnalyzeWorkers[i].addEventListener('message', (e) => {
			const index = e.data.index;
			const pngFile = filesMap[index];

			allFramesCount.value++;
            emit('update-loading', (allFramesCount.value / files.length) * 100);


			if(e.data.frameData !== undefined) {
				if(!e.data.frameData.is_cut_off) {
					console.log(`VideoFrameProcessor: Constructing Blob for rendering. pngFile[0] byteLength: ${pngFile[0]?.byteLength}`);
					const currentFrame = {sharpness: e.data.frameData.sharpness, blob: new Blob([pngFile[0]], { type: 'image/png' })};
					rankFrame(currentFrame);
					if (index % 10 === 0 || index === files.length - 1) {
						updateCanvases();
					}
				}
				resolveFunctions[index]();
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
					data = [$ffmpeg.FS('readFile', file)];
					console.log(`VideoFrameProcessor: Read FFmpeg file ${file} (index ${index}). Data undefined: ${data[0] === undefined}, byteLength: ${data[0]?.byteLength}`);
					$ffmpeg.FS('unlink', file);
				} else {
					data = [new Uint8Array(await file.arrayBuffer())];
				}
				filesMap[index] = data;
				// Post message to unified worker
				const analyzeDataForWorker = filesMap[index][0].slice(); // Create a new Uint8Array copy
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

    await uploadFrames(bestFramesForStacking.map(f => ({ pngFile: [f.blob] })));
}
</script>

<style scoped>
	.frame-container {
	  display: flex;
	  gap: 10px;
	  margin-bottom: 20px;
	  flex-wrap: wrap;
	}
	canvas {
	  border: 1px solid #ccc;
	  max-width: 100%;
	}
	table {
		border-collapse: collapse;
	}
	table td {
		border: 1px solid #eee;
		padding: 5px;
	}
	table td:first-child {
		padding-right: 10px;
	}
	table td:last-child {
		min-width: 60px;
		text-align: right;
	}
	.error-message {
		background-color: #ffcccc;
		color: #cc0000;
		padding: 10px;
		margin-top: 10px;
		border-radius: 5px;
		font-weight: bold;
	}
</style>
