<template>
	<div class="download-page">
		<article class="download-panel">
			<h1>Download Eise.app for Mac, Windows and Linux</h1>
			<p class="page-subtitle">Free planetary image stacker</p>

			<p class="download-intro">Native desktop builds of Eise.app for macOS (Apple Silicon), Windows 10+, and Linux. Free planetary image stacker with the same features as the browser version - lucky imaging, alignment-point stacking, wavelet sharpening, RGB alignment - running offline on your own machine.</p>

			<div class="section-head">
				<h2>Choose your platform</h2>
				<span class="version-info">Version {{ RELEASE_VERSION }} · <a :href="releasesUrl" target="_blank">Release notes</a></span>
			</div>

			<div class="download-cards">
				<div class="download-card">
					<div class="platform-head">
						<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.7 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.8-3.6 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 0 1.9-1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.2-.9-2.2-3.3zM14.6 5.6c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.6-.9 2.6 1 .1 2-.5 2.6-1.2z" /></svg>
						<h3>macOS</h3>
					</div>
					<a :href="DOWNLOAD_URLS.mac" download class="download-btn" @click="track('download', { os: 'mac' })">Download .dmg</a>
					<p class="platform-desc">Apple Silicon (M1+).</p>
					<p class="platform-note">Right-click → Open on first launch.</p>
				</div>

				<div class="download-card">
					<div class="platform-head">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.6l7.6-1v7.1H3V5.6zM11.8 4.4L21 3v8.7h-9.2V4.4zM3 12.9h7.6V20L3 18.7v-5.8zM11.8 12.9H21V21l-9.2-1.3v-6.8z" /></svg>
						<h3>Windows</h3>
					</div>
					<a :href="DOWNLOAD_URLS.windows" download class="download-btn" @click="track('download', { os: 'windows', arch: 'x64' })">Download .exe</a>
					<p class="platform-desc">Windows 10+. Or the <a :href="DOWNLOAD_URLS.windowsArm64" download @click="track('download', { os: 'windows', arch: 'arm64' })">ARM64 build</a> for Snapdragon / Surface Pro X.</p>
					<p class="platform-note">Click "More info" → "Run anyway" if SmartScreen appears.</p>
				</div>

				<div class="download-card">
					<div class="platform-head">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3.1" /><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" stroke-linecap="round" /></svg>
						<h3>Linux</h3>
					</div>
					<a :href="DOWNLOAD_URLS.linux" download class="download-btn" @click="track('download', { os: 'linux', arch: 'x64' })">Download .AppImage</a>
					<p class="platform-desc">x64. Or grab the <a :href="DOWNLOAD_URLS.deb" download @click="track('download', { os: 'linux', arch: 'x64' })">.deb package</a> for Debian / Ubuntu. On ARM64, take the <a :href="DOWNLOAD_URLS.linuxArm64" download @click="track('download', { os: 'linux', arch: 'arm64' })">.AppImage</a> or <a :href="DOWNLOAD_URLS.debArm64" download @click="track('download', { os: 'linux', arch: 'arm64' })">.deb</a>.</p>
					<div class="platform-note">
						<p>Make AppImage executable:</p>
						<code>chmod +x Eise*.AppImage</code>
					</div>
				</div>
			</div>

			<div class="interest-form">
				<h2>Want a mobile app?</h2>
				<p>Eise.app already runs in mobile browsers. A native iOS and Android build is on the list. Sign up to the mailinglist to be notified when it becomes available.</p>

				<MailingListForm
					:show-platform="true"
					submit-label="Notify me"
					usecase-label="How would you use it? (optional)"
					usecase-placeholder="e.g., phone recordings through eyepiece, then stack with an app."
					track-source="download-mobile"
				/>
			</div>

			<div class="comparison">
				<h2>Desktop app vs. web version</h2>
				<p>Stacking uses the same WebGPU pipeline in both, so end results are identical. The desktop build changes what runs in the background and what depends on a network connection.</p>

				<div class="table-scroll">
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
		</article>
	</div>
</template>

