<template>
	<div class="page-layout page-layout-wide">
		<div class="content">
			<h2>How to Use Eise.app - Planetary Image Stacking Guide</h2>
			<p >This guide explains how Eise.app processes your astrophotography videos and images to create sharp, detailed results.</p>

			<h3>Getting Started</h3>
			<ol>
				<li><strong>Capture your video</strong> - Use your telescope and camera to record a video of a planet, the Moon, or Sun. SER format is recommended, but AVI or MP4 also work.</li>
				<li><strong>Upload to Eise.app</strong> - Drag and drop your file onto the Stack page. Multiple SER files can be combined.</li>
				<li><strong>Wait for analysis</strong> - Eise.app analyzes each frame for sharpness and automatically crops and centers your target.</li>
				<li><strong>Select quality threshold</strong> - Choose a frame selection mode: manually set a threshold, pick a percentage, or use continuous stacking to try multiple percentages automatically.</li>
				<li><strong>Stack and process</strong> - Click "Stack" and then use the Post Processor to sharpen and enhance your result.</li>
			</ol>

			<h3>The Stacking Pipeline</h3>
			<p>Understanding what happens under the hood helps you get better results:</p>
			<ul>
				<li><strong>File support:</strong> SER files (recommended for planetary imaging), AVI (uncompressed), or any video format via FFmpeg.js</li>
				<li><strong>Frame ranking:</strong> Laplacian variance calculates sharpness for each frame. You manually select the quality threshold using a histogram graph.</li>
				<li><strong>Auto-crop:</strong> Detects and centers the target in each frame. For planets, frames where the disk is cut off are automatically rejected.</li>
				<li><strong>Surface mode:</strong> For Moon and Sun closeups, enables drift tracking to handle larger frame-to-frame motion.</li>
				<li><strong>Local alignment:</strong> Alignment Points (APs) are distributed across the frame and track local motion using template matching.</li>
				<li><strong>De-warping:</strong> Displacement maps correct atmospheric wobble using inverse distance weighted interpolation.</li>
				<li><strong>Drizzle:</strong> Creates 1.5x output resolution by using sub-pixel frame offsets.</li>
				<li><strong>Stacking:</strong> Quality-weighted averaging combines frames, with brightness normalization to handle exposure variations.</li>
			</ul>

			<h3>Frame Selection Modes</h3>
			<p>After analysis, Eise.app needs to decide which frames to stack. There are three modes:</p>
			<ul>
				<li><strong>Manual</strong> - You see a quality histogram and drag a slider to set the threshold. Best for fine-tuning.</li>
				<li><strong>Percentage</strong> - Automatically stacks the best N% of frames. Quick and simple.</li>
				<li><strong>Continuous</strong> - Stacks the same file multiple times using increasing percentages (5%, 10%, 15%, ... up to 90%). This lets you compare results and find the sweet spot between detail and noise without trial and error.</li>
			</ul>

			<h3>Batch Processing &amp; Timelapse</h3>
			<p>Batch processing is a separate feature for handling <strong>multiple files</strong>. When you select two or more SER or AVI files, Eise.app asks whether to process them separately (batch) or combine them into one stack. In batch mode, each file is stacked independently with the same settings.</p>
			<p>Batch processing and continuous stacking are independent features: batch processes multiple files, continuous explores different frame percentages on a single file.</p>
			<p>After batch stacking completes, all stacked results are loaded into the Post Processor together. Any processing you apply (wavelet sharpening, color correction, RGB alignment) is applied to all stacks at once, so your entire sequence gets consistent processing.</p>
			<p><strong>Align Stacks</strong>: In the Post Processor, use the "Align Stacks" button to align all stacked results so they match in size and position. This removes wobble and size differences between individual stacks, producing a smooth sequence ready for animation.</p>
			<p><strong>MP4 Export</strong>: Once your stacks are aligned, you can export them as an MP4 animation. This creates a timelapse video showing planetary rotation or surface changes across your imaging session.</p>
			<video src="/Jupiter_animation_full_eise_workflow.mp4" autoplay loop muted playsinline class="help-video"></video>

			<h3>Post-Processing Tips</h3>
			<ul>
				<li><strong>Start with Auto Stretch</strong> - This normalizes your image's brightness range before other adjustments.</li>
				<li><strong>Use Wavelets for detail</strong> - Wavelet sharpening brings out surface features. Start low (amount ~20-40) and increase gradually.</li>
				<li><strong>Fix RGB alignment</strong> - If you see colored fringes, use Auto RGB alignment or adjust manually.</li>
				<li><strong>Crop edges last</strong> - The edges often have stacking artifacts. Crop them away at the end.</li>
			</ul>
			<p class="tip">You can also use the <NuxtLink to="/post-processor/">post-processor</NuxtLink> directly on any image - just open a PNG or TIFF for wavelet sharpening without stacking.</p>

			<h3>Technology</h3>
			<p>Eise.app is built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any operating system without installation.</p>

			<h3>Browser Requirements</h3>
			<p>Eise.app uses WebGPU for fast GPU-accelerated stacking and image processing. Here are the minimum browser versions:</p>
			<table class="compat-table">
				<tr><th>Platform</th><th>Minimum Version</th></tr>
				<tr><td>Chrome</td><td>113+ (Android: 121+)</td></tr>
				<tr><td>Edge</td><td>113+</td></tr>
				<tr><td>Safari</td><td>18+ (macOS Sequoia / iOS 18)</td></tr>
				<tr><td>Firefox</td><td>141+ (Windows only for now)</td></tr>
				<tr><td>Android</td><td>Chrome 121+ with Android 12+</td></tr>
				<tr><td>iOS</td><td>Safari 18+ (iOS 18+)</td></tr>
			</table>
			<ClientOnly>
				<div class="compat-status" :class="{ compatible: webGPUSupported === true, incompatible: webGPUSupported === false, checking: webGPUSupported === null }">
					<strong>Your browser:</strong> {{ detectedBrowser }}<br/>
					<span v-if="webGPUSupported === null">Checking WebGPU support...</span>
					<span v-else-if="webGPUSupported">WebGPU is supported - you're good to go!</span>
					<span v-else>WebGPU not available - processing will be slower. Try updating your browser or using Chrome/Edge/Safari.</span>
				</div>
			</ClientOnly>

			<h3>Troubleshooting</h3>
			<dl>
				<dt>Stacking is slow</dt>
				<dd>Make sure you're using a browser with WebGPU support. Chrome and Edge work best. Safari 18+ also supports WebGPU.</dd>

				<dt>My planet looks blurry after stacking</dt>
				<dd>Try selecting fewer frames (lower quality threshold). Sometimes fewer sharp frames produce better results than many mediocre frames.</dd>

				<dt>The edges have artifacts</dt>
				<dd>This is normal - use the Crop tool in the Post Processor to trim the edges.</dd>

				<dt>Polygon artefacts in stacked image</dt>
				<dd>
					<p>If you see polygon or grid-like artefacts like in the image below, try increasing the <strong>AP size</strong> setting (e.g., from 30 to 50). This makes alignment patches larger and more robust for low-contrast or noisy data.</p>
					<img src="/screenshot-artefact.png" alt="Example of polygon artefacts" class="troubleshooting-image" />
					<p>Alternatively, increase the <strong>AP quality threshold</strong> (e.g., from 0.3 to 0.5) to reject uncertain alignment matches.</p>
				</dd>

				<dt>Colors look wrong</dt>
				<dd>Enable "Auto color balance" in the Post Processor, or manually adjust saturation and RGB alignment.</dd>

				<dt>Batch export "Select folder" doesn't work</dt>
				<dd>
					<p>The folder selection feature uses the File System Access API to save multiple files without prompting for each one.</p>
					<ClientOnly>
						<p v-if="isBrave" class="brave-tip">
							<strong>Brave users:</strong> This API is disabled by default. Enable it at
							<a href="brave://flags/#file-system-access-api" @click.prevent="copyBraveFlag">brave://flags/#file-system-access-api</a>
							(click to copy, then paste in address bar).
						</p>
					</ClientOnly>
					<p>If folder selection isn't available, exports will download normally with a prompt for each file.</p>
				</dd>
			</dl>

			<h3>Technical Details</h3>
			<p>Want to understand how Eise.app works under the hood? Check out the <NuxtLink to="/about/architecture/">technical architecture</NuxtLink> page with detailed pipeline diagrams and algorithm explanations.</p>

			<h3>Need more help?</h3>
			<p>Head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on GitHub</a> to ask questions or report issues.</p>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const webGPUSupported = inject('webGPUSupported');
