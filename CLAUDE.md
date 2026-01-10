# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

eise.app is a web-based planetary image stacking tool for astrophotography. It uses a hybrid architecture: browser-based frame extraction and ranking (WebAssembly/WebWorkers), with server-side image stacking via Python (Planetary System Stacker).

## Development Commands

```bash
# Frontend (Nuxt.js)
npm install          # Install dependencies
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build
npm run generate     # Generate static files (for Cloudflare deployment)

# Backend (stack-server/)
cd stack-server
npm install          # Install Node.js deps
node server.js       # Run server on port 8080
# Requires Python venv at stack-server/server-env with PSS dependencies
```

## Architecture

```
Browser (Nuxt.js + Vue.js)
├── FileUploader: Video/SER/AVI input via FFmpeg.js
├── VideoFrameProcessor: WebWorker pool for frame sharpness analysis (OpenCV-WASM)
├── PostProcessor: Wavelet sharpening, noise reduction, chromatic aberration correction
└── unified_analyze_worker.js: Frame analysis in worker threads

      ↓ Best 30% of frames uploaded via Socket.io

Node.js Backend (stack-server/server.js)
├── Express + Multer for file uploads
├── Job queue (max 2 concurrent jobs)
└── Spawns Python subprocess

      ↓

Python (PlanetarySystemStacker)
└── stack_frames.py: Heavy stacking computation
```

## Key Technical Details

**WebWorker Frame Analysis**: Workers use Laplacian-based sharpness calculation. Pool size based on `navigator.hardwareConcurrency`. Workers handle both FFmpeg-extracted PNG frames and raw SER/AVI frames.

**OpenCV-WASM Limitation**: The `opencv-bindings` build does NOT include `cv.imencode`/`cv.imdecode`. PNG encoding uses `OffscreenCanvas.convertToBlob()` instead.

**File Format Support**:
- Video: mp4, mov, webm (via FFmpeg)
- SER: Astronomical sequence format with Bayer pattern detection (RGGB, BGGR, GBRG, GRBG, Mono)
- AVI: Direct parsing with FourCC detection
- Images: PNG, JPG, WebP, AVIF (direct), others (FFmpeg converted)

**Event Bus Pattern**: Cross-component communication via `composables/eventBus.js`. Key events: `set-caption`, `update-loading`, `stop-loading`, `upload-error`, `postProcessing`, `ser-frames-updated`.

**SharedArrayBuffer Requirements**: `nuxt.config.ts` sets CORP/COOP headers for WebWorker memory sharing. Cloudflare headers in `config/cloudflare_headers.txt`.

## File Limits

- Max file size: 2GB (larger files can be trimmed)
- Max frames: 5000 configurable
- Concurrent server jobs: 2
