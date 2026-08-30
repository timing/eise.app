<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>AutoStakkert! vs Eise.app</h2>
			<p class="page-subtitle">Which planetary stacker should you use?</p>
			<p>
				AutoStakkert! (by Emil Kraaikamp) has been the industry-standard planetary stacker for over a decade.
				The current stable release is AutoStakkert!4 4.0.11 (January 2024); 4.0.13 (February 2025) is a newer beta build.
				Eise.app is a newer browser-based alternative built for people who want to stack a video without installing anything.
				This page compares the two honestly so you can pick the right tool for your workflow.
			</p>

			<div class="verdict">
				<p><strong>Short version:</strong> AutoStakkert! is the more mature and battle-tested tool if you're on Windows and comfortable installing native software. Eise.app is the more approachable choice if you're new to planetary imaging, want stacking and post-processing bundled together, work on macOS or Linux without Wine, or want an open-source tool that will keep evolving.</p>
			</div>

			<h3>Feature-by-Feature Comparison</h3>
			<div class="table-wrapper">
				<table class="comparison-table">
					<thead>
						<tr>
							<th>Feature</th>
							<th>AutoStakkert!</th>
							<th>Eise.app</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="feature-name">Install required</td>
							<td>Yes (Windows binary)</td>
							<td class="highlight">No - runs in browser</td>
						</tr>
						<tr>
							<td class="feature-name">Native platform</td>
							<td>Windows</td>
							<td class="highlight">Any (browser)</td>
						</tr>
						<tr>
							<td class="feature-name">Mac / Linux support</td>
							<td>Wine / VM only</td>
							<td class="highlight">Native (browser)</td>
						</tr>
						<tr>
							<td class="feature-name">Mobile / tablet</td>
							<td>No</td>
							<td class="highlight">Yes (limited)</td>
						</tr>
						<tr>
							<td class="feature-name">Price</td>
							<td>Free</td>
							<td>Free</td>
						</tr>
						<tr>
							<td class="feature-name">Uploads your data</td>
							<td>No (local)</td>
							<td>No (local, in-browser)</td>
						</tr>
						<tr>
							<td class="feature-name">Input formats (native)</td>
							<td>SER, AVI, FITS, image files</td>
							<td class="highlight">SER, AVI, MP4, MOV, WebM, image sequences</td>
						</tr>
						<tr>
							<td class="feature-name">MP4 / MOV / HEVC</td>
							<td>Requires user to download FFmpeg and place <code>ffmpeg.exe</code> next to <code>autostakkert.exe</code></td>
							<td class="highlight">Built in (FFmpeg-WASM bundled, auto-loaded)</td>
						</tr>
						<tr>
							<td class="feature-name">Phone video (iPhone MOV / Android VFR MP4)</td>
							<td>Works only after the FFmpeg drop-in, and some VFR files still need PIPP first</td>
							<td class="highlight">Direct drop-in</td>
						</tr>
						<tr>
							<td class="feature-name">Alignment points</td>
							<td class="highlight">Yes, mature implementation</td>
							<td>Yes</td>
						</tr>
						<tr>
							<td class="feature-name">Drizzle stacking</td>
							<td class="highlight">Yes (1.5x, 3x)</td>
							<td>Yes (1.5x bicubic and pixfrac beta)</td>
						</tr>
						<tr>
							<td class="feature-name">Integrated post-processing</td>
							<td>No (pair with Registax / ImPPG / AstroSurface)</td>
							<td class="highlight">Yes (wavelets, RGB alignment, color)</td>
						</tr>
						<tr>
							<td class="feature-name">GPU acceleration</td>
							<td>Limited</td>
							<td class="highlight">WebGPU (when available)</td>
						</tr>
						<tr>
							<td class="feature-name">Community / documentation</td>
							<td class="highlight">Large, decade-plus history</td>
							<td>New (2026)</td>
						</tr>
						<tr>
							<td class="feature-name">Open source</td>
							<td>No (closed source)</td>
							<td class="highlight">Yes (MIT-style, on GitHub)</td>
						</tr>
						<tr>
							<td class="feature-name">Development pace</td>
							<td>Slow (AS!4 4.0.11 stable Jan 2024, 4.0.13 beta Feb 2025, no releases since)</td>
							<td class="highlight">Active (weekly changes)</td>
						</tr>
						<tr>
							<td class="feature-name">Beginner-friendly</td>
							<td>Powerful, but many settings to learn</td>
							<td class="highlight">Yes - sensible defaults, guided flow</td>
						</tr>
						<tr>
							<td class="feature-name">Maturity</td>
							<td class="highlight">Battle-tested since 2012</td>
							<td>Beta - active development</td>
						</tr>
					</tbody>
				</table>
			</div>

			<h3>When AutoStakkert! is the better choice</h3>
			<ul>
				<li><strong>You're on Windows and stacking is your main workflow.</strong> AutoStakkert! is fast, mature, and integrates well with the wider Windows astrophotography ecosystem (SharpCap, FireCapture, Registax).</li>
				<li><strong>You already know it.</strong> Every tutorial, every YouTube video, every forum thread about planetary stacking references AutoStakkert!. If you have muscle memory for the workflow, there's no urgent reason to switch.</li>
				<li><strong>You need very large drizzle or very heavy stacks.</strong> A native binary with a full desktop CPU/RAM budget can crunch through frame counts that a browser sandbox will struggle with.</li>
				<li><strong>You want the most refined alignment-point implementation available.</strong> Emil has spent over a decade tuning AS!, and it shows in edge cases.</li>
			</ul>

			<h3>When Eise.app is the better choice</h3>
			<ul>
				<li><strong>You're new to planetary stacking.</strong> Eise.app was designed to work well with defaults. Frame ranking, cropping, alignment, and sensible sharpening are all set up out of the box - you can get to a decent result without knowing what "AP size" or "double stack reference" means yet. Compare to AutoStakkert!, which is powerful but has more settings to learn upfront.</li>
				<li><strong>You're on macOS or Linux.</strong> No Wine, no CrossOver, no VM. Eise.app runs natively in the browser on Apple Silicon and Linux.</li>
				<li><strong>You want to try stacking without committing to an install.</strong> Open the page, drop a file, see a result in seconds.</li>
				<li><strong>You shoot planetary video with a phone or DSLR.</strong> AutoStakkert! reads SER and AVI natively, but MP4, MOV, and HEVC files (typical of iPhone, Android, and mirrorless cameras) only work after you separately download FFmpeg and drop <code>ffmpeg.exe</code> into the AutoStakkert! folder. Eise.app has that layer built in - the same phone clip just opens.</li>
				<li><strong>You want stacking and post-processing in one tool.</strong> Wavelet sharpening, RGB alignment, deconvolution, and color adjustments are built in - no need to save a TIFF and open Registax or ImPPG afterwards.</li>
				<li><strong>You want long-term insurance against a tool going stale.</strong> Eise.app is open-source under active development. If maintenance ever slows, the code is on GitHub and forkable. AutoStakkert! is closed-source and its blog has been quiet since around 2020 - the app still works well, but if you rely on it heavily and it ever stops running on a future OS update, you'd be stuck.</li>
				<li><strong>You're stacking on a shared or work computer.</strong> Nothing to install, no admin rights needed.</li>
				<li><strong>You want to try stacking on mobile.</strong> It's slower and RAM-constrained, but it does work on a modern phone or tablet.</li>
			</ul>

			<h3>Technical Differences</h3>
			<p>
				<strong>Architecture.</strong> AutoStakkert! is a native Windows application. It has direct access to the file system, full CPU threading, and OS-level memory. Eise.app runs in a browser sandbox: file access is user-initiated, memory is limited (~2-4 GB per tab depending on browser), and processing uses WebGPU compute shaders and WebAssembly. That trade-off buys cross-platform portability at some cost in peak throughput.
			</p>
			<p>
				<strong>Alignment.</strong> Both tools use alignment-point-based local warping to compensate for atmospheric seeing across the frame. AutoStakkert!'s implementation is the more refined - years of tuning show up in edge cases (very low light, extreme seeing, dense AP grids). Eise.app implements the same core approach with WebGPU-accelerated template matching.
			</p>
			<p>
				<strong>Post-processing.</strong> AutoStakkert! deliberately doesn't do post-processing - the assumption is you'll pass the stacked output to Registax (wavelets), ImPPG (deconvolution), or AstroSurface for sharpening. Eise.app bundles wavelet sharpening, deconvolution, and RGB alignment into the same session.
			</p>
			<p>
				<strong>Video file support.</strong> AutoStakkert!3 and AS!4 read SER, AVI, FITS, and image files directly. For MP4, MOV, and HEVC video (typical of iPhone footage, DSLR/mirrorless clips, and Android recordings), AS! shells out to an external <code>ffmpeg.exe</code> that the user has to download separately and place in the same folder as the AutoStakkert! executable. Without that step, the file simply doesn't open. Variable-frame-rate MP4s from phones often still need a pass through PIPP first. Eise.app bundles FFmpeg-WASM inside the browser app: any supported video format works on drop without any extra downloads or file management.
			</p>
			<p>
				<strong>Privacy.</strong> Both tools process your data locally. AutoStakkert! runs on your machine. Eise.app runs in your browser - nothing is uploaded to a server.
			</p>

			<h3>Try Eise.app</h3>
			<p>The fastest way to compare the two is to run the same SER or AVI through both.</p>
			<NuxtLink to="/" class="cta-link">Try Eise.app in your browser &rarr;</NuxtLink>

			<h3>See also</h3>
			<ul>
				<li><NuxtLink to="/about/registax-vs-eise/">Registax 6 vs Eise.app</NuxtLink> - the classic wavelet sharpener compared</li>
				<li><NuxtLink to="/about/planetary-system-stacker-vs-eise/">Planetary System Stacker vs Eise.app</NuxtLink> - the Python cross-platform alternative</li>
				<li><NuxtLink to="/about/planetary-stacking-software-comparison/">Full planetary stacking software comparison</NuxtLink> - all eight tools side by side</li>
			</ul>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'AutoStakkert! vs Eise.app - Compare Planetary Stacking Software',
	meta: [
		{ name: 'description', content: 'AutoStakkert! is the standard for planetary stacking on Windows. Eise.app runs in your browser on any OS with integrated post-processing. Compare features, workflow, and when each is the better fit.' },
	],
});

useBreadcrumbSchema([
	{ name: 'Home', url: 'https://eise.app/' },
	{ name: 'About', url: 'https://eise.app/about/' },
	{ name: 'AutoStakkert! vs Eise.app', url: 'https://eise.app/about/autostakkert-vs-eise/' },
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