const detectedBrowser = inject('detectedBrowser');

// Detect Brave browser
const isBrave = ref(false);
onMounted(async () => {
	// Brave exposes navigator.brave.isBrave()
	if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
		isBrave.value = await navigator.brave.isBrave();
	}
});

function copyBraveFlag() {
	navigator.clipboard.writeText('brave://flags/#file-system-access-api');
	alert('Copied! Paste this in your address bar: brave://flags/#file-system-access-api');
}

useHead({
	title: 'Help & How it Works - Eise.app Planetary Image Stacking Guide',
	meta: [
		{ name: 'description', content: 'Learn how to use Eise.app for planetary astrophotography. Step-by-step guide to stacking videos of planets, Moon, and Sun in your browser.' },
	],
});
</script>

<style scoped>
dl {
	margin: 1rem 0;
}
dt {
	font-weight: bold;
	margin-top: 1rem;
}
dd {
	margin-left: 0;
	margin-top: 0.25rem;
}
.troubleshooting-image {
	max-width: 100%;
	max-height: 200px;
	display: block;
	margin: 0.5rem 0;
	border-radius: 4px;
	border: 1px solid #444;
}
.brave-tip {
	background: #fff3cd;
	border: 1px solid #ffcc80;
	border-radius: 5px;
	padding: 10px;
	color: #856404;
}
.brave-tip a {
	color: #856404;
	font-family: monospace;
}
.help-video {
	max-width: 100%;
	max-height: 400px;
	display: block;
	margin: 0.75rem 0;
	border-radius: 4px;
	border: 1px solid #444;
}
</style>
