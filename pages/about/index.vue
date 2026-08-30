<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>About Eise.app</h2>
			<p class="page-subtitle">Image stacker for planets, Moon &amp; Sun</p>
			<h3>100% browser-based - no uploads, no installs</h3>
			<p>Eise.app is the first fully browser-based planetary image stacking tool for astrophotography.
			All algorithms run locally on your machine using WebGPU for fast GPU-accelerated processing, WebAssembly, and Web Workers. Your data is not uploaded to any server.
			</p>
			<p>
			The name is an ode to <a href="https://en.wikipedia.org/wiki/Eise_Eisinga" target="_blank">Eise Eisinga</a>, a Frisian amateur astronomer who built a planetarium in his living room.
			The project started from frustrations getting existing software running on ARM-based Macs - AutoStakkert4! didn't work in Wine, PSS had dependency issues, Lynkeos crashed continuously.
			</p>

			<p>
				The stacking pipeline includes automatic frame ranking, per-frame cropping and centering, local alignment with de-warping,
				drizzle upscaling, and quality-weighted frame accumulation. The integrated post-processor offers wavelet sharpening,
				RGB alignment, and color correction.
				<NuxtLink to="/about/help/">Learn how Eise.app works</NuxtLink>,
				<NuxtLink to="/about/architecture/">explore the technical architecture</NuxtLink>, or
				<NuxtLink to="/about/planetary-stacking-software-comparison/">compare it to other stacking software</NuxtLink>.
			</p>
			<p class="tip">You can also use the <NuxtLink to="/post-processor/">post-processor</NuxtLink> directly on any image - just open a PNG or TIFF for wavelet sharpening, RGB alignment, and other adjustments without stacking.</p>

			<p>Curious what people are making with it? Browse the <NuxtLink to="/gallery/">community gallery</NuxtLink> of stacks published straight from the app.</p>

			<section id="testimonials" class="testimonials" aria-label="What users say">
				<h3>What users say</h3>
				<div class="testimonial-grid">
					<blockquote>
						<p>"Very good app — it helped me massively improve my image of the Moon."</p>
						<cite>— Santhiago, astrophotographer from Costa Rica</cite>
					</blockquote>
					<blockquote>
						<p>"Very satisfied with the result."</p>
						<cite>— Alexis, astrophotographer from France</cite>
					</blockquote>
					<blockquote>
						<p>"Happy this is easy to use."</p>
						<cite>— Astroyouda, astrophotographer from Indonesia</cite>
					</blockquote>
				</div>
				<p class="testimonials-note">Quotes translated to English, collected via the feedback form.</p>
			</section>

			<!-- Screenshot carousel -->
			<div class="screenshot-carousel">
				<button class="carousel-btn prev" @click="prevScreenshot">&lsaquo;</button>
				<div class="carousel-container" @click="showLightbox = true">
					<img :src="screenshots[currentScreenshot]" :alt="'Eise.app screenshot ' + (currentScreenshot + 1)" />
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
				<img :src="screenshots[currentScreenshot]" :alt="'Eise.app screenshot ' + (currentScreenshot + 1)" @click.stop />
				<button class="lightbox-btn next" @click.stop="nextScreenshot">&rsaquo;</button>
				<button class="lightbox-close" @click="showLightbox = false">&times;</button>
			</div>

			<h3>Technology</h3>
			<p>Built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any OS without installation.</p>

			<h3>Browser Requirements</h3>
			<p>Eise.app uses WebGPU for fast GPU-accelerated processing. See <NuxtLink to="/about/help/">browser requirements</NuxtLink> for minimum versions.</p>
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
				Eise.app works well for quick astrophotography results without installing anything.
				For a detailed comparison with AutoStakkert!, Planetary System Stacker, Registax, and other tools,
				see our <NuxtLink to="/about/planetary-stacking-software-comparison/">stacking software comparison</NuxtLink>.
			</p>
			<p>
				Head-to-head with the most-searched competitors:
				<NuxtLink to="/about/autostakkert-vs-eise/">AutoStakkert! vs Eise.app</NuxtLink>,
				<NuxtLink to="/about/registax-vs-eise/">Registax 6 vs Eise.app</NuxtLink>,
				<NuxtLink to="/about/planetary-system-stacker-vs-eise/">PSS vs Eise.app</NuxtLink>.
			</p>

			<h3>Acknowledgments</h3>
			<p>
			This project draws inspiration from <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> by Rolf Hempel.
			The alignment point approach, local de-warping, and quality-weighted stacking concepts are based on PSS's implementation.
			Thank you Rolf for making PSS open source and documenting the algorithms.
			</p>

			<section id="community" class="community-section">
				<h3>Community & feedback</h3>

				<h4>Show me what you stacked</h4>
				<p>
					If you've made something with Eise.app I'd like to see it. With your permission I'll feature good ones on this page.
				</p>
				<ul>
					<li>Post on <a href="https://www.reddit.com/r/astrophotography/" target="_blank" rel="noopener">r/astrophotography</a> and mention Eise.app in the workflow - I keep an eye out.</li>
					<li>Post to Instagram or X with <strong>#eiseapp</strong>.</li>
					<li>Open a GitHub Discussion at <a href="https://github.com/timing/eise.app/discussions" target="_blank" rel="noopener">github.com/timing/eise.app/discussions</a>.</li>
					<li>Or send it via the feedback button. I read every message.</li>
				</ul>

				<h4>Bugs and feature requests</h4>
				<p>
					Hit a bug, want a feature, or something isn't working the way you expected? Please tell me - especially the niche stuff. "Doesn't work with my old QHY camera", "wavelets need one more slider", "add FITS support", "make it run on my Chromebook" - all useful, all read.
				</p>
				<div class="community-cta-row">
					<a href="https://github.com/timing/eise.app/issues" target="_blank" rel="noopener" data-no-track @click="onLetMeKnowClick" class="cta-secondary">Send feedback</a>
					<a href="https://github.com/timing/eise.app/issues/new" target="_blank" rel="noopener" class="cta-secondary">Report on GitHub</a>
					<a href="https://github.com/timing/eise.app/discussions" target="_blank" rel="noopener" class="cta-secondary">Share on Discussions</a>
				</div>

				<h4>Community gallery</h4>
				<p>
					The <NuxtLink to="/gallery/">community gallery</NuxtLink> shows stacks published from the app by other astrophotographers. You can publish yours in one click straight from the stacking result, or upload an Eise stack you've already saved.
				</p>
				<div class="community-cta-row">
					<NuxtLink to="/gallery/" class="cta-secondary">Open the gallery</NuxtLink>
				</div>

				<h4>Support the project</h4>
				<p>
					Eise.app is free and I build it in my spare time. If it saved you an evening of wrestling with Wine or a legacy install, you can buy me a coffee to keep the project going.
				</p>
				<div class="community-cta-row">
					<a href="https://buymeacoffee.com/timing" target="_blank" rel="noopener" class="bmc-btn">
						<span class="bmc-btn-emoji">☕</span>
						<span class="bmc-btn-text">Buy me a coffee</span>
					</a>
				</div>
			</section>

			<section id="newsletter" class="newsletter-section" aria-label="Newsletter signup">
				<h3>Stay in the loop</h3>
				<p>
					Get an occasional email when Eise has updates. No spam, unsubscribe any time.
				</p>
				<MailingListForm
					submit-label="Subscribe"
					usecase-label="What are you into? (optional)"
					usecase-placeholder="e.g., Jupiter with a C8, lunar mosaics, solar Hα..."
					track-source="about-newsletter"
				/>
			</section>

			<p class="signoff">Happy stacking,<br/>Tijmen</p>
		</div>
	</div>
