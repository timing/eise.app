<template>
	<div class="page-layout page-layout-wide">
		<div class="content">
			<h2>About eise.app - Image Stacker for Planets, Moon & Sun</h2>
			<h3>100% browser-based - no uploads, no installs</h3>
			<p>eise.app is the first fully browser-based planetary image stacking tool for astrophotography.
			Everything runs locally on your machine using WebAssembly and Web Workers - your data never leaves your computer.
			</p>
			<p>
			The name is an ode to <a href="https://en.wikipedia.org/wiki/Eise_Eisinga" target="_blank">Eise Eisinga</a>, a Frisian amateur astronomer who built a planetarium in his living room.
			The project started from frustrations getting existing software running on ARM-based Macs - AutoStakkert4! didn't work in Wine, PSS had dependency issues, Lynkeos crashed continuously.
			</p>

			<p>
				The stacking pipeline includes automatic frame ranking, per-frame cropping and centering, local alignment with de-warping,
				drizzle upscaling, and quality-weighted frame accumulation. The integrated post-processor offers wavelet sharpening,
				RGB alignment, and color correction.
				<NuxtLink to="/about/help/">Learn how eise.app works</NuxtLink> or
				<NuxtLink to="/about/planetary-stacking-software-comparison/">compare it to other stacking software</NuxtLink>.
			</p>
			<p class="tip">You can also use the <NuxtLink to="/post-processor/">post-processor</NuxtLink> directly on any image - just open a PNG or TIFF for wavelet sharpening, RGB alignment, and other adjustments without stacking.</p>

			<!-- Screenshot carousel -->
			<div class="screenshot-carousel">
				<button class="carousel-btn prev" @click="prevScreenshot">&lsaquo;</button>
				<div class="carousel-container" @click="showLightbox = true">
					<img :src="screenshots[currentScreenshot]" :alt="'eise.app screenshot ' + (currentScreenshot + 1)" />
				</div>
				<button class="carousel-btn next" @click="nextScreenshot">&rsaquo;</button>
				<div class="carousel-dots">
					<span
						v-for="(_, idx) in screenshots"
						:key="idx"
						class="dot"
						:class="{ active: idx === currentScreenshot }"
						@click="currentScreenshot = idx"
					></span>
				</div>
			</div>

			<!-- Lightbox popup -->
			<div v-if="showLightbox" class="lightbox-overlay" @click="showLightbox = false">
				<button class="lightbox-btn prev" @click.stop="prevScreenshot">&lsaquo;</button>
				<img :src="screenshots[currentScreenshot]" :alt="'eise.app screenshot ' + (currentScreenshot + 1)" @click.stop />
				<button class="lightbox-btn next" @click.stop="nextScreenshot">&rsaquo;</button>
				<button class="lightbox-close" @click="showLightbox = false">&times;</button>
			</div>

			<h3>Technology</h3>
			<p>Built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any OS without installation.</p>

			<h3>Browser Requirements</h3>
			<p>eise.app uses WebGPU for fast GPU-accelerated processing. See <NuxtLink to="/about/help/">browser requirements</NuxtLink> for minimum versions.</p>
			<ClientOnly>
				<div class="compat-status" :class="{ compatible: webGPUSupported === true, incompatible: webGPUSupported === false, checking: webGPUSupported === null }">
					<strong>Your browser:</strong> {{ detectedBrowser }}<br/>
					<span v-if="webGPUSupported === null">Checking WebGPU support...</span>
					<span v-else-if="webGPUSupported">WebGPU is supported - you're good to go!</span>
					<span v-else>WebGPU not available - processing will be slower. Try updating your browser or using Chrome/Edge/Safari.</span>
				</div>
			</ClientOnly>

			<h3>Alternative software</h3>
			<p>
				eise.app works well for quick astrophotography results without installing anything.
				For a detailed comparison with AutoStakkert!, Planetary System Stacker, Registax, and other tools,
				see our <NuxtLink to="/about/planetary-stacking-software-comparison/">stacking software comparison</NuxtLink>.
			</p>

			<h3>Acknowledgments</h3>
			<p>
			This project draws inspiration from <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> by Rolf Hempel.
			The alignment point approach, local de-warping, and quality-weighted stacking concepts are based on PSS's implementation.
			Thank you Rolf for making PSS open source and documenting the algorithms.
			</p>

			<h3>Bugs or feature requests?</h3>
			<p>Head over to <a href="https://github.com/timing/eise.app" target="_blank">eise.app on GitHub</a> for suggestions or bug reports.</p>
			<p>Or <a href="#" @click.prevent="openFeedback()">send me feedback directly</a> - I'd love to hear about your experience!</p>

			<p>Happy Stacking,<br/> Tijmen</p>
		</div>
	</div>
