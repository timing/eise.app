# eise.app - Browser-Based Planetary Image Stacker

https://eise.app is the first fully browser-based planetary image stacking tool. Everything runs locally on your machine using WebAssembly and Web Workers - your data never leaves your computer.

The name is an ode to [Eise Eisinga](https://en.wikipedia.org/wiki/Eise_Eisinga), a Frisian amateur astronomer who built a planetarium in his living room. The project started from frustrations getting existing software running on ARM-based Macs - AutoStakkert4! didn't work in Wine, PSS had dependency issues, Lynkeos crashed continuously.

## How it works

1. **Load your capture** - Select a SER file (recommended), AVI, or any video format
2. **Frame ranking** - Sharpness analysis scores each frame using Laplacian variance
3. **Quality selection** - Choose which percentage of frames to stack with an interactive quality graph
4. **Auto-crop** - Detects and centers the target in each frame, rejects cut-off frames
5. **Local alignment** - Alignment Points (APs) track motion across the frame using template matching
6. **De-warping** - Displacement maps correct atmospheric wobble using inverse distance weighted interpolation
7. **Stacking** - Quality-weighted averaging with optional 1.5x drizzle
8. **Post-processing** - Wavelet sharpening, deconvolution, RGB alignment, rotation, crop

All processing happens client-side using WebGPU (GPU-accelerated) or falls back to CPU via OpenCV WebAssembly.

## Features

- **100% browser-based** - No uploads, no installs, works on any OS
- **File support** - SER (recommended), AVI (uncompressed), or any video via FFmpeg.js
- **Surface mode** - For Moon/Sun closeups with drift tracking
- **Drizzle** - 1.5x output resolution using sub-pixel frame offsets
- **WebGPU acceleration** - Fast GPU-based template matching and stacking

## Acknowledgments

This project draws inspiration from [Planetary System Stacker](https://github.com/Rolf-Hempel/PlanetarySystemStacker) by Rolf Hempel. The alignment point approach, local de-warping, and quality-weighted stacking concepts are based on PSS's implementation.

## Running locally

```bash
git clone https://github.com/tijmen/eise.app
cd eise.app
npm install
npm run dev
```

## Browser requirements

eise.app uses WebGPU for fast GPU-accelerated processing:
- Chrome 113+ (Android: 121+)
- Edge 113+
- Safari 18+ (macOS Sequoia / iOS 18)
- Firefox 141+ (Windows only for now)

Falls back to CPU processing on older browsers.

---

Happy Stacking,
Tijmen


