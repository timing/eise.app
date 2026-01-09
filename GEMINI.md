# Project Overview: eise.app - Planetary Image Cloud Stacker

eise.app is a web-based online planetary image stacking tool designed to simplify astrophotography workflows. It tackles common issues with desktop stacking software by providing a platform-independent solution accessible directly in the browser. The application leverages a hybrid architecture, distributing computational load between the client-side (web browser) and a dedicated backend server.

**Core Technologies:**

*   **Frontend (Nuxt.js/Vue.js):**
    *   **Nuxt.js:** A progressive Vue.js framework for building universal applications.
    *   **Vue.js:** The core JavaScript framework for building user interfaces.
    *   **WebAssembly & WebWorkers:** Used for computationally intensive tasks like frame ranking and post-processing directly in the browser, improving performance and scalability.
    *   **FFmpeg.js:** Enables in-browser extraction of frames from video files.
    *   **OpenCV:** Utilized for image processing tasks such as sharpening, noise reduction, and color alignment, compiled to WebAssembly. Note: The current `opencv-bindings` build used in the WebWorker does *not* include `cv.imencode` or `cv.imdecode` functions. Image encoding to PNG is achieved by drawing to an `OffscreenCanvas` and then using `convertToBlob`.
    *   **Socket.io-client:** For real-time communication with the backend server.

*   **Backend (Node.js/Express.js & Flask/Python):**
    *   **Node.js/Express.js:** Handles file uploads from the frontend and manages the job queue for image stacking. Also provides endpoints for serving stacked images. This is the primary backend server.
    *   **Flask/Python:** A separate Flask application (`stack-server/server.py`) which orchestrates the execution of the `PlanetarySystemStacker` Python script (`../../PlanetarySystemStacker/src/stack_frames.py`). The Node.js server spawns this Python script directly as a child process.
    *   **Socket.io:** Facilitates real-time communication between the Node.js backend server and the frontend, sending console output during stacking and the final stacked image.
    *   **Multer:** Node.js middleware for handling multipart/form-data, primarily used for file uploads to the Node.js server.
    *   **child_process (Node.js):** Used by the Node.js server to spawn the Python stacking script.
    *   **fs-extra (Node.js):** Provides additional file system methods for the Node.js server.

**Architecture:**

1.  **User Interaction:** An astrophotographer selects a video file through the frontend.
2.  **Frontend Pre-processing:** FFmpeg.js extracts frames from the video. WebAssembly and WebWorkers, utilizing OpenCV, rank up to 5,000 frames based on sharpness.
3.  **Backend Stacking:** The best 30% of frames are uploaded to the Node.js/Express.js backend server.
4.  **Job Queuing:** The Node.js backend queues these stacking requests. Due to computational intensity, it manages a job queue and limits the number of concurrent Python processing jobs.
5.  **Python Stacking Execution:** The Node.js server spawns the `stack_frames.py` script directly. Console output from this Python process is captured by the Node.js server and streamed back to the frontend via Socket.IO.
6.  **Result & Post-processing:** Once stacking is complete, the stacked image is sent from the Node.js server to the frontend. A basic post-processor (again using OpenCV compiled to WebAssembly) offers wavelet sharpening, noise reduction, and color alignment.

The application aims to provide a seamless, in-browser experience for planetary image stacking, offloading heavy processing to both WebAssembly in the browser and a dedicated Python backend.

## Building and Running

This project consists of two main parts: a Nuxt.js frontend and a Node.js/Express backend that orchestrates a Python stacking script.

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
4.  **Generate Static Files (if applicable):**
    ```bash
    npm run generate
    ```
    This command also copies `config/cloudflare_headers.txt` to `dist/_headers` for Cloudflare deployment.

5.  **Preview Production Build:**
    ```bash
    npm run preview
    ```

### Backend Setup and Run

The primary backend server is the Node.js `server.js`. It handles file uploads and then spawns the Python `stack_frames.py` script for image processing. The separate `stack-server/server.py` file is a Flask application that appears to be an alternative or standalone way to run the Python stacking, but it's the `server.js` that integrates with the frontend's workflow by directly calling the Python script.

1.  **Navigate to the backend directory:**
    ```bash
    cd stack-server
    ```
2.  **Install Node.js Dependencies:**
    ```bash
    npm install
    ```
3.  **Install Python Dependencies and Setup Environment:**
    The `server.js` refers to a `pythonEnv` located at `../../stack-server/server-env/bin`. You need to create a Python virtual environment in `stack-server/server-env` and install the necessary Python dependencies, including `Flask`, `Flask-SocketIO`, and any dependencies required by `PlanetarySystemStacker`.

    ```bash
    python3 -m venv server-env
    source server-env/bin/activate
    # Install Python dependencies for Flask, Flask-SocketIO, and Planetary System Stacker
    # Example: pip install Flask Flask-SocketIO numpy scipy Pillow astropy
    # You might need to consult the PlanetarySystemStacker documentation for its specific dependencies.
    ```
4.  **Run Node.js Server:**
    ```bash
    node server.js
    ```
    The Node.js server will listen on `http://127.0.0.1:8080`. This server will then execute the Python stacking script as needed.

## Development Conventions

*   **Nuxt.js/Vue.js Standard Structure:** The frontend adheres to a standard Nuxt.js project structure, organizing code into `components`, `composables`, `plugins`, `public`, `utils`, and `app.vue`.
*   **TypeScript Usage:** TypeScript is used for Nuxt.js configuration (`nuxt.config.ts`) and indicated by `tsconfig.json` files, suggesting a typed codebase.
*   **WebAssembly Integration:** A key convention is the extensive use of WebAssembly for performance-critical image processing directly within the browser, minimizing server load for pre-processing.
*   **Real-time Communication:** Socket.IO is a fundamental component for both frontend and Node.js backend to facilitate real-time updates, console output streaming, and final image transfer.
*   **Layered Backend Architecture:** The backend is designed with a Node.js API layer responsible for coordinating file uploads and job management, which then interfaces with a Python layer for the heavy computational task of image stacking.
*   **File Uploads and Job Management:** The backend includes robust handling for file uploads and a job queuing mechanism to manage concurrent image processing tasks efficiently.
*   **Python Environment Management:** The Python part of the backend is expected to run within a dedicated virtual environment, promoting dependency isolation.
