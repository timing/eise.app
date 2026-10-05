<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Planetary Image Stacking on Mac</h2>
			<p class="page-subtitle">A guide on how to run the full capture and stacking pipeline on OSX.</p>
			<p>
			Eise.app is a free browser-based planetary image stacker that runs in any modern browser. Therefore also on macOS (Apple Silicon and Intel). There is no need to install anything, no Wine needed, and no Python dependency issues. Next to Eise being a website, you can also <NuxtLink to="/download/">Download Eise for your mac</NuxtLink>.
			</p>

			<h3>What Mac users have for stacking</h3>
			<p>The classic Windows planetary-imaging stack (AutoStakkert! + Registax) doesn't run natively on macOS. Here are some other options.</p>
			<div class="table-wrapper">
				<table class="comparison-table">
					<thead>
						<tr>
							<th>Tool</th>
							<th>Native Mac</th>
							<th>Install</th>
							<th>GPU accelerated</th>
							<th>Cost</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="feature-name">Eise.app</td>
							<td class="highlight">Yes (browser)</td>
							<td class="highlight">Optional</td>
							<td class="highlight">WebGPU (Metal-backed on Apple Silicon)</td>
							<td class="highlight">Free</td>
						</tr>
						<tr>
							<td class="feature-name">Planet Stacker X</td>
							<td class="highlight">Yes (App Store)</td>
							<td>App Store install</td>
							<td class="highlight">Metal</td>
							<td class="highlight">Free</td>
						</tr>
						<tr>
							<td class="feature-name">Planetary System Stacker (PSS)</td>
							<td class="highlight">Yes</td>
							<td>Python + OpenCV + PyQt setup</td>
							<td>No (CPU)</td>
							<td class="highlight">Free</td>
						</tr>
						<tr>
							<td class="feature-name">AutoStakkert!</td>
							<td>No</td>
							<td>Wine, Parallels, or VMware</td>
							<td>Limited</td>
							<td class="highlight">Free</td>
						</tr>
						<tr>
							<td class="feature-name">Registax 6</td>
							<td>No</td>
							<td>Wine only, unmaintained since 2011</td>
							<td>No</td>
							<td class="highlight">Free</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p>Good choices for proper support on Mac are: <strong>Eise.app</strong>, <strong>Planet Stacker X</strong>, or <strong>PSS</strong> if you're comfortable with some CLI struggles. Eise.app has the lowest friction (open a URL) and includes post-processing; Planet Stacker X is a proper Mac-native app with Metal acceleration; PSS is the most technical and hackable.</p>

			<h3>Native Mac capture software</h3>
			<p>Most capture tutorials assume Windows tools (FireCapture, SharpCap), but they don't run well on Mac. Below some that do.</p>

			<h4>ASIStudio (ZWO)</h4>
			<p>
				ZWO ships a native macOS build of ASIStudio, which includes <em>ASICap</em> for high-frame-rate capture. If you have any ZWO ASI planetary camera (ASI224MC, ASI462MC, ASI585MC, ASI662MC, etc.), this is the simplest capture path on Mac. Universal binary, works on Apple Silicon.
				Output: SER (recommended) or AVI - both stack directly in Eise.app.
			</p>

			<h4>AstroDMx Capture</h4>
			<p>
				Cross-platform capture software with a native macOS build. Supports a wide range of astro cameras including many DSLRs, webcams, and dedicated planetary cameras. Good option if your camera isn't a ZWO.
				Output: SER or AVI.
			</p>

			<h4>oaCapture</h4>
			<p>
				Open-source planetary capture software with native Mac builds. Older interface but supports many older webcams and CCDs the newer tools have dropped. Good fallback if you're using vintage gear.
			</p>

			<h4>DSLR live view via a Mac app</h4>
			<p>
				If you're shooting planetary video with a DSLR, tools like <em>digiCamControl</em> (Windows) don't have direct Mac equivalents, but you can use the camera manufacturer's own tethering software (Canon EOS Utility, Sony Imaging Edge, Nikon Camera Control Pro) to capture MP4 or MOV clips, then drop them into Eise.app.
			</p>
			<p>
				You can also skip video entirely. Shoot a burst of RAW stills and drop the whole sequence in: Eise.app reads CR2, CR3, NEF, ARW, RAF, ORF, RW2 and DNG directly, no conversion step. For Bayer sensors the demosaic runs on the GPU from the untouched sensor data, so you keep the full bit depth your camera recorded.
			</p>

			<h3>Why Eise.app works well on Mac specifically</h3>
			<ul>
				<li><strong>Apple Silicon WebGPU acceleration.</strong> M1, M2, M3, and M4 chips expose their GPU through WebGPU, which Eise.app uses for demosaicing, template matching, and stacking. Performance is as good as any native Metal app.</li>
				<li><strong>Safari 18+ supported.</strong> You don't need Chrome. Safari on macOS Sequoia (15+) and iOS 18+ ships WebGPU. Chrome and Edge also work.</li>
				<li><strong>Handles the Mac workflow.</strong> Files from ASIStudio Mac, DSLR clips exported by EOS Utility, screen-recordings from a Seestar S50, and iPhone MOVs all work without conversion.</li>
				<li><strong>Post-processing included.</strong> No separate Registax step. Wavelet sharpening, RGB alignment, deconvolution, and color adjustments all live in the same session.</li>
			</ul>

			<h3>Getting started on Mac (3 steps)</h3>
			<ol>
				<li><strong>Capture</strong> - Use ASIStudio (ZWO cameras) or your DSLR's tethering app. Aim for 30-90 second clips per target. SER format preferred; AVI or MP4 also work.</li>
				<li><strong>Open <NuxtLink to="/">eise.app</NuxtLink></strong> - in Safari, Chrome, or Firefox. Drop the file. Nothing is uploaded; the browser processes locally.</li>
				<li><strong>Stack and sharpen</strong> - Eise.app analyzes frames, crops around the target, aligns, and stacks. Post processor opens after with wavelet sliders. Export as PNG or TIFF.</li>
			</ol>

			<h3>Frequently asked questions</h3>

			<h4>Is Eise.app the best free astrophotography stacking software for Mac?</h4>
			<p>For a lot of Mac users, yes - it's free, native (browser-based), works on Apple Silicon with GPU acceleration, and doesn't require any install. Planet Stacker X is a strong native alternative if you prefer a traditional Mac app. PSS is more capable in some edge cases but requires setting up Python. AutoStakkert requires Wine.</p>

			<h4>Does AutoStakkert work on Mac?</h4>
			<p>Not natively. You can run it under Wine, CrossOver, Parallels, or VMware. It works but adds friction. If you want an equivalent workflow that stays native on Mac, Eise.app covers the stacking and post-processing that AutoStakkert + Registax do on Windows.</p>

			<h4>Can I stack planetary video on M1, M2, M3, or M4 Macs?</h4>
			<p>Yes. Eise.app uses WebGPU, which on Apple Silicon maps to Metal - the same low-level graphics API a native Mac app would use. Performance is roughly comparable to a native Metal app for the compute workload.</p>

			<h4>What if I only have Intel-based Mac?</h4>
			<p>Still works. Safari 18+ and Chrome ship WebGPU on Intel Macs too. Performance will be lower than Apple Silicon (Intel Macs have less capable GPUs) but the pipeline is the same. For heavy workloads Eise.app can fall back to CPU processing.</p>

			<h4>What about Parallels or a Windows VM?</h4>
			<p>If you're already running Parallels for other reasons, AutoStakkert works fine there. But paying for and maintaining a Windows VM just to run one stacking tool is overkill when Eise.app or Planet Stacker X get you the same result natively.</p>

			<h3>Try it</h3>
			<p>The homepage has a sample Jupiter clip you can process without capturing your own footage.</p>
			<NuxtLink to="/" class="cta-link">Try Eise.app in your browser &rarr;</NuxtLink>

			<h3>See also</h3>
			<ul>
				<li><NuxtLink to="/about/planetary-stacking-software-comparison/">Full stacking software comparison</NuxtLink> - all eight tools including Windows</li>
				<li><NuxtLink to="/about/autostakkert-vs-eise/">AutoStakkert! vs Eise.app</NuxtLink> - the Windows industry standard head-to-head</li>
				<li><NuxtLink to="/about/planetary-system-stacker-vs-eise/">Planetary System Stacker vs Eise.app</NuxtLink> - PSS is the other main open-source option on Mac</li>
				<li><NuxtLink to="/about/help/">How Eise.app processes your video</NuxtLink> - the technical guide</li>
				<li><NuxtLink to="/download/">Download the desktop app</NuxtLink> - Electron build for macOS if you prefer an installed app</li>
			</ul>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'Planetary Image Stacking on Mac - Free, Native, No Wine | Eise.app',
	meta: [
		{ name: 'description', content: 'Free planetary image stacker for macOS. Runs natively in Safari or Chrome on Apple Silicon and Intel Macs with WebGPU acceleration. No Wine, no Python setup. Includes wavelet sharpening.' },
	],
});

