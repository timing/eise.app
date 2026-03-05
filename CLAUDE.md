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
├── FileUploader: Video/SER/AVI input
├── Frame Readers: useSerReader.js, useAviReader.js, useImageReader.js
├── unified_analyze_worker.js: WebWorker pool for:
│   ├── Frame extraction (FFmpeg.js for video)
│   ├── Sharpness analysis (Tenengrad/Sobel-based)
│   ├── Bayer demosaicing (OpenCV-WASM)
│   ├── Auto-crop detection (contour-based planet centering)
│   └── Frame stacking with local alignment (alignment points + de-warping)
├── useStacker.js: Orchestrates client-side stacking
└── PostProcessor: Wavelet sharpening, noise reduction, chromatic aberration correction
```

### Stacking Pipeline (all in browser)
1. **Frame Analysis**: Raw SER/AVI frames → sharpness scoring → keep best 30%
2. **Demosaicing**: Raw Bayer data → RGB using OpenCV `cv.demosaicing()` (VNG - Variable Number of Gradients)
3. **Stacking**: Alignment points grid → local shift detection via template matching → weighted de-warping → accumulation
4. **Post-processing**: Wavelet sharpening, color correction

## Key Technical Details

**IMPORTANT: WebGPU Path is Primary**: When making changes to stacking/alignment code, always prioritize the WebGPU path first. It's the most commonly used path and provides the best performance. The CPU path (OpenCV in worker) is a fallback. Key WebGPU files:
- `public/webgpu_template_match.js` - GPU template matching for alignment
- `public/webgpu_stacking.js` - GPU frame accumulation
- `composables/useStacker.js` - `stackWithWebGPU()` and `stackWithGpuPipelined()` orchestrate the GPU path

**WebWorker Frame Analysis**: Workers use Tenengrad (Sobel-based) sharpness calculation. Pool size based on `navigator.hardwareConcurrency` (max 4 to prevent memory issues). Workers handle both FFmpeg-extracted PNG frames and raw SER/AVI frames.

**Client-Side Stacking** has two paths:
1. **WebGPU Path** (primary): `useStacker.js` → `webgpu_template_match.js` for alignment → `webgpu_stacking.js` for accumulation
2. **CPU Path** (fallback): `unified_analyze_worker.js` → `stackFramesLocally()` using OpenCV `cv.matchTemplate`

Both paths use `createAPGrid()` to generate alignment point coordinates (lightweight - just creates ~100-300 {x,y} pairs). Parameters:
- 20px patches, 8px search radius (planetary) or 34px search radius (surface/Moon/Sun)
- AP quality filtering by minimum structure (0.02) and brightness (5)
- Gaussian-weighted displacement map interpolation
- De-warping via `cv.remap()` (CPU) or GPU shader (WebGPU)
- Sharpness-weighted frame accumulation

**Bayer Demosaicing**: Raw Bayer frames are demosaiced using OpenCV's `cv.demosaicing()` with VNG (Variable Number of Gradients) interpolation for better quality on fine detail. The demosaicing happens BEFORE stacking (frames are stacked as RGB, not raw Bayer).

**Per-Frame Planet Centering (CRITICAL)**: Each frame MUST be cropped with per-frame center detection so the planet is always centered in the cropped output. The planet moves across frames due to atmospheric refraction and mount drift. Skipping per-frame detection and using a fixed reference center will cause the planet to drift across frames, ruining the stack. The `detectObjectBounds()` function in unified_analyze_worker.js finds the bright object's centroid for each frame. NEVER skip this step or use a fixed center for all frames.

**OpenCV-WASM Limitation**: The `opencv-bindings` build does NOT include `cv.imencode`/`cv.imdecode`. PNG encoding uses `OffscreenCanvas.convertToBlob()` instead.

**File Format Support**:
- Video: mp4, mov, webm (via FFmpeg)
- SER: Astronomical sequence format with Bayer pattern detection (RGGB, BGGR, GBRG, GRBG, Mono)
- AVI: Direct parsing with FourCC detection
- Images: PNG, JPG, WebP, AVIF (direct), others (FFmpeg converted)

**QualitySelector Preview Differences (TODO: unify later)**:
- **SER path**: Stores `uint8Buffer` with each frame during analysis for instant preview in QualitySelector
- **AVI raw Bayer path**: Uses on-demand loading via `frameReReader.getPreviewBlob()` - reads frame from disk and demosaics when user selects it in QualitySelector
- The on-demand approach is more memory-efficient but slightly slower. Consider unifying both paths to use the same approach.

**Event Bus Pattern**: Cross-component communication via `composables/eventBus.js`. Key events: `set-caption`, `update-loading`, `stop-loading`, `upload-error`, `postProcessing`, `stacking-started`, `stacked-image-ready`.

**Shared Processing State**: `composables/useProcessingState.js` stores shared state accessible from any composable without passing through function parameters. Used for:
- `minApQuality` - AP quality threshold for alignment (NCC score, default 0.3)
- `apPatchSize` - Alignment point patch size in pixels (default 20)
- `inputFilename` - Current input filename for output naming

UI settings in FileUploader.vue sync to this shared state via watchers, and useStacker.js reads from it via getter functions (`getMinApQuality()`, `getApPatchSize()`).

**SharedArrayBuffer Requirements**: `nuxt.config.ts` sets CORP/COOP headers for WebWorker memory sharing. Cloudflare headers in `config/cloudflare_headers.txt`.

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