</template>

<script setup>
import { useFeedback } from '@/composables/useFeedback';

const { openFeedback } = useFeedback();
const webGPUSupported = inject('webGPUSupported');
const detectedBrowser = inject('detectedBrowser');

// Screenshot carousel
const screenshots = [
	'/screenshot-1.png',
	'/screenshot-2.png',
	'/screenshot-3.png',
	'/screenshot-4.png',
	'/screenshot-5.png',
];
const currentScreenshot = ref(0);
const showLightbox = ref(false);

function nextScreenshot() {
	currentScreenshot.value = (currentScreenshot.value + 1) % screenshots.length;
}

function prevScreenshot() {
	currentScreenshot.value = (currentScreenshot.value - 1 + screenshots.length) % screenshots.length;
}

useHead({
	title: 'About eise.app - Browser-Based Planetary Image Stacking',
	meta: [
		{ name: 'description', content: 'eise.app is the first fully browser-based planetary image stacking tool for astrophotography. Process planets, Moon, and Sun images without installation - works on Mac, Windows, and Linux.' },
		{ name: 'keywords', content: 'planetary image stacking, astrophotography software, browser-based stacking, lucky imaging, planetary photography' },
	],
});
</script>

<style scoped>
.screenshot-carousel {
	position: relative;
	margin: 2rem 0;
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.carousel-container {
	flex: 1;
	overflow: hidden;
	border-radius: 8px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	aspect-ratio: 1925 / 1500;
	cursor: pointer;
}

.carousel-container img {
	width: 100%;
	height: 100%;
	object-fit: cover;
	display: block;
}

.carousel-btn {
	background: rgba(255, 255, 255, 0.1);
	border: 1px solid rgba(255, 255, 255, 0.2);
	color: white;
	font-size: 2rem;
	width: 40px;
	height: 40px;
	border-radius: 50%;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.2s;
	flex-shrink: 0;
}

.carousel-btn:hover {
	background: rgba(255, 255, 255, 0.2);
}

.carousel-dots {
	position: absolute;
	bottom: -1.5rem;
	left: 50%;
	transform: translateX(-50%);
	display: flex;
	gap: 0.5rem;
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.3);
	cursor: pointer;
	transition: background 0.2s;
}

.dot.active {
	background: rgba(255, 255, 255, 0.8);
}

.dot:hover {
	background: rgba(255, 255, 255, 0.5);
}

/* Lightbox popup */
.lightbox-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.9);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 1000;
	padding: 2rem;
}

.lightbox-overlay > img {
	max-width: 90vw;
	max-height: 90vh;
	object-fit: contain;
	border-radius: 4px;
}

.lightbox-btn {
	position: absolute;
	top: 50%;
	transform: translateY(-50%);
	background: rgba(255, 255, 255, 0.1);
	border: 1px solid rgba(255, 255, 255, 0.3);
	color: white;
	font-size: 3rem;
	width: 60px;
	height: 60px;
	border-radius: 50%;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.2s;
}

.lightbox-btn:hover {
	background: rgba(255, 255, 255, 0.2);
}

.lightbox-btn.prev {
	left: 1rem;
}

.lightbox-btn.next {
	right: 1rem;
}

.lightbox-close {
	position: absolute;
	top: 1rem;
	right: 1rem;
	background: none;
	border: none;
	color: white;
	font-size: 2.5rem;
	cursor: pointer;
	opacity: 0.7;
	transition: opacity 0.2s;
}

.lightbox-close:hover {
	opacity: 1;
}
</style>
