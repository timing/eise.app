<template>
	<div>
		<FileUploader @frames="handleFrames" @postProcessing="handlePostProcessing" />
		<VideoFrameProcessor :frames="frames" @postProcessing="handlePostProcessing" />
		<PostProcessor :file="selectedFile" v-if="selectedFile" />
		<div>
			Stacking job in the cloud powered by <a href="https://m.do.co/c/5d8cf0a2f4b6">Digital Ocean</a> (get $200 in credits if you use this link).
		</div>
	</div>
</template>

<script setup>
import FileUploader from '~/components/FileUploader.vue';
import VideoFrameProcessor from './components/VideoFrameProcessor.vue';
import PostProcessor from './components/PostProcessor.vue';
import { ref } from 'vue';

const frames = ref(null);
const selectedFile = ref(null);

async function handleFrames(data) {
	frames.value = data; // Update the reactive variable with the new frame data
}

async function handlePostProcessing(data) {
	console.log('handlePostProcessing', data);
	selectedFile.value = data; // Update the reactive variable with the new frame data
}
</script>

<style>
.wrapper {
	max-width: 100vw;
	overflow: scroll;
	max-height: 70vh;
	border: 2px solid white;
}
canvas {
	display: block; /* Prevents inline default and allows for proper overflow handling */
	border: 2px solid white;
	width: auto;
	height: auto;
}
</style>
