<template>
	<div>
		<header>
			<div class="info" title="This tool is in development, and the URL might not work in the future.">DEVELOPMENT</div>
			<h1>PICS - Planetary Image Cloud Stacker</h1>
		</header>

		<LoadingIndicator />

		<nav class="tabs">
			<button :class="{ active: currentTab === 'FileUploader' }" @click="currentTab = 'FileUploader'">📁 Upload File(s)</button>
			<button :class="{ active: currentTab === 'VideoFrameProcessor' }" @click="currentTab = 'VideoFrameProcessor'">🎞️ Analyze Frames</button>
			<button :class="{ active: currentTab === 'PostProcessor' }" @click="currentTab = 'PostProcessor'">✨ Post Process</button>	
			<button :class="{ active: currentTab === 'About' }" style="float:right;" @click="currentTab = 'About'">ℹ️  About</button>	
		</nav>

		<div v-show="currentTab === 'About'" class="content">
			<h2>About PICS - Planetary Image Cloud Stacker</h2>
			<p>PICS is the first web-based online planetary image stacking tool available in the solar system. 
			The main reason for developing yet another application for stacking is because of recent frustrations I had getting software running on my ARM based macbook. 
			AutoStakkert4! didn't work in Wine, Planetary System Stacker by Rolf Hempel had python dependency issues, Lynkeos was slow with a very wonky UI and crashed continuously.
			</p>
			<p>
			As a web developer, I saw an opportunity to make something simpler that works directly in your browser, regardless of your operating system. 
			Initially, I thought about doing all the processing on a server, but that would be expensive and not scalable.
			Instead, PICS does a chunk of the work in your browser using WebAssembly and WebWorkers, which turns out to be quite fast, and it just works (hopefully!) by navigating to this website!
			</p>
			<p>
			Currently PICS works as follows:
			</p>
			<ul>
				<li>The astrophotographer selects a video file from their machine.</li>
				<li>FFmpeg.js is used to extract frames from the video file.</li>
				<li>PICS starts ranking up to 2k frames of the video based on sharpness.</li>
				<li>The best 30% (with a max of 300) frames are uploaded to a VPS powered by 
					<a target="_blank" href="https://m.do.co/c/5d8cf0a2f4b6" title="get $200 in credits if you use this link">Digital Ocean</a>.</li>
				<li>On the server a slightly modified <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> (by Rolf Hempel) is stacking all frames it receives.</li>
				<li>The server returns the stacked image to the browser.</li>
				<li>A very basic post processor is opened, providing Wavelets sharpening, and some noise reduction. Code is from OpenCV and a GIMP plugin compiled to WebAssembly using emscripten.</li>
			</ul>
			<p>In essence, PICS is a blend of PSS's stacking capabilities combined with browser-based frame ranking and (post) processing.</p>
			<p>I hope this web-app will improve your astrophotography workflow.</p>
			<p>Happy Stacking,<br/> Tijmen</p>
		</div>

		<FileUploader v-show="currentTab === 'FileUploader'" @frames="handleFrames" @postProcessing="handlePostProcessing" />
		<VideoFrameProcessor ref="videoProcessorRef" v-show="currentTab === 'VideoFrameProcessor'" 
			:currentFrame="currentFrame" :frames="frames" @postProcessing="handlePostProcessing" />
		<PostProcessor v-show="currentTab === 'PostProcessor'" :file="selectedFile" />
		<Logger />

		<img v-if="loadPixel" src="https://analytics.tijmentiming.workers.dev/pixel.gif"/>
	</div>
</template>

<script setup>
import FileUploader from '~/components/FileUploader.vue';
import VideoFrameProcessor from './components/VideoFrameProcessor.vue';
import PostProcessor from './components/PostProcessor.vue';
import Logger from './components/Logger.vue';
import { ref } from 'vue';


const frames = ref([]);
const currentFrame = ref(null);
const selectedFile = ref(null);
const currentTab = ref('FileUploader');
const videoProcessorRef = ref(null);

const loadPixel = ref(false)

onMounted(() => {
	loadPixel.value = true
});

async function handleFrames(data) {
	frames.value = data; 
	currentTab.value = 'VideoFrameProcessor'
}

async function handleSingleFrame(data, index, frameCount){
	currentFrame.value = data;
	currentTab.value = 'VideoFrameProcessor'

	if( index >= frameCount -1 ){
		videoProcessorRef.value.filterAndStack();
	}
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
	color: #111;
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
button:hover {
	background-color: #003366; 
}
.tabs button.active {
	background-color: #001122; 
	color: white;
}
.content {
	max-width: 500px;
	margin: 0 auto;
	padding: 0 5px;
	line-height: 1.5;
}
canvas {
	display: block; 
	border: 2px solid white;
	width: auto;
	height: auto;
}
</style>
