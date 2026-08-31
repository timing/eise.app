<template>
	<div>
		<div class="top-bar">
			<header>
				<h1>
					<a href="/">Eise.app</a>&nbsp;
					<span class="subtitle">Easy Image Stacker Engine</span>
					<span
						v-if="showStackCounter"
						class="stack-counter nav-desktop-only"
						:title="`${stackCount24h} stacks finished in the last 24 hours`">
						<span class="stack-counter-num">&bull; {{ stackCount24h }}</span>
						<span class="stack-counter-label">{{ stackCount24h === 1 ? 'stack' : 'stacks' }} today</span>
					</span>
				</h1>
			</header>
			
			<nav class="tabs">
				<NuxtLink to="/" :class="{ active: route.path === '/' }">Stack</NuxtLink>
				<NuxtLink to="/post-processor/" :class="{ active: route.path.startsWith('/post-processor') }">Post Processor</NuxtLink>
				<NuxtLink to="/gallery/" class="nav-desktop-only" :class="{ active: route.path.startsWith('/gallery') }">Gallery</NuxtLink>
				<NuxtLink to="/download/" :class="{ active: route.path.startsWith('/download') }">Download</NuxtLink>
				<div class="hamburger-menu" :class="{ open: menuOpen }">
					<button class="hamburger-toggle" @click="menuOpen = !menuOpen" aria-label="Menu">
						<span class="hamburger-icon">☰</span>
					</button>
					<div class="menu-backdrop" @click="menuOpen = false"></div>
					<div class="menu-dropdown">
						<NuxtLink to="/gallery/" class="nav-mobile-only" @click="menuOpen = false">Gallery</NuxtLink>
						<div class="menu-divider nav-mobile-only"></div>
						<NuxtLink to="/about/" @click="menuOpen = false">About Eise.app</NuxtLink>
						<NuxtLink to="/about/help/" @click="menuOpen = false">Help & How it Works</NuxtLink>
						<NuxtLink to="/about/architecture/" @click="menuOpen = false">Technical Architecture</NuxtLink>
						<NuxtLink to="/about/planetary-stacking-software-comparison/" @click="menuOpen = false">Stacking Software Comparison</NuxtLink>
						<div class="menu-divider"></div>
						<NuxtLink to="/tools/" @click="menuOpen = false">SER Tools</NuxtLink>
					</div>
				</div>
			</nav>
		</div>

		<slot />

		<div class="clearb"></div>

		<aside v-if="showAffiliate" class="affiliate-banner">
			<p class="affiliate-disclosure">Advertisement</p>
			<a href="https://www.zwoastro.com/product/seestar-s50-pro/?ref=eiseapp"
				target="_blank"
				rel="sponsored noopener nofollow"
				class="affiliate-link"
				data-no-track
				@click="onAffiliateClick">
				<img
					src="/seestar-s50-pro.webp"
					alt="ZWO Seestar S50 Pro smart telescope"
					loading="lazy"
					width="2560"
					height="1600"
					class="affiliate-image" />
				<p class="affiliate-caption">
					Seestars are perfect for sun, moon, and deep sky. Not planets, but you could give Jupiter a try.
				</p>
			</a>
		</aside>

		<footer class="site-footer" :class="{ 'site-footer--content': !showLogger }">
			<div class="site-footer-inner">
				<div class="site-footer-cols">
					<div class="site-footer-col">
						<h4>App</h4>
						<ul>
							<li><NuxtLink to="/">Stack images</NuxtLink></li>
							<li><NuxtLink to="/post-processor/">Post Processor</NuxtLink></li>
							<li><NuxtLink to="/tools/">SER Tools</NuxtLink></li>
							<li><NuxtLink to="/download/">Download desktop app</NuxtLink></li>
						</ul>
					</div>
					<div class="site-footer-col">
						<h4>Learn</h4>
						<ul>
							<li><NuxtLink to="/about/">About Eise.app</NuxtLink></li>
							<li><NuxtLink to="/about/help/">How to use it</NuxtLink></li>
							<li><NuxtLink to="/about/architecture/">Technical architecture</NuxtLink></li>
						</ul>
					</div>
					<div class="site-footer-col">
						<h4>Compare</h4>
						<ul>
							<li><NuxtLink to="/about/planetary-stacking-software-comparison/">All stacking software</NuxtLink></li>
							<li><NuxtLink to="/about/autostakkert-vs-eise/">AutoStakkert! vs Eise.app</NuxtLink></li>
							<li><NuxtLink to="/about/registax-vs-eise/">Registax 6 vs Eise.app</NuxtLink></li>
							<li><NuxtLink to="/about/planetary-system-stacker-vs-eise/">Planetary System Stacker vs Eise.app</NuxtLink></li>
							<li><NuxtLink to="/planetary-stacking-mac/">Stack on Mac</NuxtLink></li>
							<li><NuxtLink to="/seestar-planetary-stacking/">Stack Seestar videos</NuxtLink></li>
						</ul>
					</div>
					<div class="site-footer-col">
						<h4>Community</h4>
						<ul>
							<li><NuxtLink to="/gallery/">Share your stacked image</NuxtLink></li>
							<li><NuxtLink to="/about/#testimonials">What users say</NuxtLink></li>
							<li><a href="https://github.com/timing/eise.app/issues" target="_blank" rel="noopener" data-no-track @click="onLetMeKnowClick">Report a bug / suggest a feature</a></li>
							<li><a href="https://github.com/timing/eise.app" target="_blank" rel="noopener">GitHub</a></li>
						</ul>
					</div>
				</div>
				<p class="site-footer-copy">
					Eise.app - Free browser-based planetary image stacker.
					Named after <a href="https://en.wikipedia.org/wiki/Eise_Eisinga" target="_blank" rel="noopener">Eise Eisinga</a>.
					<span v-if="buildDate" class="site-footer-release">Latest release: {{ buildDate }}</span>
				</p>
			</div>
		</footer>

		<Logger v-if="showLogger" />
	</div>
