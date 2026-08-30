<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Download Eise.app for Mac, Windows and Linux</h2>
			<p class="page-subtitle">Free planetary image stacker</p>

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

			<div class="comparison">
				<h3>Desktop app vs. web version</h3>
				<p>Stacking uses the same WebGPU pipeline in both, so end results are identical. The desktop build changes what runs in the background and what depends on a network connection.</p>

				<table class="compare-table">
					<thead>
						<tr>
							<th></th>
							<th>Desktop app</th>
							<th>Web (eise.app)</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Runs while minimized</th>
							<td class="yes">Full speed</td>
							<td class="no">Throttled by the browser when the tab is backgrounded</td>
						</tr>
						<tr>
							<th scope="row">Works offline</th>
							<td class="yes">Fully offline after install</td>
							<td class="no">Needs a connection to load the app</td>
						</tr>
						<tr>
							<th scope="row">Updates</th>
							<td>Checks in the background, applies on next launch</td>
							<td>Latest version on every page load</td>
						</tr>
						<tr>
							<th scope="row">WebGPU</th>
							<td class="yes">Always available (bundled Chromium with WebGPU enabled)</td>
							<td>Depends on the browser (Chrome, Edge, and recent Safari support it; some browsers still fall back to the slower CPU path)</td>
						</tr>
						<tr>
							<th scope="row">Stacking speed</th>
							<td colspan="2" class="same">Same. Both use WebGPU when available, so the compute is identical.</td>
						</tr>
						<tr>
							<th scope="row">Privacy</th>
							<td colspan="2" class="same">Same. All processing happens on your machine, no frames leave the device in either version.</td>
						</tr>
						<tr>
							<th scope="row">Install size</th>
							<td>~200 MB (bundled Chromium runtime)</td>
							<td class="yes">Nothing to install</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</template>

<script setup>
import { useTracking } from '~/composables/useTracking';
import MailingListForm from '@/components/MailingListForm.vue';
const { track } = useTracking();
const RELEASE_VERSION = '2026.08.30';
const DOWNLOAD_URLS = {
  mac: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.8.30-mac-arm64.dmg',
  windows: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.8.30-win-x64.exe',
  windowsArm64: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.8.30-win-arm64.exe',
  linux: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.8.30-linux-arm64.AppImage',
  deb: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.8.30-linux-arm64.deb',
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
	grid-template-columns: repeat(3, 1fr);
	gap: 1rem;
	margin: 2rem 0;
}

@media (max-width: 600px) {
	.download-cards {
		grid-template-columns: 1fr;
	}
}

.download-card {
	background: #f7f7f7;
	border: 1px solid #e5e5e5;
	border-radius: 8px;
	padding: 1.25rem 1rem;
	text-align: center;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.6rem;
}

/* Higher specificity so the global .content-card h3 (margin: 40px 0 12px in
   app.vue) doesn't add a big gap between icon and title. */
.download-cards .download-card h3 {
	margin: 0;
	font-size: 1.25rem;
	line-height: 1.2;
}

.platform-icon {
	font-size: 2rem;
	line-height: 1;
	margin: 0;
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
}

.download-btn:hover {
	background: #9ddb8f;
}

.deb-alt {
	margin: 0;
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
	margin: 0;
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
	margin: 1.25rem 0 2rem;
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

.comparison {
	margin: 2rem 0;
	padding-top: 1.5rem;
	border-top: 1px solid #e5e5e5;
}

.comparison h3 {
	margin-top: 0;
}

.compare-table {
	width: 100%;
	border-collapse: collapse;
	margin-top: 1rem;
	font-size: 0.9rem;
	background: #fefefe;
	border: 1px solid #e5e5e5;
	border-radius: 8px;
	overflow: hidden;
}

.compare-table th,
.compare-table td {
	padding: 0.7rem 1rem;
	text-align: left;
	border-bottom: 1px solid #e5e5e5;
	vertical-align: top;
}

.compare-table thead th {
	background: #f7f7f7;
	font-weight: bold;
}

.compare-table tbody th {
	background: #f7f7f7;
	font-weight: 500;
	width: 32%;
}

.compare-table tr:last-child th,
.compare-table tr:last-child td {
	border-bottom: none;
}

.compare-table td.yes {
	color: #7ABF6E;
	font-weight: 500;
}

.compare-table td.no {
	color: #666;
}

.compare-table td.same {
	color: #666;
	font-style: italic;
	text-align: center;
}

@media (max-width: 600px) {
	.compare-table {
		font-size: 0.8rem;
	}
	.compare-table th,
	.compare-table td {
		padding: 0.5rem 0.6rem;
	}
}

</style>
