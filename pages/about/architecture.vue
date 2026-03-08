<template>
	<div class="page-layout page-layout-wide">
		<div class="content architecture-page">
			<h2>Technical Architecture</h2>
			<p class="intro">This page documents the internal processing pipelines and algorithms used by eise.app. Useful for contributors or anyone curious about how it works.</p>

			<h3>High-Level Overview</h3>
			<pre class="diagram">
┌─────────────────────────────────────────────────────────────────────────┐
│                            FILE INPUT                                    │
│         SER  /  AVI (raw Bayer)  /  AVI (MJPEG)  /  Video  /  Images    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         FORMAT DETECTION                                 │
│                        (FileUploader.vue)                                │
│                                                                          │
│   Routes to appropriate reader based on file type and codec             │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
   │  Raw Bayer Path │    │   Video Path    │    │  RGB/MJPEG Path │
   │                 │    │                 │    │                 │
   │ useSerParser    │    │ useFFmpegReader │    │  useAviReader   │
   │ useAviParser    │    │                 │    │  useImageReader │
   │       ↓         │    │    FFmpeg.js    │    │                 │
   │ useDebayerReader│    │       ↓         │    │  Already RGB    │
   │       ↓         │    │   PNG frames    │    │  (no demosaic)  │
   │  GPU Demosaic   │    │       ↓         │    │                 │
   └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         GPU ANALYSIS                                     │
│                   (webgpu_analyze_worker.js)                             │
│                                                                          │
│   1. Crop Detection    - Sample frames, find planet bounds              │
│   2. Per-frame Analyze - Sharpness scoring, per-frame centering         │
│   3. Frame Selection   - Keep best N% by sharpness                      │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         GPU STACKING                                     │
│              (webgpu_template_match.js + webgpu_stacking.js)             │
│                                                                          │
│   1. Template Matching - Find local shifts at alignment points          │
│   2. De-warping        - Interpolate displacement map, warp frame       │
│   3. Accumulation      - Weighted sum with brightness normalization     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       POST-PROCESSING                                    │
│                      (PostProcessor.vue)                                 │
│                                                                          │
│   Wavelet sharpening, RGB alignment, color correction, crop             │
└─────────────────────────────────────────────────────────────────────────┘
</pre>

			<h3>File Format Support</h3>
			<table>
				<tr>
					<th>Format</th>
					<th>Reader</th>
					<th>Notes</th>
				</tr>
				<tr>
					<td>SER</td>
					<td>useSerParser → useDebayerReader</td>
					<td>Recommended. Raw Bayer with GPU demosaic (VNG or bilinear)</td>
				</tr>
				<tr>
					<td>AVI (Y800, DIB 8-bit)</td>
					<td>useAviParser → useDebayerReader</td>
					<td>Raw Bayer AVI from capture software</td>
				</tr>
				<tr>
					<td>AVI (MJPEG)</td>
					<td>useAviReader</td>
					<td>Already RGB, GPU analysis only</td>
				</tr>
				<tr>
					<td>AVI (BGR 24-bit)</td>
					<td>useAviReader</td>
					<td>Already RGB, GPU analysis only</td>
				</tr>
				<tr>
					<td>MP4, MOV, WebM</td>
					<td>useFFmpegReader</td>
					<td>FFmpeg decode → PNG → GPU analysis</td>
				</tr>
				<tr>
					<td>PNG, JPG, TIFF</td>
					<td>useImageReader</td>
					<td>Image sequences</td>
				</tr>
			</table>

			<h3>Analysis Phase</h3>
			<p>The analysis phase processes frames to determine which ones to keep for stacking.</p>

			<pre class="diagram">
For each batch of frames:

┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Read from   │     │   Demosaic   │     │  Detect      │     │  Compute     │
│    disk      │ ──▶ │  (if Bayer)  │ ──▶ │   bounds     │ ──▶ │  sharpness   │
│              │     │              │     │              │     │  (Tenengrad) │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                            │
                     ┌──────┴──────┐
                     │             │
               ┌─────▼─────┐ ┌─────▼─────┐
               │  grayOnly │ │    VNG    │
               │  (fast)   │ │  (quality)│
               │  4 fetch  │ │  33 fetch │
               └───────────┘ └───────────┘
                     │
                     ▼
            Analysis uses grayOnly
            Stacking uses VNG
</pre>

			<h4>Demosaicing Methods</h4>
			<table>
				<tr>
					<th>Method</th>
					<th>Texture Fetches</th>
					<th>Used For</th>
				</tr>
				<tr>
					<td>grayOnly</td>
					<td>4 per pixel</td>
					<td>Analysis phase (sharpness scoring)</td>
				</tr>
				<tr>
					<td>Bilinear</td>
					<td>~8 per pixel</td>
					<td>Fast preview, low quality stacking</td>
				</tr>
				<tr>
					<td>VNG</td>
					<td>~33 per pixel</td>
					<td>Stacking phase (full quality)</td>
				</tr>
			</table>

			<h4>Sharpness Calculation</h4>
			<p>The GPU computes two complementary sharpness metrics and combines them:</p>
			<pre class="code">