<script setup>
import { useTracking } from '~/composables/useTracking';
import MailingListForm from '@/components/MailingListForm.vue';
const { track } = useTracking();
const RELEASE_VERSION = '2026.09.19';
// Pinned to the release tag rather than /releases/latest/download/: the filenames
// carry the version anyway, so "latest" bought nothing and broke every link during
// the window between publishing a release and deploying this page.
// electron-builder drops the leading zeros when it names artifacts, so the file
// version and the display version differ.
const RELEASE_TAG = `v${RELEASE_VERSION}`;
const FILE_VERSION = '2026.9.19';
const RELEASE_BASE = `https://github.com/timing/eise.app/releases/download/${RELEASE_TAG}`;
const DOWNLOAD_URLS = {
  mac: `${RELEASE_BASE}/Eise-${FILE_VERSION}-mac-arm64.dmg`,
  windows: `${RELEASE_BASE}/Eise-${FILE_VERSION}-win-x64.exe`,
  windowsArm64: `${RELEASE_BASE}/Eise-${FILE_VERSION}-win-arm64.exe`,
  linux: `${RELEASE_BASE}/Eise-${FILE_VERSION}-linux-x86_64.AppImage`,
  linuxArm64: `${RELEASE_BASE}/Eise-${FILE_VERSION}-linux-arm64.AppImage`,
  deb: `${RELEASE_BASE}/Eise-${FILE_VERSION}-linux-amd64.deb`,
  debArm64: `${RELEASE_BASE}/Eise-${FILE_VERSION}-linux-arm64.deb`,
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
.download-page {
	width: 100%;
	max-width: 1000px;
	margin: 0 auto;
	padding: 44px 28px 88px;
	box-sizing: border-box;
}
.download-panel {
	display: block;
	padding: 52px 56px 48px;
	background: var(--eise-panel);
	border: 1px solid var(--eise-panel-border);
	border-radius: 14px;
	box-shadow: 0 12px 40px rgba(3, 16, 22, 0.34);
	color: var(--eise-bright);
}
.download-panel h1 {
	margin: 0;
	font-size: 34px;
	line-height: 1.18;
	font-weight: 600;
	letter-spacing: -0.025em;
	color: var(--eise-bright);
	text-wrap: balance;
}
.page-subtitle {
	margin: 10px 0 0;
	font-size: 15px;
	color: var(--eise-muted-2);
}
.download-intro {
	margin: 26px 0 0;
	max-width: 66ch;
	font-size: 16px;
	line-height: 1.65;
	color: var(--eise-body);
	text-wrap: pretty;
}

/* Section heading with the release stamp on the same rule. */
.section-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 20px;
	flex-wrap: wrap;
	margin: 44px 0 18px;
	padding-bottom: 12px;
	border-bottom: 1px solid rgba(255, 255, 255, 0.13);
}
.section-head h2 {
	margin: 0;
	font-size: 19px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--eise-bright);
}
.version-info {
	font-family: var(--eise-mono);
	font-size: 12px;
	color: var(--eise-muted-2);
}

.download-cards {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
	gap: 16px;
}
/* Rows: header, button, description, note pinned to the bottom so the cards
   line up however long the descriptions run. */
.download-card {
	display: grid;
	grid-template-rows: auto auto auto 1fr;
	gap: 14px;
	padding: 20px;
	background: rgba(255, 255, 255, 0.045);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 10px;
}
.platform-head {
	display: flex;
	align-items: center;
	gap: 9px;
	color: var(--eise-bright);
}
.platform-head h3 {
	margin: 0;
	font-size: 15px;
	font-weight: 600;
	color: var(--eise-bright);
}
.download-btn {
	display: block;
	padding: 10px 14px;
	border: none;
	border-radius: 7px;
	background: var(--eise-gilt);
	color: var(--eise-ink);
	font-size: 14px;
	font-weight: 600;
	text-align: center;
	text-decoration: none;
}
.download-btn:hover {
	background: var(--eise-gilt-lt);
	color: var(--eise-ink);
}
.platform-desc {
	margin: 0;
	font-size: 13px;
	line-height: 1.55;
	color: var(--eise-body);
}
.platform-note {
	margin: 0;
	align-self: end;
	font-size: 12.5px;
	line-height: 1.55;
	color: var(--eise-muted-2);
}
.platform-note p {
	margin: 0 0 6px;
}
.platform-note code {
	display: block;
	padding: 7px 9px;
	border-radius: 5px;
	background: rgba(0, 0, 0, 0.35);
	color: var(--eise-gilt-lt);
	font-family: var(--eise-mono);
	font-size: 11.5px;
	line-height: 1.5;
	overflow-wrap: anywhere;
}
.download-panel a:not(.download-btn) {
	color: var(--eise-link);
	text-decoration: none;
	border-bottom: 1px solid rgba(143, 207, 224, 0.35);
}
.download-panel a:not(.download-btn):hover {
	color: #b7e4f2;
	border-bottom-color: rgba(183, 228, 242, 0.6);
}

