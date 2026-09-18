<template>
	<div class="app-shell">
		<!-- Decorative orrery rings from the design. Behind everything, ignores
		     pointer events, clipped by .app-shell so it cannot cause h-scroll. -->
		<svg class="orbit-decor" viewBox="0 0 900 900" aria-hidden="true" focusable="false">
			<g fill="none" stroke="#d9a94a" stroke-opacity="0.34">
				<circle cx="450" cy="450" r="418" stroke-width="1.2" />
				<circle cx="450" cy="450" r="404" stroke-width="7" stroke-opacity="0.1" stroke-dasharray="3 9" />
				<circle cx="450" cy="450" r="330" stroke-width="1.2" />
				<circle cx="450" cy="450" r="318" stroke-width="6" stroke-opacity="0.1" stroke-dasharray="3 9" />
				<circle cx="450" cy="450" r="242" stroke-width="1.2" />
				<circle cx="450" cy="450" r="166" stroke-width="1.2" />
				<circle cx="450" cy="450" r="96" stroke-width="1.2" />
				<g stroke-opacity="0.13" stroke-width="1">
					<path d="M450 32v836M32 450h836M154 154l592 592M746 154L154 746" />
				</g>
			</g>
		</svg>

		<header class="eise-header">
			<div class="eise-brand">
				<NuxtLink to="/" class="eise-wordmark" @click="onWordmarkClick">Eise.app</NuxtLink>
				<span class="eise-tagline">Easy Image Stacker Engine</span>
				<span
					v-if="showStackCounter"
					class="eise-stat"
					:title="`${stackCount24h} stacks finished in the last 24 hours`">
					<span class="eise-stat-dot"></span>
					<span class="eise-stat-text">{{ stackCount24h }} {{ stackCount24h === 1 ? 'stack' : 'stacks' }} today</span>
				</span>
			</div>

			<nav class="eise-nav">
				<NuxtLink to="/" class="eise-tab" data-label="Stack" :class="{ 'is-active': route.path === '/' }">Stack</NuxtLink>
				<NuxtLink to="/post-processor/" class="eise-tab" data-label="Post Processor" :class="{ 'is-active': route.path.startsWith('/post-processor') }">Post Processor</NuxtLink>
				<NuxtLink to="/gallery/" class="eise-tab hide-below-460" data-label="Gallery" :class="{ 'is-active': route.path.startsWith('/gallery') }">Gallery</NuxtLink>
				<NuxtLink to="/download/" class="eise-tab hide-below-560" data-label="Download" :class="{ 'is-active': route.path.startsWith('/download') }">Download</NuxtLink>
				<a href="https://buymeacoffee.com/timing" target="_blank" rel="noopener" class="eise-cta hide-below-700">Buy me a coffee</a>

				<div ref="hamburgerRef" class="hamburger-menu" :class="{ open: menuOpen }">
					<button class="eise-menu" @click="menuOpen = !menuOpen" type="button" aria-label="Menu">
						<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<defs>
								<clipPath id="jupMenuClip" clipPathUnits="userSpaceOnUse">
									<circle cx="12" cy="12" r="10"></circle>
								</clipPath>
							</defs>
							<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="0.9"></circle>
							<g clip-path="url(#jupMenuClip)">
								<path d="M0 7.5h24M0 12h24M0 16.5h24" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
								<circle cx="15.5" cy="16.5" r="2.1" fill="#d9a94a"></circle>
							</g>
						</svg>
					</button>
					<div class="menu-dropdown">
						<NuxtLink to="/gallery/" class="only-below-460" @click="menuOpen = false">Gallery</NuxtLink>
						<NuxtLink to="/download/" class="only-below-560" @click="menuOpen = false">Download</NuxtLink>
						<a href="https://buymeacoffee.com/timing" target="_blank" rel="noopener" class="only-below-700" @click="menuOpen = false">Buy me a coffee</a>
						<div class="menu-divider only-below-700"></div>
						<NuxtLink to="/about/" @click="menuOpen = false">About Eise.app</NuxtLink>
						<NuxtLink to="/about/help/" @click="menuOpen = false">Help & How it Works</NuxtLink>
						<NuxtLink to="/about/architecture/" @click="menuOpen = false">Technical Architecture</NuxtLink>
						<NuxtLink to="/about/planetary-stacking-software-comparison/" @click="menuOpen = false">Stacking Software Comparison</NuxtLink>
						<div class="menu-divider"></div>
						<NuxtLink to="/tools/" @click="menuOpen = false">SER Tools</NuxtLink>
					</div>
				</div>
			</nav>
		</header>

		<div class="app-content">
			<slot />
		</div>

		<div class="clearb"></div>

		<aside v-if="showAffiliate" class="affiliate-banner">
			<p class="affiliate-disclosure">Advertisement</p>
			<a href="https://www.astroshop.eu/telescopes/zwo-smart-telescope-ap-50-260-seestar-s50-pro/p,93251?affiliate_id=Eiseapp"
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
				<div class="site-footer-bottom">
					<p class="site-footer-copy">
						Eise.app - Free browser-based planetary image stacker.
						Named after <a href="https://en.wikipedia.org/wiki/Eise_Eisinga" target="_blank" rel="noopener">Eise Eisinga</a>.
					</p>
					<span v-if="buildDate" class="site-footer-release">Latest release: {{ buildDate }}</span>
				</div>
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

