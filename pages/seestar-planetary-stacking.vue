<template>
	<div class="page-layout page-layout-wide">
		<div class="content content-card">
			<h2>How to stack MP4's captured by your Seestar</h2>
			<p class="page-subtitle"></p>

			<div class="comparison-images hero-comparison">
				<figure class="comparison-figure">
					<img src="/seestar-moon-stacked-unprocessed.webp" alt="Stacked Seestar Moon MP4 before post-processing" width="998" height="984" />
					<figcaption>Stacked</figcaption>
				</figure>
				<span class="arrow">&rarr;</span>
				<figure class="comparison-figure">
					<img src="/seestar-moon-stacked-saturation.webp" alt="Same Seestar Moon after wavelet sharpening and saturation in Eise.app's post-processor" width="998" height="984" />
					<figcaption>Sharpened + saturated</figcaption>
				</figure>
			</div>

			<p>
				Eise.app is a free browser-based planetary image stacker that also focusses on proper file support. Therefore it also works with MP4 videos you can get from your Seestar. With Eise.app it's possible to stack the sharpest frames in the video, and have nice sharp results.
			</p>

			<h3>What Eise.app does</h3>
			<p>
				Eise decodes the MP4 in the browser, ranks every frame for sharpness, keeps the sharpest 30% by default, and stacks them to create one sharper and less noisy image. This is the same lucky-imaging approach that AutoStakkert and Registax use. After the stack is done, various sharpening and color tools can be used to improve the image even further.
			</p>

			<h3>Example: Seestar Moon MP4, four stages</h3>
			<div class="image-comparison">
				<figure>
					<img src="/seestar-moon-sharpest-frame.webp" alt="Single sharpest frame from a Seestar MP4 lunar video, before stacking" loading="lazy" />
					<figcaption><strong>1. Sharpest single frame.</strong> Best individual frame in the MP4. Noisy. Seestar logo still in frame.</figcaption>
				</figure>
				<figure>
					<img src="/seestar-moon-stacked-unprocessed.webp" alt="Same Seestar Moon MP4 after Eise.app lucky-imaging stack, no post-processing yet" loading="lazy" />
					<figcaption><strong>2. Stacked.</strong> Top 30% of frames aligned and combined. Less noise.</figcaption>
				</figure>
				<figure>
					<img src="/seestar-moon-stacked-processed.webp" alt="Stacked Seestar Moon image after wavelet sharpening" loading="lazy" />
					<figcaption><strong>3. Sharpened &amp; stretched.</strong> Autostretching levels for a brighter moon, together with wavelet sharpening.</figcaption>
				</figure>
				<figure>
					<img src="/seestar-moon-stacked-saturation.webp" alt="Stacked and sharpened Seestar Moon with saturation boosted, revealing mineral moon colours" loading="lazy" />
					<figcaption><strong>4. Saturation boosted.</strong> Not yet a proper "mineral moon", but getting there.</figcaption>
				</figure>
			</div>

			<h3>Workflow</h3>
			<ol>
				<li><strong>Before your capture, disable the Seestar watermark</strong>. 
					<br/> Inside the Seestar app, go to: Me → Device Management → toggle Image Watermark off. This makes stacking more efficient and yields better results.</li>
				<li><strong>Start a MP4 capture.</strong> Saturn is almost in opposition!</li>
				<li><strong>Copy the MP4 off your phone.</strong> Seestar app &rarr; My Album &rarr; Solar System Album. Send your file to your laptop.</li>
				<li><strong>Open <NuxtLink to="/">eise.app</NuxtLink></strong> on a laptop or desktop (Safari, Chrome, Firefox, Edge). Mobile works a bit, but running Eise on a desktop computer is more stable and faster.</li>
				<li><strong>Drop the MP4 in Eise.</strong> Make sure the target setting in Eise is set to <strong>Planet</strong>. Seestar's focal length means the Moon and Sun fit completely in the frame, so Planet mode is the right choice for all Solar System targets, not Surface.</li>
				<li><strong>Wait.</strong> Under a minute for a 2 to 3 minute clip on any recent laptop.</li>
				<li><strong>Sharpen and export.</strong> Post-processor opens automatically. Export PNG.</li>
			</ol>

			<h3>S50 vs S30 Pro for planets</h3>
			<p>
				The S50 (250 mm focal length) is the more capable planetary shooter: Jupiter shows cloud bands, Saturn shows the ring. The S30 Pro is a deep-sky rig with a shorter focal length; planets fit in the frame but stay small. Both record MP4 in Solar System mode.
			</p>

			<h3>FAQ</h3>

			<h4>Can I stack MP4 without re-recording as RAW AVI?</h4>
			<p>Yes. That's the whole point. Drop the MP4 in directly, no conversion.</p>

			<h4>Does it work with the Seestar S30 Pro?</h4>
			<p>Yes, same MP4 format. Expect less planet detail than an S50 clip because of the shorter focal length.</p>

			<h4>How do I turn off the Seestar logo watermark?</h4>
			<p>Inside the Seestar app: <strong>Me</strong> &rarr; <strong>Device Management</strong> &rarr; toggle <strong>Image Watermark</strong> off. Future captures and MP4 saves won't include the corner logo or bottom banner.</p>
			<img src="/seestar-logo-disable.jpg" alt="Seestar app screenshot showing the corner logo watermark on a planet capture" class="troubleshooting-image" />
			<p>Files already saved with the logo baked in need to be cropped manually. See <NuxtLink to="/about/help/">the help page</NuxtLink> for more troubleshooting.</p>

			<h4>What about the FITS export?</h4>
			<p>Seestar's per-exposure FITS  output is for a deep-sky workflow, use Siril for those.</p>

			<h3>See also</h3>
			<ul>
				<li><NuxtLink to="/planetary-stacking-mac/">Stacking on Mac</NuxtLink></li>
				<li><NuxtLink to="/about/planetary-stacking-software-comparison/">Full stacking software comparison</NuxtLink></li>
				<li><NuxtLink to="/about/autostakkert-vs-eise/">AutoStakkert! vs Eise.app</NuxtLink></li>
				<li><NuxtLink to="/about/help/">How Eise.app processes your video</NuxtLink></li>
			</ul>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'Improve Seestar Moon and Planet Videos - Works with MP4, No Install | Eise.app',
	meta: [
		{ name: 'description', content: 'Free browser-based stacker that works with Seestar S50 and S30 Pro Moon and planet MP4 videos. The built-in Video Stack only works on RAW AVI; Eise.app handles MP4 natively with lucky imaging.' },
	],
});

useBreadcrumbSchema([
	{ name: 'Home', url: 'https://eise.app/' },
	{ name: 'Seestar Moon and Planet Stacking', url: 'https://eise.app/seestar-planetary-stacking/' },
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
.hero-comparison {
	justify-content: center;
	gap: 24px;
	margin: 8px 0 32px;
}
.hero-comparison :deep(img) {
	max-width: 260px;
	width: 100%;
}
.hero-comparison :deep(.arrow) {
	font-size: 32px;
	color: #555;
}
.troubleshooting-image {
	max-width: 100%;
	max-height: 200px;
	display: block;
	margin: 0.5rem 0;
	border-radius: 4px;
	border: 1px solid #e5e5e5;
}
.image-comparison {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 1.25rem;
	margin: 1.5rem 0;
}
.image-comparison figure {
	margin: 0;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}
.image-comparison img {
	width: 100%;
	height: auto;
	border-radius: 4px;
	background: #000;
}
.image-comparison figcaption {
	font-size: 13px;
	color: #444;
	line-height: 1.4;
}
@media (max-width: 700px) {
	.image-comparison {
		grid-template-columns: 1fr;
	}
}
</style>