/* Mobile-app interest. The design collapses this to a single "Request it"
   link; the signup form stays open here so people can actually sign up. */
.interest-form {
	margin-top: 36px;
	padding: 20px 22px;
	border-radius: 10px;
	background: rgba(255, 255, 255, 0.045);
	border: 1px solid rgba(255, 255, 255, 0.1);
}
.interest-form h2 {
	margin: 0 0 5px;
	font-size: 17px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--eise-bright);
}
.interest-form > p {
	margin: 0 0 18px;
	max-width: 58ch;
	font-size: 14px;
	line-height: 1.6;
	color: var(--eise-body);
}
/* MailingListForm is scoped and light-themed; only this page's copy is dark. */
.interest-form :deep(.form-row label) {
	color: var(--eise-body);
	font-size: 13px;
}
.interest-form :deep(.form-row input),
.interest-form :deep(.form-row select) {
	background: rgba(0, 0, 0, 0.22);
	border: 1px solid var(--eise-panel-border);
	color: var(--eise-bright);
}
.interest-form :deep(.form-row input::placeholder) {
	color: var(--eise-label);
}
.interest-form :deep(.form-row input:focus),
.interest-form :deep(.form-row select:focus) {
	border-color: var(--eise-gilt);
	outline: none;
}
.interest-form :deep(.form-row select option) {
	background: var(--eise-panel);
	color: var(--eise-bright);
}
.interest-form :deep(.submit-btn) {
	background: var(--eise-gilt);
	color: var(--eise-ink);
}
.interest-form :deep(.submit-btn:hover) {
	background: var(--eise-gilt-lt);
}

/* Desktop vs web. Not in the design, kept and themed to match. */
.comparison {
	margin-top: 40px;
	padding-top: 28px;
	border-top: 1px solid rgba(255, 255, 255, 0.13);
}
.comparison h2 {
	margin: 0 0 8px;
	font-size: 19px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--eise-bright);
}
.comparison > p {
	margin: 0 0 18px;
	max-width: 66ch;
	font-size: 15px;
	line-height: 1.6;
	color: var(--eise-body);
}
.table-scroll {
	overflow-x: auto;
}
.compare-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 14px;
	line-height: 1.55;
	background: rgba(0, 0, 0, 0.18);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 10px;
	overflow: hidden;
}
.compare-table th,
.compare-table td {
	padding: 11px 14px;
	text-align: left;
	vertical-align: top;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	color: var(--eise-body);
}
.compare-table thead th {
	background: rgba(255, 255, 255, 0.05);
	font-weight: 600;
	color: var(--eise-bright);
}
.compare-table tbody th {
	background: rgba(255, 255, 255, 0.03);
	font-weight: 500;
	width: 32%;
	color: var(--eise-bright);
}
.compare-table tr:last-child th,
.compare-table tr:last-child td {
	border-bottom: none;
}
.compare-table td.yes {
	color: #a8dcb9;
	font-weight: 500;
}
.compare-table td.no {
	color: var(--eise-muted-2);
}
.compare-table td.same {
	color: var(--eise-muted-2);
	font-style: italic;
	text-align: center;
}

@media (max-width: 700px) {
	.download-page {
		padding: 24px 16px 64px;
	}
	.download-panel {
		padding: 28px 22px 26px;
	}
	.download-panel h1 {
		font-size: 26px;
	}
	.compare-table {
		font-size: 13px;
	}
	.compare-table th,
	.compare-table td {
		padding: 8px 10px;
	}
}
</style>
