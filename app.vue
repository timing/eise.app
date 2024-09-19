<template>
	<div>	
		<nav class="tabs">
			<button :class="{ active: currentTab === 'FileUploader' }" @click="currentTab = 'FileUploader'">📁 &nbsp; Upload File(s)</button>
			<button :class="{ active: currentTab === 'VideoFrameProcessor' }" @click="currentTab = 'VideoFrameProcessor'">🎞️ &nbsp; Analyze Frames</button>
			<button :class="{ active: currentTab === 'PostProcessor' }" @click="currentTab = 'PostProcessor'">✨ &nbsp; Post Process</button>	
			<button :class="{ active: currentTab === 'About' }" style="float:right;" @click="currentTab = 'About'">ℹ️  &nbsp; About</button>	
		</nav>

		<header>
			<h1><a href="/">eise.app</a> <span class="subtitle">- Easy (planetary) Image Stacker Engine</span></h1>
		</header>

		<div v-show="currentTab === 'About'">
			<div class="card">
				<img src="/public/EiseApp-NoCopyright-L.webp" width="260" />
			</div>
			<div class="content">
			<h2>About eise.app - Planetary Image Cloud Stacker</h2>
			<h3>Perfect for beginners in Astrophotography</h3>
			<p>eise.app is the first web-based online planetary image stacking tool available in the solar system. 
			The name is an ode to Eise Eisinga, a Frisian amateur astronomer who built a planetarium in his house. 
			The main reason for developing yet another application for stacking is because of recent frustrations I had getting software running on my ARM based macbook. 
			AutoStakkert4! didn't work in Wine, Planetary System Stacker by Rolf Hempel had python dependency issues, Lynkeos was slow with a very wonky UI and crashed continuously.
			</p>
			<p>
			As a web developer, I saw an opportunity to make something simpler that works directly in your browser, regardless of your operating system. 
			Initially, I thought about doing all the processing on a server, but that would be expensive and not scalable.
			Instead, eise.app does a chunk of the work in your browser using WebAssembly and WebWorkers, which turns out to be quite fast, and it just works (hopefully!) by navigating to this website!
			</p>
			<p>
			Currently eise.app works as follows:
			</p>
			<ul>
				<li>The astrophotographer selects a video file from their machine.</li>
				<li>FFmpeg.js is used to extract frames from the video file.</li>
				<li>eise.app starts ranking (up to 5k) frames of the video based on sharpness.</li>
				<li>The best 30% of frames are uploaded to a VPS powered by 
					<a target="_blank" href="https://m.do.co/c/5d8cf0a2f4b6" title="get $200 in credits if you use this link">Digital Ocean</a>.</li>
				<li>On the server a slightly modified <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> (by Rolf Hempel) is stacking all frames it receives.</li>
				<li>The server returns the stacked image to the browser.</li>
				<li>A very basic post processor is opened, providing Wavelets sharpening, some noise reduction and color alignment. 
					Code is from OpenCV and a <a href="https://github.com/mrossini-ethz/gimp-wavelet-sharpen/blob/master/src/wavelet.c" target="_blank">GIMP plugin</a> compiled to WebAssembly using emscripten.</li>
			</ul>
			<p>In essence, eise.app is a blend of Planetary System Stacker's capabilities combined with browser-based frame ranking and (post) processing.</p>
			<p>I hope this web-app will improve your astrophotography workflow, or helps beginners not giving up when trying to set-up their software.</p>
			<p>Happy Stacking,<br/> Tijmen</p>
			</div>
		</div>
	
		<FileUploader v-show="currentTab === 'FileUploader'" @frames="handleFrames" @postProcessing="handlePostProcessing" @analyzeVideo="handleAnalyzeVideo" />
		<VideoFrameProcessor v-show="currentTab === 'VideoFrameProcessor'" :maxFrames="maxFrames" :selectedFile="selectedFile" :frames="frames" @postProcessing="handlePostProcessing" />
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
const selectedFile = ref(null);
const currentTab = ref('FileUploader');
const maxFrames = ref(1000);

const loadPixel = ref(false)

onMounted(() => {
	loadPixel.value = true
});

async function handleFrames(data) {
	frames.value = data; 
	currentTab.value = 'VideoFrameProcessor'
}

async function handleAnalyzeVideo(data, maxFramesSel) {
	selectedFile.value = data;
	maxFrames.value = maxFramesSel;
	currentTab.value = 'VideoFrameProcessor'
}

async function handlePostProcessing(data) {
	console.log('handlePostProcessing', data);
	currentTab.value = 'PostProcessor';
	selectedFile.value = data; 
}

useHead({
  title: 'eise.app - Easy (planetary) Image Stacker in your browser for your Astrophotography',
  // Overview Effect
  meta: [
    { name: 'description', content: 'Easy (planetary) Image Stacker Engine, made to work in your browser. Turn your blurry videos of planets into sharp images. Perfect for beginners in Astrophotography. Using Planetary System Stacker under the hood.' },
  ],
});

</script>

<style>
html,body {
	padding: 0;
	margin: 0;
	font-family: -apple-system,\.SFNSText-Regular,San Francisco,Roboto,Segoe UI,Helvetica Neue,Lucida Grande,sans-serif;
	/*font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;*/
	font-size: 13px;
	-moz-osx-font-smoothing: grayscale;
	-webkit-font-smoothing: antialiased;
	-webkit-min-device-pixel-ratio: 1.5;
	color: #c6fffd;
	min-height: 100%;
}
html {
	background: radial-gradient(circle at bottom, #27587c, #0A2940);
}
.content a, .content a:visited {
	color: inherit;
}
body {
	padding-bottom: 80px;
}
header {
	padding: 0 10px;
}
header h1 {
	margin: 0;
	font-size: 18px;
	line-height: 50px;
	color: white; 
}
header .subtitle {
	font-size: 12px;
	font-weight: normal;
}
header .info {
	float: right;
	color: #8CCF7E;
	line-height: 50px;
	padding-right: 10px;
}
header a {
	color: #8CCF7E;
	text-decoration: none;
}
.tabs {
	float: right;
	border-radius: 5px;
	margin: 10px 10px 0 0;
	overflow: hidden;
}
button, a.button {
	background-color: #eee; 
	border: none;
	color: #333; 
	padding: 10px 20px;
	cursor: pointer;
	transition: background-color 0.3s;
	border-radius: 5px;
	text-decoration: none;
	font-size: 13px;
}
.tabs button, .tabs a.button {
	border-radius: 0;
	border-right: 1px solid #ccc;
	font-weight:bold;
}
button:hover, a.button:hover {
	background-color: #70f1ec; 
}
.tabs button.active, .tabs a.button.active {
	background-color: #8CCF7E; 
	color: #111;
}
.content {
	max-width: 500px;
	padding: 5px 5px 5px 50px;
	line-height: 1.5;
	clear:both;
}
@media (min-width: 728px) {
	.content {
		clear: none;
		margin-left: 370px;
		padding-top: 50px;
	}
}
canvas {
	display: block; 
	width: auto;
	height: auto;
}
.card {
	background-color: #fefefe;
	color: #333;
	border: 1px solid #ddd;
	border-radius: 10px;
	margin: 50px;
	padding: 10px 20px 20px 20px;
	width: 272px;
	min-height: 340px;
	float: left;
}
.separator {
	border-top: 1px solid #ddd;
	margin: 10px 0;
}
.card .separator {
	margin-left: -20px;
	margin-right: -20px;
}
.card h4 {
	margin-bottom: 0;
}
</style>
