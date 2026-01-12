# Project Overview: eise.app - Planetary Image Cloud Stacker

eise.app is a fully browser-based planetary image stacking tool designed to simplify astrophotography workflows. It provides a platform-independent solution accessible directly in the browser, with all processing happening client-side using WebAssembly and WebWorkers.

**Core Technologies:**

*   **Frontend (Nuxt.js/Vue.js) - All Processing Client-Side:**
    *   **Nuxt.js:** A progressive Vue.js framework for building universal applications.
    *   **Vue.js:** The core JavaScript framework for building user interfaces.
    *   **WebAssembly & WebWorkers:** Used for all computationally intensive tasks including frame analysis, stacking, and post-processing directly in the browser.
    *   **FFmpeg.js:** Enables in-browser extraction of frames from video files.
    *   **OpenCV-WASM:** Utilized for image processing tasks including Bayer demosaicing, sharpness analysis, local alignment, frame stacking, wavelet sharpening, noise reduction, and color alignment. Note: The current `opencv-bindings` build does *not* include `cv.imencode` or `cv.imdecode` functions. Image encoding to PNG is achieved by drawing to an `OffscreenCanvas` and then using `convertToBlob`.

**Architecture:**

1.  **User Interaction:** An astrophotographer selects a video, SER, AVI, or image files through the frontend.
2.  **Frame Extraction:** FFmpeg.js extracts frames from video files. SER and AVI files are parsed directly in JavaScript.
3.  **Frame Analysis (WebWorkers):** WebWorkers utilizing OpenCV-WASM analyze frames for sharpness using Tenengrad (Sobel-based) metrics. Auto-crop detection centers on the planet using contour detection.
4.  **Bayer Demosaicing:** Raw Bayer frames from SER/AVI are demosaiced to RGB using OpenCV's VNG (Variable Number of Gradients) demosaicing for better quality on fine planetary detail.
5.  **Frame Selection:** Best 30% of frames are selected based on sharpness scores (or user-defined threshold).
6.  **Client-Side Stacking (WebWorker):** The stacking algorithm runs entirely in the browser:
    *   Creates alignment point grid across the image
    *   Detects local shifts at each AP using template matching (`cv.matchTemplate`)
    *   Builds smooth displacement maps using Gaussian-weighted interpolation
    *   De-warps each frame using `cv.remap()` with bilinear interpolation
    *   Accumulates frames with sharpness-based weighting
7.  **Post-processing:** Wavelet sharpening, noise reduction, and chromatic aberration correction using OpenCV-WASM.

The application provides a fully in-browser experience for planetary image stacking with no server required.

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
