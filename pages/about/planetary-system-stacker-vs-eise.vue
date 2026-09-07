<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>Planetary System Stacker (PSS) vs Eise.app</h2>
			<p class="page-subtitle">Which should you use?</p>
			<p>
				Both turn planetary videos into sharper single images. PSS by Rolf Hempel is a Python desktop app with a mature, well-documented codebase.
				Eise.app runs in the browser, no install. Same core idea, different setup.
			</p>

			<div class="verdict">
				<p><strong>Short version:</strong> PSS if you're comfortable installing Python and want a hackable desktop app. Eise.app if you want to open a URL, drop a file, and be done.</p>
			</div>

			<h3>Quick comparison</h3>
			<div class="table-wrapper">
				<table class="comparison-table">
					<thead>
						<tr>
							<th>&nbsp;</th>
							<th>Planetary System Stacker</th>
							<th>Eise.app</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="feature-name">Install</td>
							<td>Python + dependencies</td>
							<td class="highlight">None, runs in browser</td>
						</tr>
						<tr>
							<td class="feature-name">Platforms</td>
							<td>Win, Mac, Linux (via Python)</td>
							<td class="highlight">Anything with a modern browser, mobile included</td>
						</tr>
						<tr>
							<td class="feature-name">Source</td>
							<td class="highlight">Open source on GitHub</td>
							<td class="highlight">Open source on GitHub</td>
						</tr>
						<tr>
							<td class="feature-name">Price</td>
							<td>Free</td>
							<td>Free</td>
						</tr>
						<tr>
							<td class="feature-name">GPU acceleration</td>
							<td>No (CPU only)</td>
							<td class="highlight">Yes (WebGPU when available)</td>
						</tr>
						<tr>
							<td class="feature-name">Post-processing</td>
							<td>Minimal, most users pair it with Registax</td>
							<td class="highlight">Built in (sharpening, colour, RGB alignment)</td>
						</tr>
						<tr>
							<td class="feature-name">Learning curve</td>
							<td>Steeper (Python setup + exposed knobs)</td>
							<td class="highlight">Guided flow, sensible defaults</td>
						</tr>
					</tbody>
				</table>
			</div>

			<h3>When PSS is the better choice</h3>
			<ul>
				<li>You want to read or modify the source.</li>
				<li>You're already comfortable with Python.</li>
				<li>You want to script or batch-run from a terminal.</li>
			</ul>

			<h3>When Eise.app is the better choice</h3>
			<ul>
				<li>You don't want to install anything.</li>
				<li>You're on a Mac, phone, or tablet.</li>
				<li>You want to try it in 30 seconds before committing to any workflow.</li>
			</ul>

			<h3>Acknowledgment</h3>
			<p>
				Eise.app owes real credit to Rolf Hempel and PSS. Studying PSS's implementation and Rolf's documentation shaped much of Eise.app's design.
				If you want to understand the algorithms,
				<a href="https://github.com/Rolf-Hempel/PlanetarySystemStacker" target="_blank" rel="noopener">PSS on GitHub</a> is still the best resource.
			</p>
			<p>
				<strong>PSS fork with compatibility fixes.</strong> Upstream PSS (last release 0.8.22) hadn't been updated for newer Python and UI-toolkit versions,
				which made installing it increasingly awkward. Eise.app's author maintains a fork at
				<a href="https://github.com/timing/PlanetarySystemStacker" target="_blank" rel="noopener">github.com/timing/PlanetarySystemStacker</a>
				with the following changes since 0.8.22:
			</p>
			<ul>
				<li>Updated UI toolkit so PSS runs on modern Python (3.9-3.12)</li>
				<li>Modernized project layout (<code>pyproject.toml</code> instead of <code>setup.py</code>)</li>
				<li>Accepts <code>.m4v</code> video files for stacking</li>
				<li><code>--config_file</code> CLI flag for headless and scripted runs</li>
				<li>Downloadable macOS <code>.app</code> bundle, so you can run PSS on a Mac without installing Python</li>
			</ul>

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
		{ name: 'description', content: 'PSS is a Python desktop stacker. Eise.app runs in the browser, no install. Compare them side by side and pick what fits your workflow.' },
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