</template>

<script setup>
import { useFeedback } from '@/composables/useFeedback';
import MailingListForm from '@/components/MailingListForm.vue';

const { openFeedback } = useFeedback();
const webGPUSupported = inject('webGPUSupported');
const detectedBrowser = inject('detectedBrowser');

async function onLetMeKnowClick(event) {
	// Open Sentry feedback if available; otherwise the href fallback opens
	// GitHub issues. Manually record click_ext only when we actually navigate.
	const opened = await openFeedback();
	if (opened) {
		event.preventDefault();
	} else if (typeof window !== 'undefined' && window.eise?.track) {
		window.eise.track('click_ext', { url: event.currentTarget.href });
	}
}

useHead({
	link: [
		{ rel: 'preconnect', href: 'https://fonts.googleapis.com' },
		{ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
		{ rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Cookie&display=swap' }
	]
});

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
	title: 'About Eise.app - Browser-Based Planetary Image Stacking',
	meta: [
		{ name: 'description', content: 'Eise.app is the first fully browser-based planetary image stacking tool for astrophotography. Process planets, Moon, and Sun images without installation - works on Mac, Windows, and Linux.' },
		{ name: 'keywords', content: 'planetary image stacking, astrophotography software, browser-based stacking, lucky imaging, planetary photography' },
	],
});
</script>