// The wordmark is a plain link to /, but on the stack page itself that is a
// no-op - so mid-run (analyzing, picking a threshold, stacking) it would look
// dead. Reload instead, which is how "Start over" gets back to a clean home
// state elsewhere in the app.
const isProcessing = inject('isProcessing', null);
const isSelectingQuality = inject('isSelectingQuality', null);
const isSelectingColorProfile = inject('isSelectingColorProfile', null);
const isShowingContinuousResults = inject('isShowingContinuousResults', null);
function onWordmarkClick(event) {
	const busy = [isProcessing, isSelectingQuality, isSelectingColorProfile, isShowingContinuousResults]
		.some((flag) => flag && flag.value);
	if (route.path === '/' && busy) {
		event.preventDefault();
		window.location.reload();
	}
}
const menuOpen = ref(false);
const hamburgerRef = ref(null);
const { openFeedback } = useFeedback();

// Close the menu on any click outside the hamburger. A document listener is
// used instead of a fullscreen backdrop element because the header has
// `backdrop-filter: blur(...)`, which makes it the containing block for
// `position: fixed` descendants — a "fullscreen" backdrop nested inside the
// header would only cover the header's 60px, not the viewport.
function onDocClickCloseMenu(e) {
	if (!menuOpen.value) return;
	if (hamburgerRef.value && !hamburgerRef.value.contains(e.target)) {
		menuOpen.value = false;
	}
}
onMounted(() => document.addEventListener('click', onDocClickCloseMenu));
onBeforeUnmount(() => document.removeEventListener('click', onDocClickCloseMenu));

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
.app-shell {
	position: relative;
	overflow-x: clip;
}
/* Sits behind the page; the header (z-index 20) and content stay above it. */
.orbit-decor {
	position: absolute;
	top: -260px;
	right: -300px;
	width: 900px;
	height: 900px;
	z-index: 0;
	opacity: 0.42;
	pointer-events: none;
}
.app-content {
	position: relative;
	z-index: 1;
}
@media (max-width: 700px) {
	.orbit-decor {
		top: -320px;
		right: -420px;
	}
}
.eise-header {
	position: sticky;
	top: 0;
	z-index: 20;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 32px;
	height: 60px;
	padding: 0 28px;
	background: rgba(9, 52, 66, 0.85);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	-webkit-font-smoothing: antialiased;
}

.eise-brand {
	display: flex;
	align-items: baseline;
	gap: 10px;
	min-width: 0;
}

.eise-wordmark {
	font-size: 17px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--eise-gilt);
	text-decoration: none;
	white-space: nowrap;
	flex-shrink: 0;
}

.eise-tagline {
	font-size: 12.5px;
	letter-spacing: 0.01em;
	color: var(--eise-muted);
}

.eise-stat {
	align-self: center;
	display: inline-flex;
	align-items: center;
	gap: 7px;
	margin-left: 6px;
	padding: 3px 10px;
	border: 1px solid rgba(217, 169, 74, 0.28);
	border-radius: 999px;
	background: rgba(217, 169, 74, 0.1);
	user-select: none;
}

.eise-stat-dot {
	flex: 0 0 auto;
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--eise-gilt);
}

.eise-stat-text {
	font-size: 11.5px;
	letter-spacing: 0.02em;
	color: var(--eise-gilt-lt);
}

.eise-nav {
	display: flex;
	align-items: center;
	gap: 4px;
}

.eise-tab {
	display: inline-flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 7px 14px;
	/* Transparent border matches the 1px on .eise-cta so all nav items share
	   the same box height and sit on the same baseline in the flex row. */
	border: 1px solid transparent;
	border-radius: 6px;
	white-space: nowrap;
	flex-shrink: 0;
	font-size: 13.5px;
	color: var(--eise-on-dark);
	text-decoration: none;
	transition: background 120ms ease, color 120ms ease;
}
/* Ghost copy at the bold weight reserves box width so switching to
   .is-active (font-weight 600) doesn't reflow the nav. */
.eise-tab::before {
	content: attr(data-label);
	font-weight: 600;
	height: 0;
	visibility: hidden;
	overflow: hidden;
	user-select: none;
	pointer-events: none;
}
.eise-tab:hover {
	background: rgba(255, 255, 255, 0.07);
	color: #ffffff;
}
.eise-tab.is-active,
.eise-tab.is-active:hover {
	font-weight: 600;
	color: var(--eise-ink);
	background: var(--eise-gilt);
}

