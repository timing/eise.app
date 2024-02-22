<template>
	<div>
		<FileUploader @frames="handleFrames" @postProcessing="handlePostProcessing" />
		<VideoFrameProcessor :frames="frames" />
		<PostProcessor :file="selectedFile" v-if="selectedFile" />
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