Tenengrad (Sobel gradient magnitude):
┌─────────────────┐     ┌─────────────────┐
│ Gx = [-1  0  1] │     │ Gy = [-1 -2 -1] │
│      [-2  0  2] │     │      [ 0  0  0] │
│      [-1  0  1] │     │      [ 1  2  1] │
└─────────────────┘     └─────────────────┘
Tenengrad = mean(Gx² + Gy²)

Laplacian (second derivative):
┌─────────────────┐
│      [ 0  1  0] │
│      [ 1 -4  1] │
│      [ 0  1  0] │
└─────────────────┘
Laplacian = mean(lap²)

Combined sharpness = √(Tenengrad × Laplacian)
</pre>
			<p>The geometric mean combines edge detection (Tenengrad) with fine detail detection (Laplacian). Higher values indicate sharper frames.</p>
			<p class="note"><strong>Note:</strong> The CPU fallback path uses Tenengrad only (no Laplacian) for simplicity.</p>

			<h4>Per-Frame Centering</h4>
			<p>Critical for planetary stacking: the planet drifts across frames due to atmospheric refraction and mount drift. Each frame must be cropped with its own detected center.</p>
			<pre class="diagram">
Frame 1:        Frame 50:       Frame 100:
┌─────────┐     ┌─────────┐     ┌─────────┐
│         │     │         │     │         │
│   ●     │     │    ●    │     │     ●   │    Planet drifts!
│         │     │         │     │         │
└─────────┘     └─────────┘     └─────────┘

After per-frame centering:
┌─────────┐     ┌─────────┐     ┌─────────┐
│         │     │         │     │         │
│    ●    │     │    ●    │     │    ●    │    Centered!
│         │     │         │     │         │
└─────────┘     └─────────┘     └─────────┘
</pre>

			<h3>Stacking Phase</h3>
			<p>Selected frames are aligned and accumulated using local alignment points.</p>

			<h4>Alignment Point Grid</h4>
			<pre class="diagram">
┌───────────────────────────────────┐
│  ·     ·     ·     ·     ·     ·  │
│                                   │
│  ·     ·     ·     ·     ·     ·  │    · = Alignment Point (AP)
│           ████████████            │
│  ·     ·  ██ Planet ██  ·     ·   │    Each AP tracks local motion
│           ██        ██            │    using template matching
│  ·     ·  ████████████  ·     ·   │
│                                   │    Patch size: 20-50 pixels
│  ·     ·     ·     ·     ·     ·  │    Search radius: 8-34 pixels
│                                   │
│  ·     ·     ·     ·     ·     ·  │
└───────────────────────────────────┘
</pre>

			<h4>Template Matching (NCC)</h4>
			<p>Normalized Cross-Correlation finds the best match position for each AP:</p>
			<pre class="code">
           Σ[(ref - μref)(frame - μframe)]
NCC = ─────────────────────────────────────────
       sqrt(Σ(ref - μref)²) × sqrt(Σ(frame - μframe)²)

NCC ranges from -1 to +1 (1 = perfect match)
</pre>
			<p>Sub-pixel precision achieved via parabolic interpolation of the 3x3 peak neighborhood.</p>

			<h4>De-warping</h4>
			<p>Displacement vectors from APs are interpolated across the frame:</p>
			<pre class="diagram">
Measured displacements:          Interpolated displacement map:

   ←·     ·→    ·                ←←←↖↖↑↑↗↗→→
                                 ←←←↖↖↑↑↗↗→→
   ←·     ·     ·→               ←←←↖↖↑↑↗↗→→
                                 ←←↖↖↖↑↗↗↗→→
   ·      ·→    ·                ←↖↖↖↖↑↗↗↗↗→
                                 ↖↖↖↖↖↑↗↗↗↗↗

Gaussian-weighted interpolation:
w(d) = exp(-d² / (2σ²))    where d = distance to AP
</pre>

			<h4>Accumulation</h4>
			<pre class="code">
For each frame f with sharpness S:
    weight = S / max_sharpness
    brightness_scale = reference_brightness / frame_brightness

    accumulator += warped_frame × brightness_scale × weight
    weight_sum += weight

