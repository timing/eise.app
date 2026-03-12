# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

eise.app is a fully browser-based planetary image stacking tool for astrophotography. All processing happens client-side using WebAssembly and WebWorkers - no server required for stacking.

## Development Commands

```bash
# Frontend (Nuxt.js)
npm install          # Install dependencies
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build
npm run generate     # Generate static files (for Cloudflare deployment)
```

**IMPORTANT: Do NOT run `npm run build` to verify changes.** The dev server (`npm run dev`) is always running in another terminal and will show compilation errors immediately via hot-reload. Running build is slow and unnecessary.

## Architecture

```
Browser (Nuxt.js + Vue.js) - All processing is client-side
├── FileUploader.vue: File input, format detection, processing orchestration
│
├── Format Parsers (header parsing only):
│   ├── useSerParser.js      - SER header parsing, frame reading
│   └── useAviParser.js      - AVI/RIFF parsing, frame index
│
├── Frame Readers (processing pipelines):
│   ├── useDebayerReader.js  - Raw Bayer (SER, raw AVI) → GPU demosaic → analyze → stack
│   ├── useFFmpegReader.js   - Video (MP4, MOV, etc.) → FFmpeg decode → GPU analyze
│   ├── useAviReader.js      - AVI MJPEG/BGR (already RGB) → GPU analyze
│   └── useImageReader.js    - Image sequences → GPU analyze
│
├── GPU Workers (WebGPU compute):
│   ├── webgpu_analyze_worker.js  - Demosaic, sharpness, crop detection
│   ├── webgpu_template_match.js  - Alignment point template matching
│   └── webgpu_stacking.js        - Frame warping and accumulation
│
├── Shared Composables:
│   ├── useWebGpuAnalyzeWorker.js - Shared GPU worker wrapper for RGBA frames
│   ├── useStacker.js             - Orchestrates stacking (GPU primary, CPU fallback)
│   └── useProcessingState.js     - Shared state (AP settings, filenames)
│
├── CPU Fallback:
│   └── unified_analyze_worker.js - OpenCV-WASM for non-WebGPU browsers
│
└── PostProcessor.vue: Wavelet sharpening, deconvolution, RGB alignment
```

### Stacking Pipeline (all in browser)
1. **Format Detection**: FileUploader routes to appropriate reader based on file type
2. **Crop Detection**: Sample frames → detect planet bounds → determine crop size
3. **Frame Analysis**: Per-frame GPU analysis → sharpness scoring → crop with per-frame centering
4. **Frame Selection**: Keep best N% by sharpness (default 30%)
5. **Demosaicing**: Raw Bayer → RGB via GPU VNG demosaic (or bilinear for speed)
6. **Stacking**: Alignment points grid → GPU template matching → de-warping → weighted accumulation
7. **Post-processing**: Wavelet sharpening, color correction

## Design System & CSS

- **Design System Reference**: See `/design-system` page for inventory of UI components and styles.
- **Reuse existing styles**: Check `app.vue` for global styles before adding new CSS.
- **Avoid duplication**: Check the design system before creating new button styles, message styles, or form controls.

## Key Technical Details

**IMPORTANT: WebGPU Path is Primary**: When making changes to analysis/stacking code, always prioritize the WebGPU path. Key files:
- `public/webgpu_analyze_worker.js` - GPU demosaic, sharpness, crop detection
- `public/webgpu_template_match.js` - GPU template matching for alignment
- `public/webgpu_stacking.js` - GPU frame warping and accumulation
- `public/gpu/shaders.js` - All WGSL compute shaders
- `public/gpu/helpers.js` - Buffer/pipeline creation helpers
- `composables/useStacker.js` - `stackWithGpuPipelined()` orchestrates the GPU path

**File Processing Paths**:
- **Raw Bayer (SER, raw AVI)**: `useSerParser`/`useAviParser` → `useDebayerReader` → GPU demosaic + analyze
- **Video (MP4, MOV, etc.)**: `useFFmpegReader` → FFmpeg decode → `useWebGpuAnalyzeWorker` → GPU analyze
- **AVI MJPEG/BGR**: `useAviReader` → decode → GPU analyze (already RGB, no demosaic)
- **Images**: `useImageReader` → GPU analyze

**Client-Side Stacking** has two paths:
1. **WebGPU Path** (primary): `useStacker.js` → `webgpu_template_match.js` for alignment → `webgpu_stacking.js` for accumulation
2. **CPU Path** (fallback): `unified_analyze_worker.js` → `stackFramesLocally()` using OpenCV `cv.matchTemplate`

Both paths use `createAPGrid()` to generate alignment point coordinates (lightweight - just creates ~100-300 {x,y} pairs). Parameters:
- 20px patches, 8px search radius (planetary) or 34px search radius (surface/Moon/Sun)
- AP quality filtering by minimum structure (0.02) and brightness (5)
- Gaussian-weighted displacement map interpolation
- De-warping via `cv.remap()` (CPU) or GPU shader (WebGPU)
- Sharpness-weighted frame accumulation

**Bayer Demosaicing**: Raw Bayer frames are demosaiced on GPU using VNG (Variable Number of Gradients) interpolation for quality, or bilinear for speed. The demosaicing happens BEFORE stacking (frames are stacked as RGB, not raw Bayer). GPU demosaic is in `webgpu_analyze_worker.js`.