.eise-cta {
	padding: 7px 14px;
	margin-left: 6px;
	border: 1px solid rgba(217, 169, 74, 0.55);
	border-radius: 6px;
	white-space: nowrap;
	flex-shrink: 0;
	font-size: 13.5px;
	color: var(--eise-gilt-lt);
	text-decoration: none;
	background: rgba(217, 169, 74, 0.08);
	transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.eise-cta:hover {
	background: var(--eise-gilt);
	border-color: var(--eise-gilt);
	color: var(--eise-ink);
}

.eise-menu {
	display: grid;
	place-items: center;
	width: 32px;
	height: 32px;
	margin-left: 8px;
	padding: 0;
	background: transparent;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 6px;
	color: var(--eise-on-dark);
	cursor: pointer;
	transition: background 120ms ease, color 120ms ease;
}
.eise-menu:hover {
	background: rgba(255, 255, 255, 0.07);
	color: #ffffff;
}
.hamburger-menu.open .eise-menu {
	background: rgba(255, 255, 255, 0.07);
	color: #ffffff;
}

.hamburger-menu {
	position: relative;
	display: inline-flex;
}
.menu-dropdown {
	position: absolute;
	top: calc(100% + 8px);
	right: 0;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
	z-index: 100;
	min-width: 240px;
	overflow: hidden;
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

/* Menu-only items are hidden by default; each shows in the hamburger only when
   its corresponding header item has been dropped. */
.only-below-460,
.only-below-560,
.only-below-700 {
	display: none !important;
}

/* Drop tagline + counter pill before nav collapses (per design spec). */
@media (max-width: 900px) {
	.eise-tagline,
	.eise-stat {
		display: none !important;
	}
}
/* Staged collapse: each nav item disappears at the width where it stops fitting
   on one line and moves into the hamburger menu.
     ≤ 700px: Buy me a coffee out
     ≤ 560px: Download out
     ≤ 460px: Gallery out
   Below 460 only Stack + Post Processor remain in the header. */
@media (max-width: 700px) {
	.hide-below-700 { display: none !important; }
	.only-below-700 { display: block !important; }
}
@media (max-width: 560px) {
	.hide-below-560 { display: none !important; }
	.only-below-560 { display: block !important; }
	.eise-header {
		gap: 12px;
		padding: 0 16px;
	}
	.eise-tab {
		padding: 6px 10px;
		font-size: 13px;
	}
}
@media (max-width: 460px) {
	.hide-below-460 { display: none !important; }
	.only-below-460 { display: block !important; }
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
	color: rgba(var(--eise-on-dark-rgb), 0.7);
}
.affiliate-link:hover .affiliate-caption {
	color: rgba(var(--eise-on-dark-rgb), 0.9);
}

.site-footer {
	margin-top: 40px;
	padding: 44px 28px 28px;
	background: rgba(4, 28, 36, 0.5);
	border-top: 1px solid rgba(255, 255, 255, 0.09);
	color: rgba(var(--eise-on-dark-rgb), 0.75);
	font-size: 13px;
	line-height: 1.6;
}
/* When the Logger sticky bar is present, keep some space below the footer so
   the last row of links doesn't sit right on top of the fixed logs bar. */
.site-footer:not(.site-footer--content) {
	margin-bottom: 60px;
}
.site-footer-inner {
	max-width: 1560px;
	margin: 0 auto;
}
.site-footer-cols {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 36px 40px;
}
.site-footer-col h4 {
	margin: 0 0 11px;
	font-family: var(--eise-mono);
	font-size: 10.5px;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	color: var(--eise-gilt);
}
.site-footer-col ul {
	list-style: none;
	padding: 0;
	margin: 0;
}
.site-footer-col li {
	margin: 0 0 11px;
}
.site-footer-col a {
	font-size: 14px;
	color: var(--eise-on-dark);
	text-decoration: none;
	border: none;
}
.site-footer-col a:hover {
	color: #ffffff;
	text-decoration: none;
}
/* Colophon row: credit left, release stamp right. */
.site-footer-bottom {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 20px;
	flex-wrap: wrap;
	margin-top: 40px;
	padding-top: 20px;
	border-top: 1px solid rgba(255, 255, 255, 0.09);
}
.site-footer-copy {
	margin: 0;
	font-size: 13px;
	line-height: 1.6;
	color: #8aa3ab;
}
.site-footer-copy a {
	color: #8aa3ab;
	text-decoration: none;
	border-bottom: 1px solid rgba(217, 169, 74, 0.45);
}
.site-footer-copy a:hover {
	color: var(--eise-gilt-lt);
	border-bottom-color: var(--eise-gilt-lt);
}
.site-footer-release {
	font-family: var(--eise-mono);
	font-size: 12px;
	letter-spacing: 0.02em;
	color: var(--eise-muted);
}

@media (max-width: 700px) {
	.site-footer {
		padding: 32px 16px 20px;
	}
	.site-footer-cols {
		gap: 20px 24px;
	}
}
</style>