Final = accumulator / weight_sum
</pre>

			<h3>Key Files</h3>
			<table>
				<tr>
					<th>File</th>
					<th>Purpose</th>
				</tr>
				<tr>
					<td><code>composables/useDebayerReader.js</code></td>
					<td>Unified raw Bayer processing (SER, raw AVI)</td>
				</tr>
				<tr>
					<td><code>composables/useFFmpegReader.js</code></td>
					<td>Video decode via FFmpeg.js</td>
				</tr>
				<tr>
					<td><code>composables/useStacker.js</code></td>
					<td>Stacking orchestration, GPU/CPU path selection</td>
				</tr>
				<tr>
					<td><code>public/webgpu_analyze_worker.js</code></td>
					<td>GPU demosaic, sharpness, bounds detection</td>
				</tr>
				<tr>
					<td><code>public/webgpu_template_match.js</code></td>
					<td>GPU template matching for alignment</td>
				</tr>
				<tr>
					<td><code>public/webgpu_stacking.js</code></td>
					<td>GPU frame warping and accumulation</td>
				</tr>
				<tr>
					<td><code>public/gpu/shaders.js</code></td>
					<td>All WGSL compute shaders</td>
				</tr>
			</table>

			<h3>Processing Modes</h3>
			<p>The mode affects template matching search radius and cut-off frame rejection:</p>
			<table>
				<tr>
					<th>Mode</th>
					<th>AP Search Radius</th>
					<th>Cut-off Rejection</th>
					<th>Use Case</th>
				</tr>
				<tr>
					<td>Planet</td>
					<td>8 pixels</td>
					<td>Yes</td>
					<td>Jupiter, Saturn, Mars - small motion, reject frames where planet touches edge</td>
				</tr>
				<tr>
					<td>Surface</td>
					<td>34 pixels</td>
					<td>No</td>
					<td>Moon, Sun closeups - larger drift between frames, no defined edge</td>
				</tr>
			</table>
			<p class="note">AP Search Radius = how far (in pixels) to search around each alignment point when looking for the best template match. Larger radius handles more frame-to-frame motion but is slower.</p>

			<h3>GPU vs CPU Paths</h3>
			<pre class="diagram">
┌─────────────────────────────────────────────────────────────────────────┐
│                        WebGPU Available?                                 │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
           ┌───────────────┐               ┌───────────────┐
           │   GPU Path    │               │   CPU Path    │
           │   (primary)   │               │  (fallback)   │
           │               │               │               │
           │ webgpu_*      │               │ unified_      │
           │ workers       │               │ analyze_      │
           │               │               │ worker.js     │
           │ Fast!         │               │ OpenCV-WASM   │
           └───────────────┘               └───────────────┘
</pre>

			<h3>Bayer Pattern Reference</h3>
			<p>OpenCV uses inverted naming from industry standard:</p>
			<table>
				<tr>
					<th>Industry (SER)</th>
					<th>OpenCV</th>
					<th>Layout</th>
				</tr>
				<tr>
					<td>RGGB</td>
					<td>BayerBG</td>
					<td><code>R G<br>G B</code></td>
				</tr>
				<tr>
					<td>BGGR</td>
					<td>BayerRG</td>
					<td><code>B G<br>G R</code></td>
				</tr>
				<tr>
					<td>GRBG</td>
					<td>BayerGB</td>
					<td><code>G R<br>B G</code></td>
				</tr>
				<tr>
					<td>GBRG</td>
					<td>BayerGR</td>
					<td><code>G B<br>R G</code></td>
				</tr>
			</table>

			<h3>Want to Contribute?</h3>
			<p>Check out the <a href="https://github.com/timing/eise.app" target="_blank">GitHub repository</a>. Key documentation files:</p>
			<ul>
				<li><code>CLAUDE.md</code> - Architecture overview for AI assistants</li>
				<li><code>PROCESSING_PIPELINE.md</code> - Detailed pipeline documentation</li>
				<li><code>PIPELINE_OPTIMIZATION_ANALYSIS.md</code> - Performance optimization opportunities</li>
			</ul>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'Technical Architecture - eise.app Processing Pipeline',
	meta: [
		{ name: 'description', content: 'Technical documentation of eise.app\'s processing pipeline, algorithms, and architecture. For contributors and curious users.' },
	],
});
</script>

<style scoped>
.intro {
	font-size: 1.1em;
	color: #aaa;
	margin-bottom: 1.5rem;
}

.architecture-page h3 {
	margin-top: 2rem;
	border-bottom: 1px solid #444;
	padding-bottom: 0.5rem;
}

.architecture-page h4 {
	margin-top: 1.5rem;
	color: #ccc;
}

.diagram {
	background: #1a1a2e;
	border: 1px solid #333;
	border-radius: 8px;
	padding: 1rem;
	overflow-x: auto;
	font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
	font-size: 0.85rem;
	line-height: 1.4;
	color: #8be9fd;
	white-space: pre;
}

.code {
	background: #1a1a2e;
	border: 1px solid #333;
	border-radius: 8px;
	padding: 1rem;
	overflow-x: auto;
	font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
	font-size: 0.85rem;
	line-height: 1.5;
	color: #f8f8f2;
	white-space: pre;
}

table {
	width: 100%;
	border-collapse: collapse;
	margin: 1rem 0;
}

th, td {
	border: 1px solid #444;
	padding: 0.5rem 0.75rem;
	text-align: left;
}

th {
	background: #2a2a3e;
	font-weight: 600;
}

td {
	background: #1a1a2e;
}

td code {
	background: #2a2a3e;
	padding: 0.1rem 0.3rem;
	border-radius: 3px;
	font-size: 0.9em;
}

tr:hover td {
	background: #252538;
}

.note {
	background: #2a2a3e;
	border-left: 3px solid #8be9fd;
	padding: 0.5rem 1rem;
	margin: 1rem 0;
	font-size: 0.9em;
	color: #aaa;
}
</style>