<style scoped>
.community-section {
	margin: 2.5rem 0;
	padding: 1.75rem 2rem;
	background: #f7f7f7;
	border-radius: 8px;
	border-left: 3px solid #8CCF7E;
}
.community-section h3 {
	margin-top: 0;
}
.community-section h4 {
	margin-top: 1.5rem;
	font-size: 15px;
}
.community-cta-row {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	margin: 1rem 0 0;
}
.bmc-btn {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	background: #FFDD00;
	color: #000000 !important;
	border: 1px solid #000000;
	border-radius: 6px;
	padding: 8px 18px;
	font-family: 'Cookie', cursive;
	font-size: 22px;
	line-height: 1;
	text-decoration: none !important;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
	transition: opacity 0.2s;
}
.bmc-btn:hover {
	opacity: 0.85;
}
.bmc-btn-emoji {
	font-size: 20px;
	font-family: system-ui, sans-serif;
}
.bmc-btn-text {
	position: relative;
	top: 2px;
}
.cta-secondary {
	display: inline-block;
	background: #fff;
	color: #1a5a99 !important;
	border: 1px solid #1a5a99;
	padding: 8px 16px;
	border-radius: 4px;
	font-size: 14px;
	text-decoration: none !important;
	font-weight: 600;
}
.cta-secondary:hover {
	background: #1a5a99;
	color: #fff !important;
}
.newsletter-section {
	margin: 2.5rem 0;
	padding: 1.75rem 2rem;
	background: #f7f7f7;
	border-radius: 8px;
	border-left: 3px solid #1a5a99;
}
.newsletter-section h3 {
	margin-top: 0;
}
@media (max-width: 700px) {
	.newsletter-section {
		padding: 1.25rem 1.25rem;
	}
}
.signoff {
	margin-top: 2rem;
	color: #666;
	font-style: italic;
}
@media (max-width: 700px) {
	.community-section {
		padding: 1.25rem 1.25rem;
	}
}
.testimonials {
	margin: 2.5rem 0;
	max-width: 100%;
}
.testimonials h3 {
	margin-bottom: 1rem;
}
.testimonial-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 1rem;
}
.testimonial-grid blockquote {
	margin: 0;
	padding: 1rem 1.25rem;
	background: #f7f7f7;
	border-left: 3px solid #1a5a99;
	border-radius: 4px;
}
.testimonial-grid blockquote p {
	margin: 0 0 0.5rem;
	font-style: italic;
	color: #333;
	line-height: 1.5;
}
.testimonial-grid blockquote cite {
	font-style: normal;
	font-size: 0.85rem;
	color: #666;
}
.testimonials-note {
	margin-top: 0.75rem;
	font-size: 0.8rem;
	color: #888;
}

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
	background: #f0f0f0;
	border: 1px solid #d0d0d0;
	color: #333;
	font-size: 2rem;
	width: 40px;
	height: 40px;
	border-radius: 50%;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.2s, border-color 0.2s;
	flex-shrink: 0;
	line-height: 1;
	padding: 0;
}

.carousel-btn:hover {
	background: #e0e0e0;
	border-color: #b0b0b0;
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
	background: #c8c8c8;
	cursor: pointer;
	transition: background 0.2s;
}

.dot.active {
	background: #1a5a99;
}

.dot:hover {
	background: #888;
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
