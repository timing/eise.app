<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Download Eise.app for Mac, Windows and Linux &mdash; Free Planetary Image Stacker</h2>

			<p>Native desktop builds of Eise.app for macOS (Apple Silicon), Windows 10+, and Linux. Free planetary image stacker with the same features as the browser version - lucky imaging, alignment-point stacking, wavelet sharpening, RGB alignment - running offline on your own machine.</p>

			<h3>Choose your platform</h3>

			<div class="download-cards">
				<div class="download-card">
					<div class="platform-icon">&#63743;</div>
					<h3>macOS</h3>
					<a :href="DOWNLOAD_URLS.mac" download class="download-btn" @click="track('download', { os: 'mac' })">Download .dmg</a>
					<p class="platform-note">Apple Silicon (M1+). Right-click → Open on first launch.</p>
				</div>

				<div class="download-card">
					<div class="platform-icon">&#8862;</div>
					<h3>Windows</h3>
					<a :href="DOWNLOAD_URLS.windows" download class="download-btn" @click="track('download', { os: 'windows', arch: 'x64' })">Download .exe</a>
					<p class="deb-alt">or the <a :href="DOWNLOAD_URLS.windowsArm64" download @click="track('download', { os: 'windows', arch: 'arm64' })">ARM64 build</a> for Snapdragon / Surface Pro X</p>
					<p class="platform-note">Windows 10+. Click "More info" → "Run anyway" if SmartScreen appears.</p>
				</div>

				<div class="download-card">
					<div class="platform-icon">&#9881;</div>
					<h3>Linux</h3>
					<a :href="DOWNLOAD_URLS.linux" download class="download-btn" @click="track('download', { os: 'linux' })">Download .AppImage</a>
					<p class="deb-alt">or grab the <a :href="DOWNLOAD_URLS.deb" download @click="track('download', { os: 'linux' })">.deb package</a> for Debian / Ubuntu</p>
					<p class="platform-note">Make AppImage executable: <code>chmod +x Eise*.AppImage</code></p>
				</div>
			</div>

			<p class="version-info">Version {{ RELEASE_VERSION }} · <a :href="releasesUrl" target="_blank">Release notes</a></p>

			<div class="interest-form">
				<h3>Want a mobile app?</h3>
				<p>Sign up to the mailinglist to be notified when native Android/iOS apps become available.</p>

				<MailingListForm
					:show-platform="true"
					submit-label="Notify me"
					usecase-label="How would you use it? (optional)"
					usecase-placeholder="e.g., phone recordings through eyepiece, then stack with an app."
					track-source="download-mobile"
				/>
			</div>

			<div class="current-option">
				<h3>Or use the web version</h3>
				<p>
					No download needed —
					<NuxtLink to="/">start stacking</NuxtLink> right in your browser.
					Same features, works on any device with a modern browser.
				</p>
			</div>
		</div>
	</div>
</template>

<script setup>
import { useTracking } from '~/composables/useTracking';
import MailingListForm from '@/components/MailingListForm.vue';
const { track } = useTracking();
const RELEASE_VERSION = '2026.08.16';
const DOWNLOAD_URLS = {
  mac: 'https://github.com/timing/eise.app/releases/download/v2026.08.16/Eise-2026.8.16-mac-arm64.dmg',
  windows: 'https://github.com/timing/eise.app/releases/download/v2026.08.16/Eise-2026.8.16-win-x64.exe',
  windowsArm64: 'https://github.com/timing/eise.app/releases/download/v2026.08.16/Eise-2026.8.16-win-arm64.exe',
  linux: 'https://github.com/timing/eise.app/releases/download/v2026.08.16/Eise-2026.8.16-linux-arm64.AppImage',
  deb: 'https://github.com/timing/eise.app/releases/download/v2026.08.16/Eise-2026.8.16-linux-arm64.deb',
};
const releasesUrl = 'https://github.com/timing/eise.app/releases';

useHead({
	title: 'Download Eise.app - Desktop App for macOS, Windows, Linux',
	meta: [
		{ name: 'description', content: 'Download Eise.app for macOS, Windows, or Linux. Free offline planetary image stacker for astrophotography.' },
	],
});

useBreadcrumbSchema([
	{ name: 'Home', url: 'https://eise.app/' },
	{ name: 'Download', url: 'https://eise.app/download/' },
]);
</script>

<style scoped>
.download-cards {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 1.5rem;
	margin: 2rem 0;
}

.download-card {
	background: #f7f7f7;
	border: 1px solid #e5e5e5;
	border-radius: 8px;
	padding: 1.5rem;
	text-align: center;
}

.download-card h3 {
	margin: 0.5rem 0 1rem;
}

.platform-icon {
	font-size: 2.5rem;
	line-height: 1;
}

.download-btn {
	display: inline-block;
	background: #8CCF7E;
	color: #111;
	text-decoration: none;
	padding: 0.7rem 1.5rem;
	font-size: 1rem;
	font-weight: bold;
	border-radius: 4px;
	transition: background 0.2s;
	margin-bottom: 0.5rem;
}

.download-btn:hover {
	background: #9ddb8f;
}

.deb-alt {
	margin: 0.5rem 0 0;
	font-size: 0.85rem;
	color: #666;
}
.deb-alt a {
	color: #1a5a99;
	font-weight: 500;
}

.platform-note {
	font-size: 0.8rem;
	color: #666;
	margin-top: 0.75rem;
	line-height: 1.4;
}

.platform-note code {
	background: #ececec;
	color: #222;
	padding: 0.1rem 0.3rem;
	border-radius: 3px;
	font-size: 0.75rem;
}

.version-info {
	text-align: center;
	color: #666;
	font-size: 0.85rem;
}

.version-info a {
	color: #1a5a99;
}

.interest-form {
	background: #f7f7f7;
	border: 1px solid #e5e5e5;
	border-radius: 8px;
	padding: 1.5rem 2rem;
	margin: 2rem 0;
}

.interest-form h3 {
	margin-top: 0;
}

.current-option {
	margin-top: 2rem;
	padding-top: 1.5rem;
	border-top: 1px solid #e5e5e5;
}

.current-option h3 {
	margin-top: 0;
}
</style>