</template>

<script setup>
import Logger from '@/components/Logger.vue';
import { useFeedback } from '@/composables/useFeedback';
import { getVariant } from '@/composables/useAbTest';

const route = useRoute();
const menuOpen = ref(false);
const { openFeedback } = useFeedback();

// Social-proof counter A/B: desktop-only "N Stacks today" badge between logo
// and nav. Enrollment is gated on desktop so mobile visitors don't get bucketed
// into a treatment they never see; the variant lands on the session as soon as
// the user fires their first tracked event (human_interaction, click_ext, etc.)
// because activeVariants() reads localStorage on every track call. Count comes
// from a 5-minute-cached endpoint on gallery-api that reads stack_finished
// events from the last 24h.
const stackCounterVariant = ref('A');
const stackCount24h = ref(null);
const isDesktop = ref(false);
const showStackCounter = computed(() =>
	isDesktop.value
	&& stackCounterVariant.value === 'B'
	&& typeof stackCount24h.value === 'number'
	&& stackCount24h.value > 0
);

onMounted(async () => {
	if (typeof window === 'undefined') return;
	isDesktop.value = window.matchMedia('(min-width: 701px)').matches;
	if (!isDesktop.value) return;
	stackCounterVariant.value = getVariant('social_proof_counter');
	if (window.eise && typeof window.eise.stacks24h === 'function') {
		try {
			const res = await window.eise.stacks24h();
			if (res && typeof res.count === 'number') stackCount24h.value = res.count;
		} catch {}
	}
});

async function onLetMeKnowClick(event) {
	// If Sentry feedback is available, open the modal and cancel navigation.
	// Otherwise the href + target="_blank" fallback opens the GitHub issues page.
	// The link carries data-no-track so beacon.js skips its auto click_ext;
	// we record it manually only in the fallback branch that actually navigates.
	const opened = await openFeedback();
	if (opened) {
		event.preventDefault();
	} else if (typeof window !== 'undefined' && window.eise?.track) {
		window.eise.track('click_ext', { url: event.currentTarget.href });
	}
}

// Content pages (about/*, download) don't need the Logs sticky bar. It belongs
// to the interactive app flow. Everything else shows it.
const showLogger = computed(() => {
	const p = route.path;
	return !(p.startsWith('/about') || p.startsWith('/download'));
});

// Hide the affiliate banner on admin pages where it makes no sense.
const showAffiliate = computed(() => !route.path.startsWith('/admin'));

function onAffiliateClick(event) {
	if (typeof window !== 'undefined' && window.eise?.track) {
		window.eise.track('affiliate_click', {
			partner: 'zwo',
			product: 'seestar-s50-pro',
			url: event.currentTarget.href,
		});
	}
}

const runtimeConfig = useRuntimeConfig();
const buildDate = computed(() => {
	const ts = runtimeConfig.public.buildTimestamp;
	if (!ts) return '';
	return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
});

// Canonical URL: normalize trailing slash + strip query/hash so Google groups
// all variant URLs onto the canonical form (fixes the "http://eise.app/?"
// URL-inspection warning).
useHead({
	link: [
		{
			rel: 'canonical',
			href: computed(() => {
				const path = route.path.endsWith('/') || route.path === '/' ? route.path : route.path + '/';
				return `https://eise.app${path}`;
			}),
		},
	],
});

// Close menu when route changes
watch(() => route.path, () => {
	menuOpen.value = false;
});
</script>

