<template>
	<div>
		<canvas ref="canvasRef"></canvas>
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

onMounted(() => {
	if (props.frames) {
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

	const ctx = canvasRef.value.getContext('2d', {willReadFrequently: true});
	
	const promises = [];	

	const frames = new Array(files.length).fill().map(() => ({}));

	const bestFramesCapacity = Math.min(300, Math.ceil(files.length * 0.3));
	const bestFrames = [];

	function addFrameToBest(frame) {
		if (bestFrames.length < bestFramesCapacity) {
			bestFrames.push(frame);
		} else {
			// Find the least sharp frame
			let minSharpnessIndex = bestFrames.reduce((minIdx, currFrame, idx, arr) => 
				(currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);
				
			if (frame.sharpness > bestFrames[minSharpnessIndex].sharpness) {
				bestFrames[minSharpnessIndex] = frame; // Replace the least sharp frame
			}
		}
	}	

	for( const [index, file] of files.entries() ){	

		const promise = new Promise((resolve, reject) => {

			const blob = new Blob([$ffmpeg.FS('readFile', file)], { type: 'image/png' });
			$ffmpeg.FS('unlink', file); 

			const url = URL.createObjectURL(blob);
			const img = new Image();

			img.onload = () => {
				canvasRef.value.width = img.width;
				canvasRef.value.height = img.height;
				//ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);
				ctx.drawImage(img, 0, 0);

				const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height)

				const frameData = { sharpness: calculateSharpness(imageData), pngBlob: blob };

				if( !isImageCutOff(imageData) ){ 
					addFrameToBest(frameData);
				}
				//frameData.center_of_gravity = calculateCenterOfGravity(imageData);

				addLog('Frame ' + index + '. Sharpness:' + frameData.sharpness + ', isCutOff:' + frameData.isCutOff + ', CoG: '
					// + frameData.center_of_gravity.x + ',' + frameData.center_of_gravity.x	
				);	

				URL.revokeObjectURL(url); // Clean up the object URL after drawing the image

				resolve(); 
			};
			img.src = url;

		});

		promises.push(promise); // Add the promise to the array
	}

	await Promise.all(promises); // Wait for all frame processing promises to resolve

	const formData = new FormData();

	const imageIdentifier = Math.round(Math.random() * 10000);

	console.log(bestFrames);

	for( const s in bestFrames ){
		formData.append('imageFiles', bestFrames[s].pngBlob, `${imageIdentifier}-${s}.png`);
	}

	const host = 'https://cloud-stacker.playli.be'
	//const host = 'http://142.93.131.136:8080'
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
		emit('postProcessing', new Blob([blob]));	
	});
	
	addLog('Uploading best frames to server, for stacking with Planetary System Stacker (see about)');
	fetch(host + '/upload', {
		method: 'POST',
		body: formData
	})
	.then(response => response.json())
	.then(data => console.log(data))
	.catch(error => console.error('Error:', error));
}

</script>

<style>
	canvas {
	
	}
</style>
