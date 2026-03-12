# Project Overview: eise.app - Planetary Image Cloud Stacker

eise.app is a fully browser-based planetary image stacking tool designed to simplify astrophotography workflows. It provides a platform-independent solution accessible directly in the browser, with all processing happening client-side using WebAssembly and WebWorkers.

**Core Technologies:**

*   **Frontend (Nuxt.js/Vue.js) - All Processing Client-Side:**
    *   **Nuxt.js:** A progressive Vue.js framework for building universal applications.
    *   **Vue.js:** The core JavaScript framework for building user interfaces.
    *   **WebAssembly & WebWorkers:** Used for all computationally intensive tasks including frame analysis, stacking, and post-processing directly in the browser.
    *   **FFmpeg.js:** Enables in-browser extraction of frames from video files.
    *   **OpenCV-WASM:** Utilized for image processing tasks including Bayer demosaicing, sharpness analysis, local alignment, frame stacking, wavelet sharpening, noise reduction, and color alignment. Note: The current `opencv-bindings` build does *not* include `cv.imencode` or `cv.imdecode` functions. Image encoding to PNG is achieved by drawing to an `OffscreenCanvas` and then using `convertToBlob`.

**Architecture (Updated March 2026):**

1.  **User Interaction:** An astrophotographer selects a video, SER, AVI, or image files through the frontend.
2.  **Format Detection:** FileUploader routes to appropriate reader based on file type.
3.  **Frame Extraction:**
    - SER/AVI: Parsed directly by `useSerParser`/`useAviParser`
    - Video: FFmpeg.js extracts frames via `useFFmpegReader`
4.  **Frame Analysis (WebGPU):** GPU compute shaders analyze frames for sharpness using Tenengrad metrics. Auto-crop detection centers on the planet.
5.  **Bayer Demosaicing:** Raw Bayer frames are demosaiced to RGB on GPU using VNG (Variable Number of Gradients) for quality or bilinear for speed.
6.  **Frame Selection:** Best 30% of frames are selected based on sharpness scores (or user-defined threshold).
7.  **Client-Side Stacking (WebGPU):** The stacking algorithm runs entirely in the browser:
    *   Creates alignment point grid across the image
    *   GPU template matching detects local shifts at each AP
    *   Builds smooth displacement maps using Gaussian-weighted interpolation
    *   GPU shader de-warps each frame
    *   Accumulates frames with sharpness-based weighting
8.  **Post-processing:** Wavelet sharpening, noise reduction, and chromatic aberration correction.

The application provides a fully in-browser experience for planetary image stacking with no server required. WebGPU is the primary path; OpenCV-WASM is available as CPU fallback.

## Building and Running

### Frontend Setup and Run

1.  **Install Dependencies:**
    ```bash
    npm install
    ```
2.  **Run in Development Mode:**
    ```bash
    npm run dev
    ```
    This will start the Nuxt.js development server, usually on `http://localhost:3000`.

3.  **Build for Production:**
    ```bash
    npm run build
    ```
4.  **Generate Static Files:**
    ```bash
    npm run generate
    ```
    This command also copies `config/cloudflare_headers.txt` to `dist/_headers` for Cloudflare deployment.

5.  **Preview Production Build:**
    ```bash
    npm run preview
    ```

## Development Conventions

*   **Nuxt.js/Vue.js Standard Structure:** The frontend adheres to a standard Nuxt.js project structure, organizing code into `components`, `composables`, `plugins`, `public`, `utils`, and `app.vue`.
*   **TypeScript Usage:** TypeScript is used for Nuxt.js configuration (`nuxt.config.ts`) and indicated by `tsconfig.json` files.
*   **WebAssembly Integration:** Extensive use of WebAssembly for all image processing directly within the browser.
*   **Event Bus Pattern:** Cross-component communication via `composables/eventBus.js` for progress updates and state management.
*   **WebWorker Pool:** Multiple workers are spawned based on `navigator.hardwareConcurrency` (max 4) to parallelize frame analysis while managing memory.
