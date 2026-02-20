<template>
	<div class="page-layout page-layout-wide">
		<div class="content">
			<h2>How to Use eise.app - Planetary Image Stacking Guide</h2>
			<p class="intro">This guide explains how eise.app processes your astrophotography videos and images to create sharp, detailed results.</p>

			<h3>Getting Started</h3>
			<ol>
				<li><strong>Capture your video</strong> - Use your telescope and camera to record a video of a planet, the Moon, or Sun. SER format is recommended, but AVI or MP4 also work.</li>
				<li><strong>Upload to eise.app</strong> - Drag and drop your file onto the Stack page. Multiple SER files can be combined.</li>
				<li><strong>Wait for analysis</strong> - eise.app analyzes each frame for sharpness and automatically crops and centers your target.</li>
				<li><strong>Select quality threshold</strong> - Use the slider to choose how many of the best frames to stack (typically 10-50%).</li>
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

			<h3>Post-Processing Tips</h3>
			<ul>
				<li><strong>Start with Auto Stretch</strong> - This normalizes your image's brightness range before other adjustments.</li>
				<li><strong>Use Wavelets for detail</strong> - Wavelet sharpening brings out surface features. Start low (amount ~20-40) and increase gradually.</li>
				<li><strong>Fix RGB alignment</strong> - If you see colored fringes, use Auto RGB alignment or adjust manually.</li>
				<li><strong>Crop edges last</strong> - The edges often have stacking artifacts. Crop them away at the end.</li>
			</ul>
			<p class="tip">You can also use the <NuxtLink to="/post-processor/">post-processor</NuxtLink> directly on any image - just open a PNG or TIFF for wavelet sharpening without stacking.</p>

			<h3>Technology</h3>
			<p>eise.app is built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any operating system without installation.</p>

			<h3>Browser Requirements</h3>
			<p>eise.app uses WebGPU for fast GPU-accelerated stacking and image processing. Here are the minimum browser versions:</p>
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

				<dt>Colors look wrong</dt>
				<dd>Enable "Auto color balance" in the Post Processor, or manually adjust saturation and RGB alignment.</dd>
			</dl>

			<h3>Need more help?</h3>
			<p>Head over to <a href="https://github.com/timing/eise.app" target="_blank">eise.app on GitHub</a> to ask questions or report issues.</p>
		</div>
	</div>
</template>

<script setup>
const webGPUSupported = inject('webGPUSupported');
const detectedBrowser = inject('detectedBrowser');

useHead({
	title: 'Help & How it Works - eise.app Planetary Image Stacking Guide',
	meta: [
		{ name: 'description', content: 'Learn how to use eise.app for planetary astrophotography. Step-by-step guide to stacking videos of planets, Moon, and Sun in your browser.' },
	],
});
</script>

<style scoped>
.intro {
	font-size: 1.1em;
	color: #aaa;
	margin-bottom: 1.5rem;
}
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
</style>
