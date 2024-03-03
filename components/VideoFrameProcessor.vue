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

async function processImageFrames(frames) {
	if (!canvasRef.value) return;

	const ctx = canvasRef.value.getContext('2d', {willReadFrequently: true});

	const promises = [];

	let bestFrame = 0;

	for( const frame in frames ){

		const promise = new Promise((resolve, reject) => {

			const frameData = frames[frame].data;
			const blob = new Blob([frameData], { type: 'image/png' });
			frames[frame].pngBlob = blob;
			const url = URL.createObjectURL(blob);
			const img = new Image();

			img.onload = () => {
				canvasRef.value.width = img.width;
				canvasRef.value.height = img.height;
				//ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);
				ctx.drawImage(img, 0, 0);

				const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height)
				frames[frame].sharpness = calculateSharpness(imageData);
				frames[frame].isCutOff = isImageCutOff(imageData);
				frames[frame].center_of_gravity = calculateCenterOfGravity(imageData);

				frames[frame].data = null;
		
				addLog('Frame ' + frame + '. Sharpness:' + frames[frame].sharpness + ', isCutOff:' + frames[frame].isCutOff + ', CoG: ' + 
					frames[frame].center_of_gravity.x + ',' + frames[frame].center_of_gravity.x  );
				
				if( frames[frame].sharpness > frames[bestFrame].sharpness ){
					bestFrame = frame;
				}

				URL.revokeObjectURL(url); // Clean up the object URL after drawing the image

				resolve(); 
			};
			img.src = url;

		});

		promises.push(promise); // Add the promise to the array
	}

	await Promise.all(promises); // Wait for all frame processing promises to resolve

	const sharpestFrames = filterSharpestFrames(frames, 30);

	const formData = new FormData();

	const imageIdentifier = Math.round(Math.random() * 10000);

	for( const s in sharpestFrames ){
		formData.append('imageFiles', sharpestFrames[s].pngBlob, `${imageIdentifier}-${s}.png`);
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

function filterSharpestFrames(frames, percentage){
	frames.sort((a, b) => b.sharpness - a.sharpness);

	frames = frames.filter(frame => !frame.isCutOff);

	// Calculate the number of sharpest frames to select
	const numSharpest = Math.ceil(frames.length * (percentage / 100));

	return frames.slice(0, numSharpest);
}

</script>

<style>
	canvas {
	
	}
</style>
