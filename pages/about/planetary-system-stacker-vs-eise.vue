<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Planetary System Stacker (PSS) vs Eise.app</h2>
			<p class="page-subtitle">Which should you use?</p>
			<p>
				Planetary System Stacker (PSS) by Rolf Hempel is an open-source Python stacker with a well-documented pipeline
				and a strong technical reputation among astrophotographers who want to see (and understand) the internals.
				Eise.app draws direct inspiration from PSS - its alignment-point approach and quality-weighted stacking
				come from PSS's original design.
				This page compares the two honestly.
			</p>

			<div class="verdict">
				<p><strong>Short version:</strong> PSS is the better choice if you like open-source Python software, want to inspect or modify the pipeline, and don't mind installing Python dependencies. Eise.app is the better choice if you're new to planetary imaging, want to skip the install entirely, work on a Mac or mobile device, or benefit from GPU acceleration in a browser.</p>
			</div>

			<h3>Feature-by-Feature Comparison</h3>
			<div class="table-wrapper">
				<table class="comparison-table">
					<thead>
						<tr>
							<th>Feature</th>
							<th>Planetary System Stacker</th>
							<th>Eise.app</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="feature-name">Install required</td>
							<td>Yes (Python + dependencies)</td>
							<td class="highlight">No - runs in browser</td>
						</tr>
						<tr>
							<td class="feature-name">Platform</td>
							<td>Win, Mac, Linux (via Python)</td>
							<td class="highlight">Any (browser)</td>
						</tr>
						<tr>
							<td class="feature-name">Source available</td>
							<td class="highlight">Yes (open source on GitHub)</td>
							<td class="highlight">Yes (open source on GitHub)</td>
						</tr>
						<tr>
							<td class="feature-name">Language / stack</td>
							<td>Python (OpenCV, NumPy, PyQt)</td>
							<td>JavaScript + WebGPU + WASM</td>
						</tr>
						<tr>
							<td class="feature-name">Price</td>
							<td>Free</td>
							<td>Free</td>
						</tr>
						<tr>
							<td class="feature-name">Alignment-point pipeline</td>
							<td class="highlight">Yes - reference implementation</td>
							<td>Yes (inspired by PSS)</td>
						</tr>
						<tr>
							<td class="feature-name">Drizzle stacking</td>
							<td>No</td>
							<td class="highlight">Yes (1.5x)</td>
						</tr>
						<tr>
							<td class="feature-name">Integrated post-processing</td>
							<td>Basic (Registax typically used after)</td>
							<td class="highlight">Yes (wavelets, RGB, color)</td>
						</tr>
						<tr>
							<td class="feature-name">GPU acceleration</td>
							<td>No (CPU/NumPy)</td>
							<td class="highlight">WebGPU (when available)</td>
						</tr>
						<tr>
							<td class="feature-name">Extensibility</td>
							<td class="highlight">High (Python, hackable)</td>
							<td>Medium (fork the JS)</td>
						</tr>
						<tr>
							<td class="feature-name">Community docs</td>
							<td class="highlight">Excellent (Rolf's writeups)</td>
							<td>Growing</td>
						</tr>
						<tr>
							<td class="feature-name">Beginner-friendly</td>
							<td>Steeper learning curve (Python setup + PSS UI)</td>
							<td class="highlight">Yes - guided flow, sensible defaults</td>
						</tr>
					</tbody>
				</table>
			</div>

			<h3>When PSS is the better choice</h3>
			<ul>
				<li><strong>You're a technical user who wants to read (or modify) the source.</strong> Rolf Hempel documented the pipeline extensively. If you want to understand exactly how alignment points work, PSS is a teaching tool as much as it is a stacker.</li>
				<li><strong>You're already in the Python data-science stack.</strong> If NumPy and Jupyter are already your daily drivers, adding PSS is trivial.</li>
				<li><strong>You want to script or batch large runs from a terminal.</strong> Python integrates cleanly with shell scripting; browser tools don't.</li>
				<li><strong>You want a pure open-source solution with a mature codebase.</strong> PSS has been in development since 2019.</li>
			</ul>

			<h3>When Eise.app is the better choice</h3>
			<ul>
				<li><strong>You're new to planetary imaging.</strong> Eise.app is designed to produce a good result with defaults - quality-weighted stacking, auto crop centering, wavelet sharpening presets. PSS is powerful but exposes more of the pipeline to the user; the Python setup itself is an obstacle for many first-timers.</li>
				<li><strong>You don't want to install Python and configure a virtual environment.</strong> For many users, "install Python 3.x, install pip packages, resolve OpenCV binaries" is where the friction is. Eise.app skips all of that.</li>
				<li><strong>You want GPU acceleration.</strong> PSS is CPU-only. Eise.app uses WebGPU for demosaicing, template matching, and stacking when the browser supports it.</li>
				<li><strong>You want integrated post-processing.</strong> PSS is stacking-focused. Eise.app includes wavelet sharpening, deconvolution, and RGB alignment in the same session.</li>
				<li><strong>You want to stack on a tablet or phone.</strong> Not PSS's use case; works in Eise.app (with performance caveats).</li>
				<li><strong>You want to try it before committing.</strong> Open the URL, drop a file. Zero setup.</li>
			</ul>

			<h3>Technical Differences</h3>
			<p>
				<strong>Shared ancestry.</strong> Eise.app's alignment-point approach, local de-warping, and quality-weighted stacking are directly inspired by PSS. If you've read Rolf's writeups on how PSS works, you'll recognize the same core algorithms in Eise.app - re-implemented in JavaScript and WebGPU.
			</p>
			<p>
				<strong>Runtime.</strong> PSS runs on CPython with NumPy/OpenCV. Eise.app runs in the browser using WebGPU compute shaders for the heavy lifting and WebAssembly (OpenCV.js compiled to WASM) as a CPU fallback.
			</p>
			<p>
				<strong>Extensibility.</strong> PSS's biggest advantage as an open source Python project is that you can modify the pipeline directly. Eise.app is also open source, but modifying JS + WGSL shaders has a steeper on-ramp than editing a Python script.
			</p>

			<h3>Acknowledgment</h3>
			<p>
				Eise.app owes a real intellectual debt to Rolf Hempel and PSS. The alignment-point structure, the quality-weighted stacking approach,
				and much of the pipeline design were learned from studying PSS's implementation and Rolf's documentation. If you're interested in the algorithms,
				<a href="https://github.com/Rolf-Hempel/PlanetarySystemStacker" target="_blank" rel="noopener">PSS on GitHub</a> remains the best resource.
			</p>

			<h3>Try Eise.app</h3>
			<NuxtLink to="/" class="cta-link">Try Eise.app in your browser &rarr;</NuxtLink>

			<h3>See also</h3>
			<ul>
				<li><NuxtLink to="/about/autostakkert-vs-eise/">AutoStakkert! vs Eise.app</NuxtLink> - the Windows industry-standard stacker</li>
				<li><NuxtLink to="/about/registax-vs-eise/">Registax 6 vs Eise.app</NuxtLink> - the classic wavelet sharpener compared</li>
				<li><NuxtLink to="/about/planetary-stacking-software-comparison/">Full planetary stacking software comparison</NuxtLink> - all eight tools side by side</li>
			</ul>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'Planetary System Stacker vs Eise.app - Compare Planetary Stacking',
	meta: [
		{ name: 'description', content: 'PSS is an open-source Python stacker with a documented pipeline. Eise.app applies the same alignment-point approach in the browser with WebGPU. Skip the pip install and compare.' },
	],
});

useBreadcrumbSchema([
	{ name: 'Home', url: 'https://eise.app/' },
	{ name: 'About', url: 'https://eise.app/about/' },
	{ name: 'Planetary System Stacker vs Eise.app', url: 'https://eise.app/about/planetary-system-stacker-vs-eise/' },
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
