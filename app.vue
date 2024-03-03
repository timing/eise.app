<template>
	<div>
		<header>
			<div class="info">8bit</div>
			<h1>PICS - Planetary Image Cloud Stacker</h1>
		</header>
		<nav class="tabs">
			<button :class="{ active: currentTab === 'FileUploader' }" @click="currentTab = 'FileUploader'">📁 Upload File(s)</button>
			<button :class="{ active: currentTab === 'VideoFrameProcessor' }" @click="currentTab = 'VideoFrameProcessor'">🎞️ Process Frames</button>
			<button :class="{ active: currentTab === 'PostProcessor' }" @click="currentTab = 'PostProcessor'">✨ Post Process</button>	
		</nav>

		<FileUploader v-show="currentTab === 'FileUploader'" @frames="handleFrames" @postProcessing="handlePostProcessing" />
		<VideoFrameProcessor v-show="currentTab === 'VideoFrameProcessor'" :frames="frames" @postProcessing="handlePostProcessing" />
		<PostProcessor v-show="currentTab === 'PostProcessor'" :file="selectedFile" />
		<Logger />
		<div style="display:none;">
			Stacking job in the cloud powered by <a href="https://m.do.co/c/5d8cf0a2f4b6">Digital Ocean</a> (get $200 in credits if you use this link).
		</div>
	</div>
</template>

<script setup>
import FileUploader from '~/components/FileUploader.vue';
import VideoFrameProcessor from './components/VideoFrameProcessor.vue';
import PostProcessor from './components/PostProcessor.vue';
import Logger from './components/Logger.vue';
import { ref } from 'vue';

const frames = ref(null);
const selectedFile = ref(null);
const currentTab = ref('FileUploader');

async function handleFrames(data) {
	frames.value = data; 
	currentTab.value = 'VideoFrameProcessor'
}

async function handlePostProcessing(data) {
	console.log('handlePostProcessing', data);
	currentTab.value = 'PostProcessor';
	selectedFile.value = data; 
}
</script>

<style>
html,body {
	padding: 0;
	margin: 0;
	font-family: Verdana, Arial, sans-serif;
	font-size: 12px;
}
header {
	background: #0A2940;	
	padding: 0 10px;
}
header h1 {
	margin: 0;
	font-size: 18px;
	line-height: 50px;
	color: white; 
}
header .info {
	float: right;
	color: #8CCF7E;
	line-height: 50px;
	padding-right: 10px;
}
.tabs {
	padding: 10px 0 0 80px;
	background: #4A90E2;
}
button {
	background-color: #004488; 
	border: none;
	color: #A0E8A0; 
	padding: 10px 20px;
	cursor: pointer;
	transition: background-color 0.3s;
	border-radius: 5px;
}
.tabs button {
	border-radius: 5px 5px 0 0;
	margin-right: 5px;
}
.tabs button:hover {
	background-color: #003366; 
}
.tabs button.active {
	background-color: #001122; 
	color: white;
}
canvas {
	display: block; 
	border: 2px solid white;
	width: auto;
	height: auto;
}
</style>