useBreadcrumbSchema([
	{ name: 'Home', url: 'https://eise.app/' },
	{ name: 'Planetary Stacking on Mac', url: 'https://eise.app/planetary-stacking-mac/' },
]);
</script>

<style scoped>
.verdict {
	background: #eef7ff;
	border-left: 3px solid #1a5a99;
	padding: 12px 18px;
	border-radius: 4px;
	margin: 1.5rem 0;
}
.verdict p {
	margin: 0;
}
.table-wrapper {
	overflow-x: auto;
	margin: 1.5rem 0;
}
.comparison-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 14px;
}
.comparison-table th,
.comparison-table td {
	padding: 10px 12px;
	text-align: left;
	border-bottom: 1px solid #e5e5e5;
}
.comparison-table th {
	background: #f4f4f4;
	color: #222;
	font-weight: 600;
	position: sticky;
	top: 0;
}
.comparison-table th:first-child {
	min-width: 160px;
}
.comparison-table td {
	color: #444;
}
.comparison-table td.feature-name {
	color: #222;
	font-weight: 600;
}
.comparison-table td.highlight {
	color: #2a7a1a;
	font-weight: 600;
}
.comparison-table tbody tr:hover {
	background: rgba(0, 0, 0, 0.025);
}
.cta-link {
	display: inline-block;
	background: #8CCF7E;
	color: #111;
	padding: 10px 24px;
	border-radius: 6px;
	text-decoration: none;
	font-weight: 600;
	margin-top: 0.5rem;
}
.cta-link:hover {
	background: #7abf6e;
}
</style>