<style scoped>
.nav-mobile-only { display: none !important; }
@media (max-width: 700px) {
	.nav-desktop-only { display: none !important; }
	.nav-mobile-only { display: block !important; }
}
.stack-counter {
	padding: 5px 8px 6px 8px;
	border-radius: 50px;
	border: 1px solid #8CCF7E;
	font-size: 12px;
	margin-left: 6px;
	line-height: 1;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-weight: normal;
	user-select: none;
}
.stack-counter-num {
	color: #8CCF7E;
}
.stack-counter-label {
	color: #8CCF7E;
}
.hamburger-menu {
	position: relative;
	display: inline-block;
	vertical-align: top;
}
.hamburger-toggle {
	background-color: #fefefe;
	border: none;
	color: #333;
	padding: 8px 15px 10px 15px;
	cursor: pointer;
	transition: background-color 0.3s;
	font-size: 18px;
	line-height: 1;
	vertical-align: top;
}
.hamburger-toggle:hover {
	background-color: #70f1ec;
}
.hamburger-menu.open .hamburger-toggle {
	background-color: #70f1ec;
}
.menu-backdrop {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99;
	display: none;
}
.hamburger-menu.open .menu-backdrop {
	display: block;
}
.menu-dropdown {
	position: absolute;
	top: 100%;
	right: 0;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	z-index: 100;
	min-width: 240px;
	overflow: hidden;
	margin-top: 4px;
	display: none;
}
.hamburger-menu.open .menu-dropdown {
	display: block;
}
.menu-dropdown a {
	display: block;
	padding: 12px 16px;
	color: #333;
	text-decoration: none;
	font-size: 14px;
	background: none;
}
.menu-dropdown a:hover {
	background: #f5f5f5;
	color: #333;
}
.menu-divider {
	height: 1px;
	background: #e0e0e0;
	margin: 4px 0;
}
.affiliate-banner {
	max-width: 520px;
	margin: 48px auto 0;
	padding: 0 20px;
	text-align: center;
}
.affiliate-disclosure {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 1.5px;
	color: #888;
	margin: 0 0 8px 0;
}
.affiliate-link {
	display: block;
	text-decoration: none;
	color: inherit;
	border: 0;
	outline: 0;
}
.affiliate-link:focus-visible {
	outline: 2px solid #8CCF7E;
	outline-offset: 4px;
	border-radius: 10px;
}
.affiliate-image {
	display: block;
	width: 100%;
	height: auto;
	border: 0;
	border-radius: 8px;
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
	transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.affiliate-link:hover .affiliate-image {
	transform: translateY(-2px);
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.affiliate-caption {
	margin: 14px 0 0;
	font-size: 13px;
	line-height: 1.5;
	color: rgba(198, 255, 253, 0.7);
}
.affiliate-link:hover .affiliate-caption {
	color: rgba(198, 255, 253, 0.9);
}

.site-footer {
	margin-top: 40px;
	padding: 32px 20px 24px;
	background: rgba(0, 0, 0, 0.25);
	border-top: 1px solid rgba(255, 255, 255, 0.08);
	color: rgba(198, 255, 253, 0.75);
	font-size: 13px;
	line-height: 1.6;
}
/* When the Logger sticky bar is present, keep some space below the footer so
   the last row of links doesn't sit right on top of the fixed logs bar. */
.site-footer:not(.site-footer--content) {
	margin-bottom: 60px;
}
.site-footer-inner {
	max-width: 1100px;
	margin: 0 auto;
}
.site-footer-cols {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 24px 32px;
	margin-bottom: 24px;
}
.site-footer-col h4 {
	margin: 0 0 10px;
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: rgba(198, 255, 253, 0.5);
}
.site-footer-col ul {
	list-style: none;
	padding: 0;
	margin: 0;
}
.site-footer-col li {
	margin: 4px 0;
}
.site-footer-col a {
	color: #8CCF7E;
	text-decoration: none;
}
.site-footer-col a:hover {
	text-decoration: underline;
}
.site-footer-copy {
	margin: 0;
	padding-top: 16px;
	border-top: 1px solid rgba(255, 255, 255, 0.06);
	font-size: 12px;
	color: rgba(198, 255, 253, 0.55);
}
.site-footer-copy a {
	color: rgba(198, 255, 253, 0.75);
	text-decoration: underline;
}
.site-footer-release {
	display: inline-block;
	margin-left: 8px;
	padding-left: 8px;
	border-left: 1px solid rgba(255, 255, 255, 0.15);
	color: rgba(198, 255, 253, 0.45);
}
@media (max-width: 700px) {
	.site-footer-release {
		display: block;
		margin-left: 0;
		padding-left: 0;
		border-left: 0;
		margin-top: 4px;
	}
}
@media (max-width: 700px) {
	.site-footer {
		padding: 24px 16px 20px;
	}
	.site-footer-cols {
		gap: 20px 24px;
	}
}
@media (max-width: 700px) {
	.hamburger-menu {
		flex: 0;
		display: flex;
	}
	.hamburger-toggle {
		padding: 8px 12px;
		font-size: 14px;
		line-height: 1;
		height: 100%;
		box-sizing: border-box;
	}
	.menu-dropdown {
		right: 0;
		left: auto;
	}
}
</style>
