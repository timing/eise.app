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

**WebWorker Frame Analysis**: Workers use Tenengrad (Sobel-based) sharpness calculation. Pool size based on `navigator.hardwareConcurrency` (max 4 to prevent memory issues). Workers handle both FFmpeg-extracted PNG frames and raw SER/AVI frames.

**Client-Side Stacking**: The `stackFramesLocally()` function in `unified_analyze_worker.js` implements:
- Alignment point grid creation
- Template matching for local shift detection (`cv.matchTemplate`)
- Gaussian-weighted displacement map interpolation
- De-warping via `cv.remap()` with bilinear interpolation
- Sharpness-weighted frame accumulation

**Bayer Demosaicing**: Raw Bayer frames are demosaiced using OpenCV's `cv.demosaicing()` with VNG (Variable Number of Gradients) interpolation for better quality on fine detail. The demosaicing happens BEFORE stacking (frames are stacked as RGB, not raw Bayer).

**OpenCV-WASM Limitation**: The `opencv-bindings` build does NOT include `cv.imencode`/`cv.imdecode`. PNG encoding uses `OffscreenCanvas.convertToBlob()` instead.

**File Format Support**:
- Video: mp4, mov, webm (via FFmpeg)
- SER: Astronomical sequence format with Bayer pattern detection (RGGB, BGGR, GBRG, GRBG, Mono)
- AVI: Direct parsing with FourCC detection
- Images: PNG, JPG, WebP, AVIF (direct), others (FFmpeg converted)

**Event Bus Pattern**: Cross-component communication via `composables/eventBus.js`. Key events: `set-caption`, `update-loading`, `stop-loading`, `upload-error`, `postProcessing`, `stacking-started`, `stacked-image-ready`.

**SharedArrayBuffer Requirements**: `nuxt.config.ts` sets CORP/COOP headers for WebWorker memory sharing. Cloudflare headers in `config/cloudflare_headers.txt`.

## File Limits

- Max file size: 2GB (larger files can be trimmed)
- Max frames: 5000 configurable
