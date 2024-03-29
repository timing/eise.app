<template>
	<div>
		<div class="card">
			<h3>Analyzing frames..</h3>	
			<LoadingIndicator />
		</div>

		<div class="content">
			<div v-if="props.frames && props.frames.length === 0">
				<h2>Nothing loaded yet</h2>
				<p>To get started, please upload a video or bunch of files for analyzing and stacking.</p>
			</div>
			<div v-else>
				<h4>Analyzing frames</h4>
				<p>Found {{ bestFramesCount }} best frames. Which will be uploaded for stacking.</p>
			</div>
			<canvas id="analyzeCanvas" ref="canvasRef"></canvas>

		</div>
	</div>
</template>

<script setup>
import { onMounted, ref, watch, defineProps, defineEmits } from 'vue';
import { calculateSharpness, isImageCutOff, calculateCenterOfGravity } from '@/utils/sobel.js'
import { io } from "socket.io-client";
import { useEventBus } from '@/composables/eventBus';

const { addLog } = useEventBus();

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const emit = defineEmits(['postProcessing']);

const props = defineProps({
	frames: Array
});
const canvasRef = ref(null);
const bestFramesCount = ref(0);

let analyzeWorkers = new Array(12);

onMounted(() => {	
	for (let i = 0; i < analyzeWorkers.length; i++) {
		analyzeWorkers[i] = new Worker('/analyze_worker.js', {type: 'module'});
		analyzeWorkers[i].onerror = (e) => { console.error(e); };
	}

	if (props.frames.length > 0) {
		processImageFrames(props.frames);
	}

});


watch(() => props.frames, (newVal) => {
	if (newVal) {
		processImageFrames(newVal);
	}
});