**Per-Frame Planet Centering (CRITICAL)**: Each frame MUST be cropped with per-frame center detection so the planet is always centered in the cropped output. The planet moves across frames due to atmospheric refraction and mount drift. Skipping per-frame detection and using a fixed reference center will cause the planet to drift across frames, ruining the stack. GPU path uses `detectCropAnalyzeBatch()` in `webgpu_analyze_worker.js`. NEVER skip this step or use a fixed center for all frames.

**OpenCV-WASM Limitation**: The `opencv-bindings` build does NOT include `cv.imencode`/`cv.imdecode`. PNG encoding uses `OffscreenCanvas.convertToBlob()` instead.

**File Format Support**:
- Video: mp4, mov, webm (via FFmpeg)
- SER: Astronomical sequence format with Bayer pattern detection (RGGB, BGGR, GBRG, GRBG, Mono)
- AVI: Direct parsing with FourCC detection
- Images: PNG, JPG, WebP, AVIF (direct), others (FFmpeg converted)

**QualitySelector Preview**:
- Frames analyzed via GPU store `uint8Buffer` for instant preview
- On-demand loading available via `frameReReader.getPreviewBlob()` for memory efficiency
- `useDebayerReader` uses on-demand approach for raw Bayer files

**Event Bus Pattern**: Cross-component communication via `composables/eventBus.js`. Key events: `set-caption`, `update-loading`, `stop-loading`, `upload-error`, `postProcessing`, `stacking-started`, `stacked-image-ready`.

**Shared Processing State**: `composables/useProcessingState.js` stores shared state accessible from any composable without passing through function parameters. Used for:
- `minApQuality` - AP quality threshold for alignment (NCC score, default 0.3)
- `apPatchSize` - Alignment point patch size in pixels (default 20)
- `inputFilename` - Current input filename for output naming

UI settings in FileUploader.vue sync to this shared state via watchers, and useStacker.js reads from it via getter functions (`getMinApQuality()`, `getApPatchSize()`).

**SharedArrayBuffer Requirements**: `nuxt.config.ts` sets CORP/COOP headers for WebWorker memory sharing. Cloudflare headers in `config/cloudflare_headers.txt`.

## WebGPU Helper Functions (MUST USE)

When writing WebGPU code, **always use the helpers in `public/gpu/helpers.js`**. Do NOT write verbose boilerplate manually.

**Buffer Creation** - use these instead of `device.createBuffer({...})`:
```javascript
import { storageBuffer, uniformBuffer, readbackBuffer } from './gpu/helpers.js';

// Storage buffers (GPU compute data)
storageBuffer(device, size)                              // STORAGE only
storageBuffer(device, size, { copySrc: true })           // STORAGE | COPY_SRC
storageBuffer(device, size, { copyDst: true })           // STORAGE | COPY_DST
storageBuffer(device, size, { copySrc: true, copyDst: true })  // all three

// Uniform buffers (shader parameters)
uniformBuffer(device, size)  // UNIFORM | COPY_DST

// Readback buffers (GPU → CPU)
readbackBuffer(device, size)  // MAP_READ | COPY_DST
```

**Pipeline Creation** - use instead of manual shader module + pipeline creation:
```javascript
import { createPipeline } from './gpu/helpers.js';

// Instead of createShaderModule + createComputePipeline:
const pipeline = await createPipeline(device, shaderCode, 'pipelineName');
```

**Bind Groups & Compute Passes**:
```javascript
import { createBindGroup, addComputePass, imageWorkgroups } from './gpu/helpers.js';

// Bind group from sequential buffers
const bindGroup = createBindGroup(device, pipeline, [buf0, buf1, buf2]);

// Add compute pass to encoder
addComputePass(encoder, pipeline, bindGroup, imageWorkgroups(width, height, batchSize));
```

**Shaders** - all WGSL shaders are in `public/gpu/shaders.js`. Import from there, don't inline.

## Technical Reference

**OpenCV Bayer Naming Convention (INVERTED from industry standard)**:
OpenCV uses the 2x2 sub-matrix starting at row 2, column 2 of the CFA, while the rest of the industry (camera manufacturers, MATLAB, etc.) uses the top-left 2x2 sub-matrix. See [OpenCV issue #19629](https://github.com/opencv/opencv/issues/19629).

This results in inverted naming:
| Industry Standard | OpenCV Name | OpenCV Code |
|-------------------|-------------|-------------|
| RGGB | BayerBG | `COLOR_BayerBG2RGB` |
| BGGR | BayerRG | `COLOR_BayerRG2RGB` |
| GRBG | BayerGB | `COLOR_BayerGB2RGB` |
| GBRG | BayerGR | `COLOR_BayerGR2RGB` |

**SER to OpenCV Bayer Mapping**:
- SER RGGB (colorID 8) → `COLOR_BayerBG2RGB`
- SER GRBG (colorID 9) → `COLOR_BayerGB2RGB`
- SER GBRG (colorID 10) → `COLOR_BayerGR2RGB`
- SER BGGR (colorID 11) → `COLOR_BayerRG2RGB`

## Sentry Error Tracking

**Access Sentry issues via API:**
```bash
# Config is in config/sentry-env.sh
source config/sentry-env.sh

# Fetch unresolved issues
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/issues/?query=is:unresolved"

# Get issue details
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/issues/{issue_id}/"

# Mark issue as resolved
curl -s -X PUT -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved"}' \
  "https://sentry.io/api/0/issues/{issue_id}/"
```

**Note:** When Claude is asked to "fix Sentry issues", use curl with the auth token from `config/sentry-env.sh` to fetch and manage issues.
