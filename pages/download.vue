<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Download Eise.app for Desktop - !Experimental!</h2>

			<p>
				These builds are experimental.
				<a href="#" class="show-downloads-link" @click.prevent="showDownloads = true" v-if="!showDownloads">Show downloads</a>
			</p>

			<div class="download-cards" v-if="showDownloads">
				<div class="download-card">
					<div class="platform-icon">&#63743;</div>
					<h3>macOS</h3>
					<a :href="DOWNLOAD_URLS.mac" download class="download-btn" @click="track('download', { os: 'mac' })">Download .dmg</a>
					<p class="platform-note">Apple Silicon (M1+). Right-click → Open on first launch.</p>
				</div>

				<div class="download-card">
					<div class="platform-icon">&#8862;</div>
					<h3>Windows</h3>
					<a :href="DOWNLOAD_URLS.windows" download class="download-btn" @click="track('download', { os: 'windows' })">Download .exe</a>
					<p class="platform-note">Windows 10+. Click "More info" → "Run anyway" if SmartScreen appears.</p>
				</div>

				<div class="download-card">
					<div class="platform-icon">&#9881;</div>
					<h3>Linux</h3>
					<a :href="DOWNLOAD_URLS.linux" download class="download-btn" @click="track('download', { os: 'linux' })">Download .AppImage</a>
					<a :href="DOWNLOAD_URLS.deb" download class="download-btn download-btn-secondary" @click="track('download', { os: 'linux' })">.deb package</a>
					<p class="platform-note">Make AppImage executable: <code>chmod +x Eise*.AppImage</code></p>
				</div>
			</div>

			<p class="version-info" v-if="showDownloads">Version {{ RELEASE_VERSION }} · <a :href="releasesUrl" target="_blank">Release notes</a></p>

			<div class="interest-form">
				<h3>Want a mobile app?</h3>
				<p>Sign up to be notified when native Android/iOS apps become available.</p>

				<form
					action="https://app.us18.list-manage.com/subscribe/post?u=1e23126c833bf49699891f7d2&amp;id=bf3278e839"
					method="POST"
					target="_blank"
					class="signup-form"
				>
					<div class="form-row">
						<label for="mce-EMAIL">Email</label>
						<input type="email" name="EMAIL" id="mce-EMAIL" placeholder="your@email.com" required />
					</div>

					<div class="form-row">
						<label for="mce-PLATFORM">Which platform interests you most?</label>
						<select name="PLATFORM" id="mce-PLATFORM">
							<option value="Mobile - Android">Android</option>
							<option value="Mobile - iOS">iOS</option>
						</select>
					</div>

					<div class="form-row">
						<label for="mce-USECASE">How would you use it? (optional)</label>
						<input type="text" name="USECASE" id="mce-USECASE" placeholder="e.g., phone recordings through eyepiece, then stack with an app." />
					</div>

					<!-- Bot protection -->
					<div style="position: absolute; left: -5000px;" aria-hidden="true">
						<input type="text" name="b_1e23126c833bf49699891f7d2_bf3278e839" tabindex="-1" value="" />
					</div>

					<button type="submit" class="submit-btn">Notify me</button>
				</form>
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
const { track } = useTracking();
const RELEASE_VERSION = '2026.05.20';
const DOWNLOAD_URLS = {
  mac: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.5.20-mac-arm64.dmg',
  windows: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.5.20-windows-arm64.exe',
  linux: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.5.20-linux-arm64.AppImage',
  deb: 'https://github.com/timing/eise.app/releases/latest/download/Eise-2026.5.20-linux-arm64.deb',
};
const releasesUrl = 'https://github.com/timing/eise.app/releases';
const showDownloads = ref(false);

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

.download-btn-secondary {
	background: transparent;
	color: #8CCF7E;
	border: 1px solid #8CCF7E;
	font-size: 0.85rem;
	padding: 0.4rem 1rem;
}

.download-btn-secondary:hover {
	background: rgba(140, 207, 126, 0.1);
	color: #9ddb8f;
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

.signup-form {
	max-width: 400px;
}

.form-row {
	margin-bottom: 1rem;
}

.form-row label {
	display: block;
	margin-bottom: 0.4rem;
	font-weight: 500;
	font-size: 0.9rem;
}

.form-row input,
.form-row select {
	width: 100%;
	padding: 0.6rem 0.8rem;
	border: 1px solid #ccc;
	border-radius: 4px;
	background: #fff;
	color: #222;
	font-size: 1rem;
	box-sizing: border-box;
}

.form-row input:focus,
.form-row select:focus {
	outline: none;
	border-color: #1a5a99;
}

.form-row input::placeholder {
	color: #999;
}

.submit-btn {
	background: #8CCF7E;
	color: #111;
	border: none;
	padding: 0.7rem 1.5rem;
	font-size: 1rem;
	font-weight: bold;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.2s;
	margin-top: 0.5rem;
}

.submit-btn:hover {
	background: #9ddb8f;
}

.current-option {
	margin-top: 2rem;
	padding-top: 1.5rem;
	border-top: 1px solid #e5e5e5;
}

.current-option h3 {
	margin-top: 0;
}

.show-downloads-link {
	color: #1a5a99;
	font-size: 0.9rem;
}
</style>