async function processImageFrames(files) {
	if (!canvasRef.value) return;

	useEventBus().emit('start-loading');

	const ctx = canvasRef.value.getContext('2d', {willReadFrequently: true});

	const frames = new Array(files.length).fill().map(() => ({}));

	const bestFramesCapacity = files.length * 0.3;
	const bestFrames = [];
	let highestSharpness = 0;

	function addFrameToBest(frame) {
		if (bestFrames.length < bestFramesCapacity) {
			if (frame.sharpness > highestSharpness) {
				highestSharpness = frame.sharpness;
				updateCanvasWithFrame(frame);
			}
			bestFrames.push(frame);
		} else {
			// Find the least sharp frame
			let minSharpnessIndex = bestFrames.reduce((minIdx, currFrame, idx, arr) => 
				(currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);
				
			if (frame.sharpness > bestFrames[minSharpnessIndex].sharpness) {
				bestFrames[minSharpnessIndex] = frame; 
				if (frame.sharpness > highestSharpness) {
					highestSharpness = frame.sharpness;
					updateCanvasWithFrame(frame);
				}
			}
		}
		bestFramesCount.value = bestFrames.length;
	}	

	function updateCanvasWithFrame(frame) {
		createImageBitmap(new Blob(frame.pngFile, {type: 'image/png'})).then(img => {
			canvasRef.value.width = img.width;
			canvasRef.value.height = img.height;
			ctx.drawImage(img, 0, 0);
		});
	}

	// Initialize an array to hold the resolve functions
	const resolveFunctions = new Array(files.length);
	const rejectFunctions = new Array(files.length);
	const filesMap = new Array(files.length); // Array to store blobs

	addLog('Analyzing all frames for sharpness');

	for (let i = 0; i < analyzeWorkers.length; i++) {
		analyzeWorkers[i].addEventListener('message', (e) => {
			const index = e.data.index; // Assuming the worker sends back the index
			const pngFile = filesMap[index]; // Retrieve the blob using the index

			if(e.data.frameData !== undefined) {
				//console.log(index, e.data);
				if(e.data.frameData.is_cut_off) {
					//addLog(`Frame skipped (cut off) ${index}. Sharpness: ${e.data.frameData.sharpness}`);
				} else {
					addFrameToBest({sharpness: e.data.frameData.sharpness, pngFile: pngFile});
					//addLog(`Frame ${index}. Sharpness: ${e.data.frameData.sharpness}`);
				}
				//useEventBus().emit('update-loading', index / files.length * 100);
				resolveFunctions[index](); // Resolve the promise for this index
			} else {
				rejectFunctions[index](new Error("Processing failed.")); // Reject the promise for this index
			}
		});
	}

	const promises = files.map((file, index) => {
		return new Promise((resolve, reject) => {
			// Store the resolve and reject functions for later access
			resolveFunctions[index] = resolve;
			rejectFunctions[index] = reject;

			// this is a timeout to give the UI some slack and be able to update. preferably we run this whole thing in another worker as well
			setTimeout(() => {
				filesMap[index] = [$ffmpeg.FS('readFile', file)];
				analyzeWorkers[index % 12].postMessage({analyze: filesMap[index], index: index});
				//addLog('Cleaning up memory, deleting frame ' + index);
				$ffmpeg.FS('unlink', file);
			}, 10);
		});
	});

	await Promise.all(promises); // Wait for all the promises to resolve

	addLog('Done analyzing frames. Cleaning up');
	try {
		$ffmpeg.exit();
	} catch(e) {
		
	}
	addLog('Cleaning up done');


	const formData = new FormData();

	const imageIdentifier = Math.round(Math.random() * 10000);

	if( bestFrames.length == 0 ){
		addLog('No frames to stack.');
		useEventBus().emit('stop-loading');
		return false;
	}

	for( const s in bestFrames ){
		formData.append('imageFiles', new Blob(bestFrames[s].pngFile, {type: 'image/png'}), `${imageIdentifier}-${s}.png`);
	}

	const host = 'https://stack.eise.app'
	const jobId = crypto.randomUUID();
	formData.append('job_id', jobId)

	const wsUrl = host

	const ws = io(wsUrl);

	ws.on('connect', () => {
		console.log('Connected to server');
		// Join a room
		ws.emit('join', {room: jobId});
	});

	ws.on('console_output', (data) => {
		addLog(data.data);
		console.log('Console output', data);
	});

	ws.on('finished', (data) => {
		console.log('Processing finished, image URL:', data.image_url);
	});

	ws.on('image_data', (blob) => {
		addLog('Server side stack finished, loading post processing.');
		useEventBus().emit('stop-loading');
		emit('postProcessing', new Blob([blob]));	
	});

	useEventBus().emit('start-loading');
	
	addLog('Uploading best frames to server, for stacking with Planetary System Stacker (see about)');

	// Use XMLHttpRequest for uploads, because fetch does not allow progress bars
	const xhr = new XMLHttpRequest();
	xhr.open('POST', `${host}/upload`, true);

	xhr.upload.onprogress = function(event) {
		if( !event.lengthComputable ){
			return;
		}
		useEventBus().emit('update-loading', Math.round(event.loaded / event.total * 100));
	};

	xhr.onload = function() {
		if (xhr.status === 200 || xhr.status === 202 ) {
			const data = JSON.parse(xhr.responseText);
			useEventBus().emit('start-loading');
			addLog(data.message);
			console.log(data);
		} else {
			const error = JSON.parse(xhr.responseText);
			addLog(error.message);
			console.error('Error:', error);
		}
	};

	xhr.onerror = function() {
		addLog('Error during the upload process.');
		console.error('Error during the upload process.');
	};

	xhr.send(formData);	


	/*fetch(host + '/upload', {
		method: 'POST',
		body: formData
	})
	.then(response => response.json())
	.then(data => { addLog(data.message); console.log(data)})
	.catch(error => { addLog(error.message); console.error('Error:', error) });*/
}

</script>

<style scoped>
	canvas#analyzeCanvas {
		margin: 20px auto;
		max-width: 70%;
	}
</style>
