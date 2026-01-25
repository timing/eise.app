
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';

// Helper to detect and provide user-friendly messages for memory errors
function isMemoryError(error) {
    const msg = error?.message?.toLowerCase() || '';
    return msg.includes('oom') ||
           msg.includes('out of memory') ||
           msg.includes('allocation failed') ||
           msg.includes('memory limit') ||
           msg.includes('batch too large');
}

function getMemoryErrorMessage(error, context = {}) {
    const { width, height, frameCount } = context;
    let suggestion = 'Try reducing the number of frames or using a smaller video resolution.';

    if (width && height) {
        const pixelCount = width * height;
        if (pixelCount > 8000000) { // > 8MP
            suggestion = `Your frames are very large (${width}x${height}). Try cropping or scaling down your source video before importing.`;
        } else if (frameCount && frameCount > 2000) {
            suggestion = `You have ${frameCount} frames. Try importing fewer frames (under 2000) or trim your video first.`;
        }
    }

    return `Memory limit reached: Your browser ran out of memory while processing. ${suggestion}`;
}

// Map OpenCV Bayer pattern names to GPU shader pattern indices
// OpenCV uses inverted naming: BG = industry RGGB, RG = industry BGGR
// GPU shader indices: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
function bayerChoiceToGpuPattern(bayerChoice) {
    const mapping = {
        'COLOR_BayerBG2RGB': 0,  // RGGB (OpenCV BG = industry RGGB)
        'COLOR_BayerBG2BGR': 0,
        'COLOR_BayerRG2RGB': 1,  // BGGR (OpenCV RG = industry BGGR)
        'COLOR_BayerRG2BGR': 1,
        'COLOR_BayerGB2RGB': 2,  // GRBG (OpenCV GB = industry GRBG)
        'COLOR_BayerGB2BGR': 2,
        'COLOR_BayerGR2RGB': 3,  // GBRG (OpenCV GR = industry GBRG)
        'COLOR_BayerGR2BGR': 3,
        'MONO': -1  // No demosaic needed
    };
    return mapping[bayerChoice] ?? -1;
}

// These functions remain on the main thread as they are not performance bottlenecks
// Exported for use by Tools component
export function parseSerHeader(buffer) {
    const view = new DataView(buffer);
    const le = true; // SER files are little-endian

    // Standard SER V3 header layout:
    // 0-13: FileID "LUCAM-RECORDER" (14 bytes)
    // 14-17: LuID (4 bytes) - camera ID
    // 18-21: ColorID (4 bytes) - color format (0=MONO, 8=RGGB, 9=GRBG, 10=GBRG, 11=BGGR)
    // 22-25: LittleEndian (4 bytes) - byte order indicator
    // 26-29: ImageWidth (4 bytes)
    // 30-33: ImageHeight (4 bytes)
    // 34-37: PixelDepthPerPlane (4 bytes) - bits per pixel (8, 10, 12, 14, 16)
    // 38-41: FrameCount (4 bytes)
    // 42-81: Observer (40 bytes)
    // 82-121: Instrument (40 bytes)
    // 122-161: Telescope (40 bytes)
    // 162-169: DateTime (8 bytes)
    // 170-177: DateTimeUTC (8 bytes)

    let h = {
        fileId: Array.from(new Uint8Array(buffer.slice(0, 14))).map(b => String.fromCharCode(b)).join(''),
        luId: view.getInt32(14, le),
        colorID: view.getInt32(18, le),
        littleEndian: view.getInt32(22, le),
        width: view.getInt32(26, le),
        height: view.getInt32(30, le),
        pixelDepth: view.getInt32(34, le),  // PixelDepthPerPlane - bits per pixel
        frameCount: view.getInt32(38, le),
        observer: Array.from(new Uint8Array(buffer.slice(42, 82))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        instrument: Array.from(new Uint8Array(buffer.slice(82, 122))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        telescope: Array.from(new Uint8Array(buffer.slice(122, 162))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        dateTime: view.getBigInt64(162, le),
        dateTimeUTC: view.getBigInt64(170, le)
    };

    // Sanity check: if values don't make sense, the file might have a non-standard layout
    if (h.width <= 0 || h.width > 10000 || h.height <= 0 || h.height > 10000) {
        console.warn('SER header values look invalid, file may be corrupted or non-standard');
    }

    // Ensure pixelDepth is sensible (common values: 8, 10, 12, 14, 16)
    if (h.pixelDepth <= 0 || h.pixelDepth > 16) {
        console.warn(`Unusual pixelDepth ${h.pixelDepth}, defaulting to 8`);
        h.pixelDepth = 8;
    }

    return h;
}

// This function will still be used on the main thread for preview rendering.
// It relies on cv being globally available, which it is via plugin.
async function renderFrameToBlob(canvas, buffer, header, bayerChoice) {
    const { width, height, pixelDepth } = header;
    const type = pixelDepth > 8 ? cv.CV_16UC1 : cv.CV_8UC1;
    const data = pixelDepth > 8 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    let mat = cv.matFromArray(height, width, type, data);

    // Convert to 8-bit for display
    let temp8u = new cv.Mat();
    mat.convertTo(temp8u, cv.CV_8U, pixelDepth > 8 ? 1/256 : 1);

    // Apply Color Demosaic for the preview
    let displayMat = new cv.Mat();
    
    if (bayerChoice !== "MONO" && cv[bayerChoice] !== undefined) {
        cv.demosaicing(temp8u, displayMat, cv[bayerChoice]);
    } else {
        temp8u.copyTo(displayMat);
    }

    // Auto-Stretch and Show
    let stretched = new cv.Mat();
    cv.normalize(displayMat, stretched, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
    
    canvas.width = width;
    canvas.height = height;
    cv.imshow(canvas, stretched);
    
    // Cleanup
    [mat, temp8u, displayMat, stretched].forEach(m => m.delete());

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

export function useSerReader() {
    const { addLog, emit } = useEventBus();
    const { uploadFrames } = useUploader();
    const { stackFramesLocally } = useStacker();
    const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();

    // Create a pool of workers
    // Limit workers to prevent OpenCV WASM memory exhaustion on large frames
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;

    // Initializes workers and ensures OpenCV is ready before processing
    async function initializeWorkers() {
        if (workersReady) return;
        addLog("Initializing analysis workers...");

        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
        }

        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
                // 30 second timeout - OpenCV WASM can take a while to initialize
                const timeout = setTimeout(() => reject(new Error(`Worker ${i} initialization timed out.`)), 30000);
                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        resolve();
                    } else if (e.data.type === 'error') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        reject(new Error(e.data.message || 'Worker initialization error'));
                    }
                };
                worker.onerror = (e) => {
                    clearTimeout(timeout);
                    reject(e);
                };
                worker.postMessage({ type: 'init' });
            });
        });

        try {
            await Promise.all(workerPromises);
            setupWorkerHandlers(); // Set up single message handler per worker
            workersReady = true;
            addLog("Analysis workers ready.");
        } catch (error) {
            console.error("Worker initialization failed:", error);
            reportError(error, { component: 'useSerReader', action: 'initializeWorkers' });
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    // Map of pending frame resolvers per worker: workerIndex -> { frameIndex -> {resolve, reject, timeout} }
    const pendingFrames = new Map();
    const recyclingWorkers = new Set(); // Track which workers are currently being recycled

    // Recycle a single worker on error (non-blocking for other workers)
    async function recycleSingleWorker(workerIndex) {
        if (recyclingWorkers.has(workerIndex)) return; // Already recycling
        recyclingWorkers.add(workerIndex);

        // Wait for pending frames on this worker only
        const workerPending = pendingFrames.get(workerIndex);
        if (workerPending && workerPending.size > 0) {
            const pending = [];
            for (const [frameIndex, p] of workerPending) {
                pending.push(new Promise(resolve => {
                    const originalResolve = p.resolve;
                    const originalReject = p.reject;
                    p.resolve = (result) => { originalResolve(result); resolve(); };
                    p.reject = (error) => { originalReject(error); resolve(); };
                }));
            }
            await Promise.all(pending);
        }

        // Terminate this worker
        const oldWorker = unifiedAnalyzeWorkers[workerIndex];
        if (oldWorker) oldWorker.terminate();

        // Create fresh worker
        const newWorker = new Worker(workerUrl('/unified_analyze_worker.js'));
        unifiedAnalyzeWorkers[workerIndex] = newWorker;

        // Wait for it to initialize
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Worker ${workerIndex} recycling timed out.`)), 30000);
            newWorker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    newWorker.onmessage = null;
                    resolve();
                }
            };
            newWorker.onerror = (e) => {
                clearTimeout(timeout);
                reject(e);
            };
            newWorker.postMessage({ type: 'init' });
        });

        // Set up handler for this worker
        setupSingleWorkerHandler(workerIndex);
        recyclingWorkers.delete(workerIndex);
    }

    // Set up handler for a single worker
    function setupSingleWorkerHandler(workerIndex) {
        const worker = unifiedAnalyzeWorkers[workerIndex];
        pendingFrames.set(workerIndex, new Map());

        worker.addEventListener('message', (e) => {
            const frameIndex = e.data.index;
            const pending = pendingFrames.get(workerIndex)?.get(frameIndex);
            if (!pending) return;

            clearTimeout(pending.timeout);
            pendingFrames.get(workerIndex).delete(frameIndex);

            if (e.data.error) {
                pending.reject(e.data.error);
            } else if (e.data.type === 'bounds') {
                pending.resolve({ type: 'bounds', bounds: e.data.bounds, index: e.data.index });
            } else if (e.data.skipped) {
                pending.resolve({ skipped: true, reason: e.data.reason, index: e.data.index });
            } else {
                pending.resolve(e.data);
            }
        });

        worker.addEventListener('error', (e) => {
            console.error(`Worker ${workerIndex} error:`, e);
            const workerPending = pendingFrames.get(workerIndex);
            if (workerPending) {
                for (const [frameIndex, pending] of workerPending) {
                    clearTimeout(pending.timeout);
                    pending.reject(e);
                }
                workerPending.clear();
            }
        });
    }

    // Detect WASM heap corruption from error messages and force immediate recycle
    function isHeapCorruptionError(error) {
        const msg = error?.message || String(error);
        // OpenCV heap corruption shows as garbage error codes (large numbers)
        const match = msg.match(/OpenCV error code:\s*(\d+)/);
        if (match) {
            const code = parseInt(match[1], 10);
            // Valid OpenCV error codes are small (< 100), garbage values are huge
            return code > 10000;
        }
        return false;
    }

    // Force immediate worker recycle due to heap corruption
    function forceWorkerRecycle(workerIndex) {
        if (recyclingWorkers.has(workerIndex)) return; // Already recycling

        console.warn(`Forcing immediate recycle of worker ${workerIndex} due to heap corruption`);
        recycleSingleWorker(workerIndex).catch(err => {
            console.error(`Failed to force recycle worker ${workerIndex}:`, err);
        });
    }

    // Set up single message handler per worker (call after workers are created)
    function setupWorkerHandlers() {
        unifiedAnalyzeWorkers.forEach((worker, workerIndex) => {
            setupSingleWorkerHandler(workerIndex);
        });
    }

    // Function to process a frame with a worker
    function processFrameWithWorker(workerIndex, data, transferables) {
        const worker = unifiedAnalyzeWorkers[workerIndex];
        const frameIndex = data.index;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingFrames.get(workerIndex)?.delete(frameIndex);
                reject(new Error(`Worker timeout for frame ${frameIndex}`));
            }, 30000);

            pendingFrames.get(workerIndex).set(frameIndex, { resolve, reject, timeout });
            worker.postMessage(data, transferables);
        });
    }

    // Detect bounds for a sample of frames to determine crop region
    async function detectCropRegion(file, header, frameSize, frameCount, bayerChoice, cropMarginPercent = 10) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50)); // ~50 samples max
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        let maxSize = 0;
        let canCropCount = 0;
        const boundsPromises = [];
        const detectedCenters = []; // Collect center positions for stable reference
        const detectedSizes = []; // Collect sizes to calculate median for outlier detection

        const headerForWorker = {
            fileId: header.fileId,
            width: header.width,
            height: header.height,
            pixelDepth: header.pixelDepth,
            colorID: header.colorID
        };

        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];
            const offset = 178 + (i * frameSize);
            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();

            const workerIndex = idx % numWorkers;

            const dataToWorker = {
                type: 'detect-bounds',
                frameBuffer: frameBuffer,
                header: headerForWorker,
                bayerChoice: bayerChoice,
                index: idx
            };

            const promise = processFrameWithWorker(workerIndex, dataToWorker, [frameBuffer])
                .then(result => {
                    if (result.bounds && result.bounds.canCrop) {
                        canCropCount++;
                        // Track the maximum crop region needed
                        maxSize = Math.max(maxSize, result.bounds.size);
                        // Use actual detected center (not derived from clamped crop coords)
                        detectedCenters.push({ x: result.bounds.centerX, y: result.bounds.centerY });
                        // Collect sizes for median calculation (outlier detection)
                        detectedSizes.push(result.bounds.size);
                    }
                    emit('update-loading', { progress: ((idx + 1) / sampleIndices.length) * 100, current: idx + 1, total: sampleIndices.length });
                })
                .catch(error => {
                    if (isHeapCorruptionError(error)) {
                        forceWorkerRecycle(workerIndex);
                    }
                    console.error(`Error detecting bounds for sample ${idx}:`, error);
                });

            boundsPromises.push(promise);
        }

        await Promise.all(boundsPromises);

        // Only need 50% of frames to be croppable (was 80%, but too strict for videos where planet moves near edges)
        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Calculate median size (more robust than max which can be skewed by moons/noise)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        // Use median size with margin, capped at frame dimensions
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(header.width, header.height);
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds frame size ${maxAllowedSize}, clamping`);
        }

        // Calculate median center as fallback reference
        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);
            return { size: finalSize, medianObjectSize: medianSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, max detected: ${maxSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // GPU-accelerated crop region detection - uses GPU for bounds detection
    async function detectCropRegionGpu(file, header, frameSize, frameCount, bayerChoice, cropMarginPercent = 10, data16bitScaleFactor = 1) {
        addLog(`Using crop margin: ${cropMarginPercent}%`);
        emit('set-caption', 'Detecting planet position (GPU)...');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        // Initialize GPU worker
        const gpuReady = await initGpuAnalyzeWorker();
        if (!gpuReady) {
            addLog('GPU not available, falling back to CPU detection');
            await initializeWorkers(); // Lazy init CPU workers only when needed
            return detectCropRegion(file, header, frameSize, frameCount, bayerChoice, cropMarginPercent);
        }

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50)); // ~50 samples max
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`GPU sampling ${sampleIndices.length} frames for crop detection...`);

        // Map bayer choice to pattern index for GPU
        // bayerChoice comes from ColorProfileSelector as OpenCV constants
        // GPU shader: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
        const bayerPatternMap = {
            // Short names (for backwards compat)
            'RGGB': 0, 'BGGR': 1, 'GRBG': 2, 'GBRG': 3, 'MONO': -1,
            // OpenCV constants (inverted naming: BG=RGGB, RG=BGGR, GB=GRBG, GR=GBRG)
            'COLOR_BayerBG2RGB': 0,  // Industry RGGB
            'COLOR_BayerRG2RGB': 1,  // Industry BGGR
            'COLOR_BayerGB2RGB': 2,  // Industry GRBG
            'COLOR_BayerGR2RGB': 3,  // Industry GBRG
        };
        const bayerPattern = bayerPatternMap[bayerChoice] ?? -1;

        // Load all sample frames in batches for GPU processing
        // Dynamic batch size based on frame dimensions to avoid memory issues
        const frameBytes = header.width * header.height * 16; // Float32 RGBA
        const targetMemory = 256 * 1024 * 1024; // 256MB
        const batchSize = Math.max(1, Math.min(16, Math.floor(targetMemory / frameBytes)));
        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleIndices.length; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, sampleIndices.length);
            const batchIndices = sampleIndices.slice(batchStart, batchEnd);

            // Load frame data for this batch
            const frames = [];
            for (const i of batchIndices) {
                const offset = 178 + (i * frameSize);
                const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();

                // Convert to appropriate typed array based on pixel depth
                // NOTE: Don't apply scale factor here - bounds detection should work on raw data range
                // to avoid scaled background exceeding threshold
                let data;
                if (header.pixelDepth > 8) {
                    data = new Uint16Array(frameBuffer);
                } else {
                    data = new Uint8Array(frameBuffer);
                }
                frames.push({ data, index: i });
            }

            try {
                // GPU analyze for bounds detection
                // Use lower threshold (0.02) for raw unscaled 16-bit data which may have narrow dynamic range
                const boundsThreshold = header.pixelDepth > 8 ? 0.02 : 0.05;
                const results = await analyzeFrameBatchGpu(frames, header.width, header.height, bayerPattern, boundsThreshold);

                for (const result of results) {
                    if (result.bounds) {
                        canCropCount++;
                        // Calculate size from bounds (raw bounding box)
                        const size = Math.max(result.bounds.width, result.bounds.height);
                        maxSize = Math.max(maxSize, size);
                        detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
                        detectedSizes.push(size);
                    }
                }
            } catch (err) {
                if (isMemoryError(err)) {
                    const msg = getMemoryErrorMessage(err, { width: header.width, height: header.height });
                    addLog(`Memory error during crop detection: ${msg}`);
                    // For memory errors, skip crop detection entirely
                    return null;
                }
                console.error('GPU crop detection batch error:', err);
                // Continue with other batches for non-memory errors
            }

            emit('update-loading', { progress: (batchEnd / sampleIndices.length) * 100, current: batchEnd, total: sampleIndices.length });
        }

        // Only need 50% of frames to be croppable
        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Calculate median size (more robust than max which can be skewed by moons/noise)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        // Use median size with margin, capped at frame dimensions
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(header.width, header.height);
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds frame size ${maxAllowedSize}, clamping`);
        }

        // Calculate median center as fallback reference
        if (detectedCenters.length === 0) {
            addLog(`GPU detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);
            return { size: finalSize, medianObjectSize: medianSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`GPU detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, max detected: ${maxSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // GPU batch analysis helper
    let gpuAnalyzeWorker = null;
    let gpuWorkerReady = false;

    async function initGpuAnalyzeWorker() {
        if (gpuAnalyzeWorker && gpuWorkerReady) return true;

        gpuAnalyzeWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'));

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                addLog('WebGPU analyze worker timeout');
                gpuAnalyzeWorker.terminate();
                gpuAnalyzeWorker = null;
                resolve(false);
            }, 10000);

            gpuAnalyzeWorker.onmessage = (e) => {
                if (!e.data) {
                    console.warn('GPU worker sent null message');
                    return;
                }
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    gpuWorkerReady = true;
                    addLog('WebGPU analyze worker ready');
                    resolve(true);
                } else if (e.data.type === 'init-error') {
                    clearTimeout(timeout);
                    addLog(`WebGPU analyze worker error: ${e.data.error}`);
                    gpuAnalyzeWorker.terminate();
                    gpuAnalyzeWorker = null;
                    resolve(false);
                }
            };
            gpuAnalyzeWorker.onerror = (err) => {
                clearTimeout(timeout);
                console.error('GPU analyze worker error:', err);
                reportError(err, { component: 'useSerReader', action: 'initGpuAnalyzeWorker' });
                addLog(`WebGPU analyze worker crashed: ${err.message}`);
                gpuAnalyzeWorker.terminate();
                gpuAnalyzeWorker = null;
                resolve(false);
            };
            gpuAnalyzeWorker.postMessage({ type: 'init' });
        });
    }

    function terminateGpuAnalyzeWorker() {
        if (gpuAnalyzeWorker) {
            // Cleanup cached GPU buffers before terminating
            gpuAnalyzeWorker.postMessage({ type: 'cleanup' });
            gpuAnalyzeWorker.terminate();
            gpuAnalyzeWorker = null;
            gpuWorkerReady = false;
        }
    }

    /**
     * Analyze frames in batches using WebGPU
     * @param frames - Array of { data, index } where data is raw frame buffer
     * @param width - Frame width
     * @param height - Frame height
     * @param bayerPattern - GPU pattern index (0-3) or -1 for MONO/RGB
     * @param threshold - Threshold for circularity (0-1, typically 0.1)
     */
    async function analyzeFrameBatchGpu(frames, width, height, bayerPattern, threshold = 0.1, metadataOnly = false) {
        if (!gpuAnalyzeWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        const requestId = Date.now();

        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuAnalyzeWorker.removeEventListener('message', handler);

                if (e.data.type === 'analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'analyze-error') {
                    reject(new Error(e.data.error));
                }
            };

            gpuAnalyzeWorker.addEventListener('message', handler);
            gpuAnalyzeWorker.postMessage({
                type: 'analyze-batch',
                frames,
                width,
                height,
                bayerPattern,
                threshold,
                requestId,
                metadataOnly
            });
        });
    }

    /**
     * Crop and analyze frames in one GPU pass
     * @param frames - Array of { data, index } where data is raw frame buffer
     * @param srcWidth - Source frame width
     * @param srcHeight - Source frame height
     * @param cropSize - Output crop size (square)
     * @param centers - Array of {x, y} per-frame centers
     * @param bayerPattern - GPU pattern index (0-3) or -1 for MONO
     * @param threshold - Threshold for moments (default 0.1)
     */
    async function cropAndAnalyzeGpu(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold = 0.1, metadataOnly = false) {
        if (!gpuAnalyzeWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        const requestId = Date.now() + Math.random();

        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuAnalyzeWorker.removeEventListener('message', handler);

                if (e.data.type === 'crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'crop-analyze-error') {
                    reject(new Error(e.data.error));
                }
            };

            gpuAnalyzeWorker.addEventListener('message', handler);
            gpuAnalyzeWorker.postMessage({
                type: 'crop-analyze-batch',
                frames,
                srcWidth,
                srcHeight,
                cropSize,
                centers,
                bayerPattern,
                threshold,
                requestId,
                metadataOnly
            });
        });
    }

    /**
     * Combined detect + crop + analyze in ONE GPU pass (single demosaic)
     * This is 2x faster than separate analyzeFrameBatchGpu + cropAndAnalyzeGpu
     *
     * @param frames - Array of { data, index } where data is raw frame buffer
     * @param srcWidth - Source frame width
     * @param srcHeight - Source frame height
     * @param cropSize - Output crop size (square)
     * @param bayerPattern - GPU pattern index (0-3) or -1 for MONO
     * @param threshold - Threshold for bounds detection (default 0.1)
     * @param metadataOnly - If true, return uint8Buffer (8-bit); if false, return float32Buffer (16-bit)
     */
    async function detectCropAnalyzeGpu(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold = 0.1, metadataOnly = false) {
        if (!gpuAnalyzeWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        const requestId = Date.now() + Math.random();

        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuAnalyzeWorker.removeEventListener('message', handler);

                if (e.data.type === 'detect-crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'detect-crop-analyze-error') {
                    reject(new Error(e.data.error));
                }
            };

            gpuAnalyzeWorker.addEventListener('message', handler);
            gpuAnalyzeWorker.postMessage({
                type: 'detect-crop-analyze-batch',
                frames,
                srcWidth,
                srcHeight,
                cropSize,
                bayerPattern,
                threshold,
                requestId,
                metadataOnly
            });
        });
    }

    /**
     * Crop raw Bayer/Mono frame data to a region
     * Ensures even coordinates for Bayer pattern alignment
     */
    function cropRawFrame(data, srcWidth, srcHeight, cropX, cropY, cropSize, bytesPerPixel) {
        // Ensure even coordinates for Bayer pattern
        const x = Math.floor(cropX / 2) * 2;
        const y = Math.floor(cropY / 2) * 2;

        const cropped = new (bytesPerPixel === 2 ? Uint16Array : Uint8Array)(cropSize * cropSize);

        for (let row = 0; row < cropSize; row++) {
            const srcRow = y + row;
            if (srcRow >= srcHeight) break;

            const srcOffset = srcRow * srcWidth + x;
            const dstOffset = row * cropSize;
            const copyLen = Math.min(cropSize, srcWidth - x);

            if (bytesPerPixel === 2) {
                const src16 = new Uint16Array(data.buffer, data.byteOffset + srcOffset * 2, copyLen);
                cropped.set(src16, dstOffset);
            } else {
                const src8 = new Uint8Array(data.buffer, data.byteOffset + srcOffset, copyLen);
                cropped.set(src8, dstOffset);
            }
        }

        return cropped;
    }

    async function readSerFile(file, maxFrames = -1, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, surfaceMode = false) {
        // Reset comparison export captures for new processing
        resetCaptures();

        emit('start-loading', 'Reading file header');
        emit('update-loading', 0); // Initial progress

        const headerBuf = await file.slice(0, 178).arrayBuffer();
        const header = parseSerHeader(headerBuf);

        // Calculate bytes per pixel and frame size
        let bpp = header.pixelDepth > 8 ? 2 : 1;
        let frameSize = header.width * header.height * bpp;

        // Detect if header lies about bit depth (says 16-bit but actually 8-bit)
        // Key check: if 8-bit frameSize matches the header's frame count exactly, it's 8-bit data
        if (header.pixelDepth > 8) {
            const frameSize16 = header.width * header.height * 2;
            const frameSize8 = header.width * header.height * 1;
            const dataSize = file.size - 178;

            const frameCount16 = Math.floor(dataSize / frameSize16);
            const frameCount8 = Math.floor(dataSize / frameSize8);
            const headerFrames = header.frameCount;

            addLog(`Bit depth check: header=${headerFrames} frames, as 16-bit=${frameCount16}, as 8-bit=${frameCount8}`);

            // If 8-bit calculation matches header frame count, it's actually 8-bit data
            if (frameCount8 === headerFrames && frameCount16 !== headerFrames) {
                addLog(`Header says 16-bit but file size matches 8-bit (${headerFrames} frames). Treating as 8-bit.`);
                header.pixelDepth = 8;
                bpp = 1;
                frameSize = frameSize8;
            }
        }

        // Validate header against actual file size
        const expectedFileSize = 178 + (frameSize * header.frameCount);
        const actualFrameCount = Math.floor((file.size - 178) / frameSize);

        addLog(`SER Header: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit, colorID=${header.colorID}, littleEndian=${header.littleEndian}`);

        // Use calculated frame count if header value seems wrong
        if (actualFrameCount !== header.frameCount) {
            addLog(`Warning: Header says ${header.frameCount} frames, but file size suggests ${actualFrameCount} frames. Using calculated value.`);
            header.frameCount = actualFrameCount;
        }

        // Determine initial bayer choice from header for auto-detection hint
        // SER colorID to OpenCV Bayer patterns (OpenCV uses inverted naming convention)
        // Industry RGGB → OpenCV BG, Industry BGGR → OpenCV RG, etc.
        const bayerMap = { 0: "MONO", 8: "COLOR_BayerBG2RGB", 9: "COLOR_BayerGB2RGB", 10: "COLOR_BayerGR2RGB", 11: "COLOR_BayerRG2RGB" };
        let autoDetectedProfile = bayerMap[header.colorID];
        if (!autoDetectedProfile) {
            // Default fallback for unknown colorID - use RGGB (most common)
            autoDetectedProfile = "COLOR_BayerBG2RGB";
        }

        // Read first frame for color profile selector
        const firstFrameBuffer = await file.slice(178, 178 + frameSize).arrayBuffer();

        // Detect if 16-bit data doesn't use full range (common: 8-bit, 10-bit, 12-bit in 16-bit container)
        // Scale factor to expand data to full 16-bit range for proper shader processing
        let data16bitScaleFactor = 1;
        if (header.pixelDepth > 8) {
            const u16 = new Uint16Array(firstFrameBuffer);
            // Sample pixels across the frame for reliable max detection
            const sampleSize = Math.min(5000, u16.length);
            const step = Math.max(1, Math.floor(u16.length / sampleSize));
            let maxVal = 0;
            for (let i = 0; i < u16.length && i < sampleSize * step; i += step) {
                if (u16[i] > maxVal) maxVal = u16[i];
            }
            addLog(`16-bit diagnostic: max sampled value=${maxVal}`);

            // Determine scale factor based on actual data range
            // Common bit depths: 8-bit (255), 10-bit (1023), 12-bit (4095), 14-bit (16383)
            if (maxVal > 0 && maxVal < 32768) {
                // Find the likely bit depth and scale to full 16-bit
                let effectiveBits;
                if (maxVal <= 255) effectiveBits = 8;
                else if (maxVal <= 1023) effectiveBits = 10;
                else if (maxVal <= 4095) effectiveBits = 12;
                else if (maxVal <= 16383) effectiveBits = 14;
                else effectiveBits = 16;

                if (effectiveBits < 16) {
                    const maxForBits = (1 << effectiveBits) - 1;
                    data16bitScaleFactor = 65535 / maxForBits;
                    addLog(`Detected ${effectiveBits}-bit data in 16-bit container (max=${maxVal}). Scale factor: ${data16bitScaleFactor.toFixed(2)}`);
                }
            }
        }

        // Helper to scale 16-bit data to full range
        function scale16bitData(buffer, scaleFactor) {
            if (scaleFactor === 1) return buffer;
            const u16 = new Uint16Array(buffer);
            for (let i = 0; i < u16.length; i++) {
                u16[i] = Math.min(65535, Math.round(u16[i] * scaleFactor));
            }
            return buffer;
        }

        // Minimum frame size for auto-crop to be useful
        const MIN_SIZE_FOR_CROP = 300;

        let previewBuffer = firstFrameBuffer;
        // Scale preview buffer if needed (for color profile selector)
        if (data16bitScaleFactor > 1) {
            previewBuffer = firstFrameBuffer.slice(0); // Copy to avoid modifying original
            scale16bitData(previewBuffer, data16bitScaleFactor);
        }
        let previewHeader = header;

        emit('set-caption', 'Select color profile');

        // Wait for user to select a color profile
        const bayerChoice = await new Promise((resolve) => {
            emit('show-color-profile-selector', {
                frameBuffer: previewBuffer,
                header: previewHeader,
                autoDetectedProfile: autoDetectedProfile,
                resolve: resolve
            });
        });

        addLog(`User selected color profile: ${bayerChoice}`);

        emit('set-caption', 'Importing and analyzing frames');

        const frameCount = (maxFrames === -1) ? header.frameCount : Math.min(header.frameCount, maxFrames);

        // Determine if we should auto-crop (only for frames larger than minimum)
        let cropRegion = null;
        let croppedFrameBuffers = []; // Store cropped raw data for SER export

        if (header.width >= MIN_SIZE_FOR_CROP && header.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${header.width}x${header.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionGpu(file, header, frameSize, frameCount, bayerChoice, cropMarginPercent, data16bitScaleFactor);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else {
            addLog(`Frame size ${header.width}x${header.height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = []; // These will store {sharpness, blob, croppedBuffer}
        const allAnalyzedFrames = []; // Keep all frames when manual threshold is enabled
        let bestFrameSoFar = null; // Best frame found so far (for preview)
        let refCandidateSoFar = null; // Most circular from top frames (for preview)

        // Lazy blob creation - only when needed for display
        async function ensureBlob(frame) {
            if (frame.blob) return frame;
            if (!frame.float32Buffer && !frame.uint8Buffer) return frame;
            try {
                let rgba;
                if (frame.uint8Buffer) {
                    // Already Uint8 from metadataOnly mode
                    rgba = new Uint8ClampedArray(frame.uint8Buffer);
                } else {
                    // Convert Float32 (0.0-1.0) to Uint8 (0-255) for display
                    const float32Data = new Float32Array(frame.float32Buffer);
                    rgba = new Uint8ClampedArray(float32Data.length);
                    for (let i = 0; i < float32Data.length; i++) {
                        rgba[i] = Math.round(float32Data[i] * 255);
                    }
                }

                // Auto-stretch for dark images (common with 16-bit SER files)
                // Find min/max of RGB channels (skip alpha)
                let minVal = 255, maxVal = 0;
                for (let i = 0; i < rgba.length; i += 4) {
                    const r = rgba[i], g = rgba[i+1], b = rgba[i+2];
                    minVal = Math.min(minVal, r, g, b);
                    maxVal = Math.max(maxVal, r, g, b);
                }

                // Apply stretch if image is dark (max < 128) or has low dynamic range
                if (maxVal < 128 || (maxVal - minVal) < 64) {
                    const range = maxVal - minVal || 1;
                    const scale = 255 / range;
                    for (let i = 0; i < rgba.length; i += 4) {
                        rgba[i] = Math.min(255, Math.max(0, Math.round((rgba[i] - minVal) * scale)));
                        rgba[i+1] = Math.min(255, Math.max(0, Math.round((rgba[i+1] - minVal) * scale)));
                        rgba[i+2] = Math.min(255, Math.max(0, Math.round((rgba[i+2] - minVal) * scale)));
                        // rgba[i+3] alpha stays unchanged
                    }
                }

                const imageData = new ImageData(rgba, frame.width, frame.height);
                const canvas = new OffscreenCanvas(frame.width, frame.height);
                const ctx = canvas.getContext('2d');
                ctx.putImageData(imageData, 0, 0);
                frame.blob = await canvas.convertToBlob({ type: 'image/png' });
            } catch (e) {
                console.warn(`Failed to create blob for frame ${frame.index}:`, e);
            }
            return frame;
        }

        function rankFrame(frame) {
            // Validate frame has usable data:
            // - float32Buffer (GPU mode with buffer), OR
            // - uint8Buffer (GPU metadataOnly mode), OR
            // - valid blob (CPU mode), OR
            // - index with frameReReader (two-pass mode - will be re-read during stacking)
            const hasTwoPassData = frame.index !== undefined;
            if (!frame.float32Buffer && !frame.uint8Buffer && !hasTwoPassData && (!frame.blob || !(frame.blob instanceof Blob) || frame.blob.size === 0)) {
                console.warn(`Skipping frame ${frame.index}: no valid data`);
                return;
            }

            // Capture post-crop frames for comparison export (sample evenly)
            const bufferForCapture = frame.float32Buffer || frame.uint8Buffer;
            if (bufferForCapture && frame.width && frame.height) {
                capturePostCropFrame(bufferForCapture, frame.width, frame.height, frame.index, frameCount);
            }

            // Keep all frames when manual threshold is enabled
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Update best frame for preview (keep buffer for preview only)
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                // Clear buffer from old best frame if it's not also the refCandidate
                if (bestFrameSoFar && bestFrameSoFar !== refCandidateSoFar) {
                    clearFrameBuffer(bestFrameSoFar);
                }
                bestFrameSoFar = frame;
            } else {
                // This frame is not the best - clear its buffer unless needed elsewhere
                // Buffer will be cleared after checking if it's added to bestFramesForStacking
            }

            // Keep track of best frames for stacking (still needed for non-manual mode)
            let frameAdded = false;
            let evictedFrame = null;
            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
                frameAdded = true;
            } else {
                let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
                    (currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    evictedFrame = bestFramesForStacking[minSharpnessIndex];
                    bestFramesForStacking[minSharpnessIndex] = frame;
                    frameAdded = true;
                }
            }

            // Clear buffers from frames not needed for preview
            // Only bestFrameSoFar and refCandidateSoFar need buffers (for display)
            // All other frames will be re-read during stacking
            // EXCEPT: when manualThreshold is enabled, keep buffers for quality selector preview
            if (!manualThreshold) {
                if (evictedFrame && evictedFrame !== bestFrameSoFar && evictedFrame !== refCandidateSoFar) {
                    clearFrameBuffer(evictedFrame);
                }
                // Clear buffer from current frame if it's not a preview frame
                // (we'll re-read it during stacking if it's in bestFramesForStacking)
                if (frame !== bestFrameSoFar && frame !== refCandidateSoFar) {
                    clearFrameBuffer(frame);
                }
            }

            // Update reference candidate: most circular from top 1% of sharpest frames
            updateRefCandidate();
        }

        // Helper to clear frame buffer to free memory
        function clearFrameBuffer(frame) {
            if (frame) {
                frame.float32Buffer = null;
                frame.uint8Buffer = null;
            }
        }

        function updateRefCandidate() {
            if (bestFramesForStacking.length === 0) return;

            const sorted = [...bestFramesForStacking].sort((a, b) => b.sharpness - a.sharpness);
            const topCount = Math.max(1, Math.ceil(sorted.length * 0.01));
            const topFrames = sorted.slice(0, topCount);

            const mostCircular = topFrames.reduce((best, f) =>
                (f.circularity || 0) > (best.circularity || 0) ? f : best
            );

            if (!refCandidateSoFar || mostCircular.index !== refCandidateSoFar.index) {
                // Clear buffer from old refCandidate if it's not also bestFrameSoFar
                if (refCandidateSoFar && refCandidateSoFar !== bestFrameSoFar) {
                    clearFrameBuffer(refCandidateSoFar);
                }
                refCandidateSoFar = mostCircular;
            }
        }

        // Concurrency control: limit frames in flight to prevent memory exhaustion
        const MAX_IN_FLIGHT = numWorkers * 3;  // e.g., 12 frames for 4 workers
        let inFlight = 0;
        const waitQueue = [];  // Queue of resolvers waiting for a slot

        function releaseSlot() {
            inFlight--;
            if (waitQueue.length > 0) {
                waitQueue.shift()();  // Wake up next waiter
            }
        }

        async function acquireSlot() {
            if (inFlight < MAX_IN_FLIGHT) {
                inFlight++;
                return;
            }
            await new Promise(resolve => waitQueue.push(resolve));
            inFlight++;
        }

        const workerPromises = [];
        let completedFrames = 0;
        let successfulFrames = 0;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;
        let totalErrors = 0;
        const maxErrorsBeforeStopDispatching = 20;
        let stopDispatching = false;

        const headerForWorker = {
            fileId: header.fileId,
            width: header.width,
            height: header.height,
            pixelDepth: header.pixelDepth,
            colorID: header.colorID
        };

        // GPU batch processing path - TWO-PASS MEMORY OPTIMIZATION
        // Pass 1: Analyze frames, store only metadata (no float32Buffer)
        // Pass 2: During stacking, re-read selected frames on-demand via frameReReader
        let frameReReader = null; // Will be set if two-pass mode is used

        const gpuReady = await initGpuAnalyzeWorker();
        if (!gpuReady) {
            throw new Error('WebGPU initialization failed - GPU is required for processing');
        }

        // Batch size for GPU: dynamic based on frame size to avoid memory issues
        // Target ~256MB of Float32 data per batch (width * height * 4 channels * 4 bytes * batchSize)
        const frameBytes = header.width * header.height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 256 * 1024 * 1024; // 256MB
        const maxBatchSize = Math.max(1, Math.min(64, Math.floor(targetBatchMemory / frameBytes)));
        const INITIAL_BATCH_SIZE = Math.min(8, maxBatchSize);
        const BATCH_SIZE = maxBatchSize;
        addLog(`Using batch size ${BATCH_SIZE} for ${header.width}x${header.height} frames`);

        if (cropRegion) {
                    // TWO-PASS GPU PATH: GPU detects centers + analyzes, stores only metadata
                    // Memory savings: ~99% reduction (metadata only vs full float32 buffers)
                    addLog('Using two-pass GPU crop + analyze path (memory optimized)');
                    const cropSize = cropRegion.size;

                    // Map bayer choice to GPU pattern index
                    const bayerPattern = bayerChoiceToGpuPattern(bayerChoice);

                    // Store frame centers for re-reading during stacking
                    const frameCenters = new Map(); // index -> {x, y}

                    // Helper to load a batch of frames from file
                    async function loadBatch(batchStart, batchEnd) {
                        const frames = [];
                        for (let i = batchStart; i < batchEnd; i++) {
                            const offset = 178 + (i * frameSize);
                            if (offset + frameSize > file.size) break;
                            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                            let data;
                            if (header.pixelDepth > 8) {
                                data = new Uint16Array(frameBuffer);
                                // Scale to full 16-bit range if needed
                                if (data16bitScaleFactor > 1) {
                                    for (let j = 0; j < data.length; j++) {
                                        data[j] = Math.min(65535, Math.round(data[j] * data16bitScaleFactor));
                                    }
                                }
                            } else {
                                data = new Uint8Array(frameBuffer);
                            }
                            frames.push({ data, index: i });
                        }
                        return frames;
                    }

                    // Double-buffer: load next batch while GPU processes current
                    let nextBatchPromise = null;
                    let batchStart = 0;
                    let isFirstBatch = true;

                    while (batchStart < frameCount && !stopDispatching) {
                        // Use smaller batch for first iteration for quick preview
                        const currentBatchSize = isFirstBatch ? INITIAL_BATCH_SIZE : BATCH_SIZE;
                        const batchEnd = Math.min(batchStart + currentBatchSize, frameCount);

                        // Get current batch (either pre-loaded or load now)
                        let batchFrames;
                        if (nextBatchPromise) {
                            batchFrames = await nextBatchPromise;
                        } else {
                            batchFrames = await loadBatch(batchStart, batchEnd);
                        }

                        if (batchFrames.length === 0) break;

                        // Start loading next batch while GPU processes current (use full batch size)
                        const nextStart = batchEnd;
                        const nextEnd = Math.min(nextStart + BATCH_SIZE, frameCount);
                        if (nextStart < frameCount) {
                            nextBatchPromise = loadBatch(nextStart, nextEnd);
                        } else {
                            nextBatchPromise = null;
                        }

                        try {
                            // Combined GPU: detect bounds + crop + analyze in ONE demosaic pass
                            // Adjust threshold based on scale factor: scaled background can be much higher
                            // If scale factor is 16 (12-bit data), background of 500 becomes 8000 = 0.12 normalized
                            // So we need threshold > 0.12 to avoid detecting background as object
                            const scaledThreshold = data16bitScaleFactor > 1
                                ? Math.min(0.25, 0.05 * Math.sqrt(data16bitScaleFactor)) // Scale threshold with sqrt of factor
                                : 0.05;
                            const combinedResults = await detectCropAnalyzeGpu(
                                batchFrames, header.width, header.height, cropSize, bayerPattern, scaledThreshold, true
                            );

                            // Filter and process results
                            for (let j = 0; j < combinedResults.length; j++) {
                                const gpuResult = combinedResults[j];
                                const frame = batchFrames[j];

                                // Check if bounds were detected
                                if (!gpuResult.bounds) {
                                    skippedFrames++;
                                    completedFrames++;
                                    continue;
                                }

                                // Check for cut-off (object touching edge) - skip for Sun/Moon
                                if (!surfaceMode) {
                                    const margin = Math.max(header.width, header.height) * 0.01;
                                    if (gpuResult.bounds.x < margin || gpuResult.bounds.y < margin ||
                                        gpuResult.bounds.x + gpuResult.bounds.width > header.width - margin ||
                                        gpuResult.bounds.y + gpuResult.bounds.height > header.height - margin) {
                                        cutOffFrames++;
                                        completedFrames++;
                                        continue;
                                    }
                                }

                                // Check for oversized
                                if (cropRegion.medianObjectSize) {
                                    const size = Math.max(gpuResult.bounds.width, gpuResult.bounds.height);
                                    const sizeRatio = size / cropRegion.medianObjectSize;
                                    if (sizeRatio > 1.3) {
                                        oversizedFrames++;
                                        completedFrames++;
                                        continue;
                                    }
                                }

                                const center = {
                                    x: gpuResult.centerX,
                                    y: gpuResult.centerY
                                };
                                // Store center for later re-reading
                                frameCenters.set(frame.index, center);

                                // Track previous best/ref to detect changes
                                const prevBest = bestFrameSoFar;
                                const prevRef = refCandidateSoFar;

                                // TWO-PASS: Store metadata + 8-bit preview buffer (NO float32Buffer)
                                // Keep uint8Buffer for QualitySelector preview, discard during stacking
                                const currentFrame = {
                                    sharpness: gpuResult.sharpness,
                                    // NO float32Buffer - will be re-read during stacking
                                    // Keep uint8Buffer for preview in QualitySelector
                                    uint8Buffer: gpuResult.uint8Buffer,
                                    width: cropSize,
                                    height: cropSize,
                                    index: gpuResult.index,
                                    centerX: center.x,
                                    centerY: center.y,
                                    subPixelOffset: { x: 0, y: 0 },
                                    circularity: gpuResult.circularity || 0
                                };

                                rankFrame(currentFrame);

                                // Create blob for immediate preview ONLY if this became new best or ref frame
                                const isNewBest = bestFrameSoFar === currentFrame && prevBest !== currentFrame;
                                const isNewRef = refCandidateSoFar === currentFrame && prevRef !== currentFrame;
                                if ((isNewBest || isNewRef) && gpuResult.uint8Buffer) {
                                    try {
                                        const uint8Data = new Uint8ClampedArray(gpuResult.uint8Buffer);
                                        const imageData = new ImageData(uint8Data, cropSize, cropSize);
                                        const canvas = new OffscreenCanvas(cropSize, cropSize);
                                        const ctx = canvas.getContext('2d');
                                        ctx.putImageData(imageData, 0, 0);
                                        currentFrame.blob = await canvas.convertToBlob({ type: 'image/png' });
                                        // Emit immediately so preview shows up fast
                                        if (isNewBest) emit('best-frame-updated', currentFrame);
                                        if (isNewRef) emit('ref-candidate-updated', currentFrame);
                                    } catch (e) {
                                        console.warn(`Failed to create preview for frame ${currentFrame.index}:`, e);
                                    }
                                }

                                successfulFrames++;
                                completedFrames++;

                                if (successfulFrames === 1) {
                                    addLog(`First GPU frame: sharpness ${gpuResult.sharpness?.toFixed(2)}, circularity ${gpuResult.circularity?.toFixed(2)}`);
                                }
                            }
                        } catch (gpuError) {
                            addLog(`GPU batch error: ${gpuError.message}`);
                            reportError(gpuError, { component: 'useSerReader', action: 'detectCropAnalyzeGpu', batchStart });
                            terminateGpuAnalyzeWorker();
                            throw gpuError;
                        }

                        // Update progress
                        emit('update-loading', {
                            progress: (completedFrames / frameCount) * 100,
                            current: completedFrames,
                            total: frameCount
                        });

                        if (completedFrames % 100 === 0 || completedFrames === frameCount) {
                            addLog(`GPU analyzed ${completedFrames}/${frameCount} frames`);
                            if (bestFrameSoFar) {
                                await ensureBlob(bestFrameSoFar);
                                emit('best-frame-updated', bestFrameSoFar);
                            }
                            if (refCandidateSoFar) {
                                await ensureBlob(refCandidateSoFar);
                                emit('ref-candidate-updated', refCandidateSoFar);
                            }
                        }

                        // Move to next batch
                        batchStart = batchEnd;
                        isFirstBatch = false;
                    }

                    // Create frameReReader for two-pass stacking
                    // This allows the stacker to re-read frames on-demand instead of storing all float32 buffers
                    if (frameCenters.size > 0) {
                        frameReReader = {
                            fileType: 'ser',
                            file,
                            header: headerForWorker,
                            bayerChoice,
                            cropRegion,
                            frameCenters, // Map of index -> {x, y}
                            frameSize,

                            // Re-read a single frame and return float32Buffer
                            async getFrame(frameIndex, centerOverride = null) {
                                const offset = 178 + (frameIndex * this.frameSize);
                                const frameBuffer = await this.file.slice(offset, offset + this.frameSize).arrayBuffer();

                                // Get center from stored centers or override
                                const center = centerOverride || this.frameCenters.get(frameIndex);
                                if (!center) {
                                    console.warn(`No center found for frame ${frameIndex}`);
                                    return null;
                                }

                                return {
                                    frameBuffer,
                                    centerX: center.x,
                                    centerY: center.y
                                };
                            },

                            // Re-read multiple frames in parallel (for batch processing)
                            async getFrames(frameIndices) {
                                const results = await Promise.all(
                                    frameIndices.map(idx => this.getFrame(idx))
                                );
                                return results.filter(r => r !== null);
                            }
                        };
                        addLog(`Created frameReReader with ${frameCenters.size} frame centers for two-pass stacking`);
                    }

                } else {
                    // PURE GPU PATH: No cropping needed (two-pass mode for memory efficiency)
                    addLog('Using WebGPU for frame analysis (no cropping, two-pass mode)');
                    const gpuBayerPattern = bayerChoiceToGpuPattern(bayerChoice);
                    const processWidth = header.width;
                    const processHeight = header.height;

                    // Helper to load a batch
                    async function loadBatchNoCrop(batchStart, batchEnd) {
                        const frames = [];
                        for (let i = batchStart; i < batchEnd; i++) {
                            const offset = 178 + (i * frameSize);
                            if (offset + frameSize > file.size) break;
                            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                            let frameData;
                            if (bpp === 2) {
                                frameData = new Uint16Array(frameBuffer);
                                // Scale to full 16-bit range if needed
                                if (data16bitScaleFactor > 1) {
                                    for (let j = 0; j < frameData.length; j++) {
                                        frameData[j] = Math.min(65535, Math.round(frameData[j] * data16bitScaleFactor));
                                    }
                                }
                            } else {
                                frameData = new Uint8Array(frameBuffer);
                            }
                            frames.push({ data: frameData, index: i });
                        }
                        return frames;
                    }

                    // Double-buffer: load next batch while GPU processes current
                    let nextBatchPromise = null;
                    let batchStart = 0;

                    while (batchStart < frameCount && !stopDispatching) {
                        const batchEnd = Math.min(batchStart + BATCH_SIZE, frameCount);

                        // Get current batch
                        let batchFrames;
                        if (nextBatchPromise) {
                            batchFrames = await nextBatchPromise;
                        } else {
                            batchFrames = await loadBatchNoCrop(batchStart, batchEnd);
                        }

                        if (batchFrames.length === 0) break;

                        // Start loading next batch while GPU processes
                        const nextStart = batchEnd;
                        const nextEnd = Math.min(nextStart + BATCH_SIZE, frameCount);
                        if (nextStart < frameCount) {
                            nextBatchPromise = loadBatchNoCrop(nextStart, nextEnd);
                        } else {
                            nextBatchPromise = null;
                        }

                        try {
                            // Use metadataOnly=true to avoid creating Float32 buffers during analyze
                            // Adjust threshold based on scale factor to avoid detecting scaled background
                            const scaledThreshold = data16bitScaleFactor > 1
                                ? Math.min(0.25, 0.05 * Math.sqrt(data16bitScaleFactor))
                                : 0.1;
                            const results = await analyzeFrameBatchGpu(
                                batchFrames, processWidth, processHeight, gpuBayerPattern, scaledThreshold, true
                            );

                            for (let j = 0; j < results.length; j++) {
                                const result = results[j];
                                const frameIndex = batchFrames[j].index;

                                // Two-pass mode: store only metadata, re-read frames during stacking
                                // For no-crop mode, center is fixed at frame center
                                const currentFrame = {
                                    sharpness: result.sharpness,
                                    uint8Buffer: result.uint8Buffer, // 8-bit for preview only
                                    width: processWidth,
                                    height: processHeight,
                                    index: frameIndex,
                                    centerX: processWidth / 2,
                                    centerY: processHeight / 2,
                                    subPixelOffset: { x: 0, y: 0 },
                                    circularity: result.circularity || 0
                                };

                                rankFrame(currentFrame);
                                successfulFrames++;
                                completedFrames++;

                                if (successfulFrames === 1) {
                                    addLog(`First GPU frame: sharpness ${result.sharpness?.toFixed(2)}, circularity ${result.circularity?.toFixed(2)}`);
                                }
                            }

                            emit('update-loading', {
                                progress: (completedFrames / frameCount) * 100,
                                current: completedFrames,
                                total: frameCount
                            });

                            if (completedFrames % 100 === 0 || completedFrames === frameCount) {
                                addLog(`GPU analyzed ${completedFrames}/${frameCount} frames`);
                                if (bestFrameSoFar) {
                                    await ensureBlob(bestFrameSoFar);
                                    emit('best-frame-updated', bestFrameSoFar);
                                }
                                if (refCandidateSoFar) {
                                    await ensureBlob(refCandidateSoFar);
                                    emit('ref-candidate-updated', refCandidateSoFar);
                                }
                            }
                        } catch (gpuError) {
                            addLog(`GPU batch error: ${gpuError.message}`);
                            reportError(gpuError, { component: 'useSerReader', action: 'analyzeFrameBatchGpu-noCrop', batchStart });
                            terminateGpuAnalyzeWorker();
                            throw gpuError;
                        }

                        // Move to next batch
                        batchStart = batchEnd;
                    }

                    // Create frameReReader for two-pass stacking (no cropping needed)
                    frameReReader = {
                        header,
                        file,
                        frameSize,
                        bpp,
                        bayerPattern: gpuBayerPattern,
                        width: processWidth,
                        height: processHeight,
                        noCrop: true, // Flag to indicate no cropping needed

                        // Re-read a single frame by index
                        async getFrame(frameIndex) {
                            const offset = 178 + (frameIndex * this.frameSize);
                            const frameBuffer = await this.file.slice(offset, offset + this.frameSize).arrayBuffer();

                            return {
                                frameBuffer,
                                // No center needed for no-crop mode
                                centerX: this.width / 2,
                                centerY: this.height / 2
                            };
                        },

                        // Re-read multiple frames in parallel (for batch processing)
                        async getFrames(frameIndices) {
                            const results = await Promise.all(
                                frameIndices.map(idx => this.getFrame(idx))
                            );
                            return results.filter(r => r !== null);
                        }
                    };
                    addLog(`Created frameReReader for two-pass stacking (no-crop mode, ${processWidth}x${processHeight})`);
                }

        terminateGpuAnalyzeWorker();

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} crop-failed`);
        if (totalErrors > 0) skipMsgs.push(`${totalErrors} errors`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Analyzed ${successfulFrames}/${frameCount} frames successfully. Kept ${bestFramesForStacking.length} best.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: frameCount, done: true });

        // Offer cropped SER download if we did cropping - available immediately before upload
        if (cropRegion && croppedFrameBuffers.length > 0) {
            const validFrameCount = croppedFrameBuffers.filter(b => b).length;
            const croppedSerBlob = createCroppedSerFile(header, cropRegion, croppedFrameBuffers);
            emit('cropped-ser-ready', {
                blob: croppedSerBlob,
                cropSize: cropRegion.size,
                frameCount: validFrameCount
            });
            addLog(`Cropped SER ready: ${cropRegion.size}x${cropRegion.size}, ${validFrameCount} frames - download available now`);
            emit('set-caption', 'Cropped SER ready for download');
        }

        if (manualThreshold) {
            // Manual threshold: emit frames for quality selector
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: [], // GPU mode creates its own workers
                noiseRobustAlignment,
                useWebGPU: true,
                frameReReader // Two-pass: include frameReReader for on-demand frame loading
            });
            return;
        } else {
            // Client-side stacking (always on)
            emit('set-caption', 'Stacking frames locally...');
            addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

            // Emit for debug frame access
            emit('debug-frames-available', { frames: bestFramesForStacking });

            // Two-pass mode: pass frameReReader for on-demand frame loading
            const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, noiseRobustAlignment, true, frameReReader, surfaceMode);

            if (stackResult && stackResult.blob) {
                addLog('Client-side stacking complete');
                emit('stacked-image-ready', {
                    blob: stackResult.blob,
                    float32Data: stackResult.float32Data,
                    width: stackResult.width,
                    height: stackResult.height
                });
            } else {
                addLog('Client-side stacking failed - no valid frames');
                emit('stack-failed', { component: 'useSerReader', reason: 'no valid frames' });
                emit('stop-loading');
            }
        }

        // Terminate workers after all tasks are done (CPU mode only - GPU creates/terminates its own)
        if (unifiedAnalyzeWorkers.length > 0) {
            unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
        pendingFrames.clear();
        workersReady = false;
    }

    // Create a SER file from cropped frame buffers
    function createCroppedSerFile(originalHeader, cropRegion, frameBuffers) {
        const validFrames = frameBuffers.filter(b => b);
        const frameCount = validFrames.length;
        const bpp = originalHeader.pixelDepth > 8 ? 2 : 1;
        const croppedFrameSize = cropRegion.size * cropRegion.size * bpp;

        // SER header is 178 bytes
        const totalSize = 178 + (croppedFrameSize * frameCount);
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);

        // Write SER header (little-endian)
        // File ID: "LUCAM-RECORDER" (14 bytes)
        const fileId = "LUCAM-RECORDER";
        for (let i = 0; i < 14; i++) {
            uint8[i] = fileId.charCodeAt(i);
        }

        // LuID (4 bytes) - camera ID
        view.setInt32(14, 0, true);

        // Color ID (4 bytes) - same as original
        view.setInt32(18, originalHeader.colorID, true);

        // Little endian (4 bytes) - 0 = big endian, otherwise little
        view.setInt32(22, 0, true);

        // Image width (4 bytes)
        view.setInt32(26, cropRegion.size, true);

        // Image height (4 bytes)
        view.setInt32(30, cropRegion.size, true);

        // Pixel depth per plane (4 bytes)
        view.setInt32(34, originalHeader.pixelDepth, true);

        // Frame count (4 bytes)
        view.setInt32(38, frameCount, true);

        // Observer (40 bytes) - leave empty
        // Instrument (40 bytes) - leave empty
        // Telescope (40 bytes) - leave empty
        // DateTime (8 bytes) - leave as 0
        // DateTime UTC (8 bytes) - leave as 0

        // Write frame data
        let offset = 178;
        for (const frameBuffer of validFrames) {
            uint8.set(new Uint8Array(frameBuffer), offset);
            offset += croppedFrameSize;
        }

        return new Blob([buffer], { type: 'application/octet-stream' });
    }

    // GPU-accelerated crop region detection across multiple files
    async function detectCropRegionMultiFileGpu(fileInfos, bayerChoice, cropMarginPercent = 10) {
        emit('set-caption', 'Detecting planet position across files (GPU)...');

        // Initialize GPU worker
        const gpuReady = await initGpuAnalyzeWorker();
        if (!gpuReady) {
            addLog('GPU not available, falling back to CPU detection');
            await initializeWorkers(); // Lazy init CPU workers only when needed
            return detectCropRegionMultiFile(fileInfos, bayerChoice, cropMarginPercent);
        }

        const totalFrames = fileInfos.reduce((sum, info) => sum + info.frameCount, 0);
        const targetSamples = 50; // Total samples across all files

        emit('update-loading', { progress: 0, current: 0, total: targetSamples });

        // Map bayer choice to pattern index for GPU
        // bayerChoice comes from ColorProfileSelector as OpenCV constants
        // GPU shader: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
        const bayerPatternMap = {
            // Short names (for backwards compat)
            'RGGB': 0, 'BGGR': 1, 'GRBG': 2, 'GBRG': 3, 'MONO': -1,
            // OpenCV constants (inverted naming: BG=RGGB, RG=BGGR, GB=GRBG, GR=GBRG)
            'COLOR_BayerBG2RGB': 0,  // Industry RGGB
            'COLOR_BayerRG2RGB': 1,  // Industry BGGR
            'COLOR_BayerGB2RGB': 2,  // Industry GRBG
            'COLOR_BayerGR2RGB': 3,  // Industry GBRG
        };
        const bayerPattern = bayerPatternMap[bayerChoice] ?? -1;

        // Collect sample frame indices from all files
        const sampleFrames = [];
        for (const info of fileInfos) {
            const { file, header, frameSize, frameCount } = info;

            // Sample proportionally based on this file's contribution to total
            const samplesForThisFile = Math.max(1, Math.round((frameCount / totalFrames) * targetSamples));
            const sampleInterval = Math.max(1, Math.floor(frameCount / samplesForThisFile));

            for (let i = 0; i < frameCount; i += sampleInterval) {
                const offset = 178 + (i * frameSize);
                if (offset + frameSize > file.size) break;

                sampleFrames.push({
                    file,
                    header,
                    frameSize,
                    frameIndex: i,
                    offset
                });
            }
        }

        addLog(`GPU sampling ${sampleFrames.length} frames for crop detection across ${fileInfos.length} files...`);

        // Process frames in batches for GPU - dynamic size based on dimensions
        const referenceHeader = fileInfos[0].header;
        const frameBytes = referenceHeader.width * referenceHeader.height * 16; // Float32 RGBA
        const targetMemory = 256 * 1024 * 1024; // 256MB
        const batchSize = Math.max(2, Math.min(16, Math.floor(targetMemory / frameBytes)));
        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleFrames.length; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, sampleFrames.length);
            const batchItems = sampleFrames.slice(batchStart, batchEnd);

            // All frames must have same dimensions for GPU batch processing
            // Use first file's header as reference (already validated same in readSerFiles)
            const referenceHeader = fileInfos[0].header;

            // Load frame data for this batch
            const frames = [];
            for (const item of batchItems) {
                const frameBuffer = await item.file.slice(item.offset, item.offset + item.frameSize).arrayBuffer();

                // Convert to appropriate typed array based on pixel depth
                let data;
                if (item.header.pixelDepth > 8) {
                    data = new Uint16Array(frameBuffer);
                    // Detect effective bit depth and scale to full 16-bit range
                    const sampleMax = Math.max(...data.slice(0, Math.min(1000, data.length)));
                    if (sampleMax > 0 && sampleMax < 32768) {
                        let scaleFactor = 1;
                        if (sampleMax <= 255) scaleFactor = 257;        // 8-bit
                        else if (sampleMax <= 1023) scaleFactor = 64;   // 10-bit
                        else if (sampleMax <= 4095) scaleFactor = 16;   // 12-bit
                        else if (sampleMax <= 16383) scaleFactor = 4;   // 14-bit
                        if (scaleFactor > 1) {
                            for (let j = 0; j < data.length; j++) {
                                data[j] = Math.min(65535, data[j] * scaleFactor);
                            }
                        }
                    }
                } else {
                    data = new Uint8Array(frameBuffer);
                }
                frames.push({ data, index: item.frameIndex });
            }

            try {
                // GPU analyze with threshold ~0.05 (matching CPU threshold)
                const results = await analyzeFrameBatchGpu(frames, referenceHeader.width, referenceHeader.height, bayerPattern, 0.05);

                for (const result of results) {
                    if (result.bounds) {
                        canCropCount++;
                        // Add 20% margin on each side (1.4x) to match CPU's detectObjectBounds
                        const rawSize = Math.max(result.bounds.width, result.bounds.height);
                        const size = rawSize * 1.4;
                        maxSize = Math.max(maxSize, size);
                        detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
                        detectedSizes.push(size);
                    }
                }
            } catch (err) {
                console.error('GPU multi-file crop detection batch error:', err);
                // Continue with other batches
            }

            emit('update-loading', {
                progress: (batchEnd / sampleFrames.length) * 100,
                current: batchEnd,
                total: sampleFrames.length
            });
        }

        // Only need 50% of frames to be croppable
        const cropThreshold = sampleFrames.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleFrames.length} frames can be cropped across files. Skipping auto-crop.`);
            return null;
        }

        // Calculate median size (more robust than max which can be skewed by moons/noise)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        // Use median size with margin, capped at smallest frame dimensions
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(...fileInfos.map(info => Math.min(info.header.width, info.header.height)));
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds smallest frame size ${maxAllowedSize}, clamping`);
        }

        if (detectedCenters.length === 0) {
            addLog(`GPU detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${sampleFrames.length} frames croppable)`);
            return { size: finalSize, medianObjectSize: medianSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`GPU detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, max detected: ${maxSize} (${canCropCount}/${sampleFrames.length} frames croppable across ${fileInfos.length} files)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Detect crop region across multiple files
    // Samples frames proportionally from each file based on frame count
    async function detectCropRegionMultiFile(fileInfos, bayerChoice, cropMarginPercent = 10) {
        emit('set-caption', 'Detecting planet position across files...');

        const totalFrames = fileInfos.reduce((sum, info) => sum + info.frameCount, 0);
        const targetSamples = 50; // Total samples across all files

        emit('update-loading', { progress: 0, current: 0, total: targetSamples });

        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];
        const boundsPromises = [];
        let sampleIndex = 0;

        for (const info of fileInfos) {
            const { file, header, frameSize, frameCount } = info;

            // Sample proportionally based on this file's contribution to total
            const samplesForThisFile = Math.max(1, Math.round((frameCount / totalFrames) * targetSamples));
            const sampleInterval = Math.max(1, Math.floor(frameCount / samplesForThisFile));

            const headerForWorker = {
                fileId: header.fileId,
                width: header.width,
                height: header.height,
                pixelDepth: header.pixelDepth,
                colorID: header.colorID
            };

            for (let i = 0; i < frameCount; i += sampleInterval) {
                const offset = 178 + (i * frameSize);
                if (offset + frameSize > file.size) break;

                const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                const workerIndex = sampleIndex % numWorkers;

                const dataToWorker = {
                    type: 'detect-bounds',
                    frameBuffer: frameBuffer,
                    header: headerForWorker,
                    bayerChoice: bayerChoice,
                    index: sampleIndex
                };

                const currentSampleIndex = sampleIndex;
                const promise = processFrameWithWorker(workerIndex, dataToWorker, [frameBuffer])
                    .then(result => {
                        if (result.bounds && result.bounds.canCrop) {
                            canCropCount++;
                            maxSize = Math.max(maxSize, result.bounds.size);
                            detectedCenters.push({ x: result.bounds.centerX, y: result.bounds.centerY });
                            detectedSizes.push(result.bounds.size);
                        }
                        emit('update-loading', {
                            progress: ((currentSampleIndex + 1) / targetSamples) * 100,
                            current: currentSampleIndex + 1,
                            total: targetSamples
                        });
                    })
                    .catch(error => {
                        if (isHeapCorruptionError(error)) {
                            forceWorkerRecycle(workerIndex);
                        }
                        console.error(`Error detecting bounds for sample ${currentSampleIndex}:`, error);
                    });

                boundsPromises.push(promise);
                sampleIndex++;
            }
        }

        await Promise.all(boundsPromises);

        const actualSamples = sampleIndex;
        const cropThreshold = actualSamples * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${actualSamples} frames can be cropped across files. Skipping auto-crop.`);
            return null;
        }

        // Calculate median size (more robust than max which can be skewed by moons/noise)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        // Use median size with margin, capped at smallest frame dimensions
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(...fileInfos.map(info => Math.min(info.header.width, info.header.height)));
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds smallest frame size ${maxAllowedSize}, clamping`);
        }

        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${actualSamples} frames croppable)`);
            return { size: finalSize, medianObjectSize: medianSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, max detected: ${maxSize} (${canCropCount}/${actualSamples} frames croppable across ${fileInfos.length} files)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Process multiple SER files and combine their frames for stacking
    // NOTE: Future consideration - similar multi-file support could be added to useAviReader.js
    async function readSerFiles(files, maxFrames = -1, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, surfaceMode = false) {
        // Reset comparison export captures for new processing
        resetCaptures();

        // CPU workers (with OpenCV) are initialized lazily only if GPU fallback is needed

        emit('start-loading', 'Reading file headers...');
        emit('update-loading', 0);

        // PHASE 1: Parse all headers and validate
        addLog(`Parsing headers for ${files.length} SER files...`);
        const fileInfos = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const headerBuf = await file.slice(0, 178).arrayBuffer();
                const header = parseSerHeader(headerBuf);

                const bpp = header.pixelDepth > 8 ? 2 : 1;
                const frameSize = header.width * header.height * bpp;

                // Validate frame count against file size
                const actualFrameCount = Math.floor((file.size - 178) / frameSize);
                if (actualFrameCount !== header.frameCount) {
                    addLog(`${file.name}: Header says ${header.frameCount} frames, file size suggests ${actualFrameCount}. Using calculated value.`);
                    header.frameCount = actualFrameCount;
                }

                fileInfos.push({
                    file,
                    header,
                    frameSize,
                    frameCount: header.frameCount,
                    filename: file.name
                });

                addLog(`${file.name}: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit, colorID=${header.colorID}`);
            } catch (error) {
                reportError(error, { component: 'useSerReader', action: 'parseSerHeader', extra: { fileName: file.name, fileSize: file.size } });
                addLog(`Error reading ${file.name}: ${error.message}. Skipping this file.`);
                // Continue with other files
            }
        }

        if (fileInfos.length === 0) {
            addLog("No valid SER files to process.");
            emit('stop-loading');
            return;
        }

        // PHASE 2: Validate colorIDs match
        const colorIDs = [...new Set(fileInfos.map(info => info.header.colorID))];
        if (colorIDs.length > 1) {
            addLog(`Error: Files have different color formats (colorIDs: ${colorIDs.join(', ')}). All files must use the same color format.`);
            emit('upload-error', 'Selected SER files have different color formats. Please select files with matching formats.');
            emit('stop-loading');
            return;
        }

        const totalFramesAvailable = fileInfos.reduce((sum, info) => sum + info.frameCount, 0);
        addLog(`Total frames across ${fileInfos.length} files: ${totalFramesAvailable}`);

        // Apply global max frames limit
        let totalFramesToProcess = totalFramesAvailable;
        if (maxFrames > 0 && totalFramesAvailable > maxFrames) {
            totalFramesToProcess = maxFrames;
            addLog(`Limiting to ${maxFrames} frames total (global limit)`);
        }

        // PHASE 3: Color profile selection (using first file's header)
        const firstHeader = fileInfos[0].header;
        const firstFrameSize = fileInfos[0].frameSize;
        // SER colorID to OpenCV Bayer patterns (OpenCV uses inverted naming convention)
        const bayerMap = { 0: "MONO", 8: "COLOR_BayerBG2RGB", 9: "COLOR_BayerGB2RGB", 10: "COLOR_BayerGR2RGB", 11: "COLOR_BayerRG2RGB" };
        let autoDetectedProfile = bayerMap[firstHeader.colorID] || "COLOR_BayerBG2RGB";

        const firstFrameBuffer = await fileInfos[0].file.slice(178, 178 + firstFrameSize).arrayBuffer();

        // Try to crop the first frame for better preview in color selector
        let previewBuffer = firstFrameBuffer;
        let previewHeader = firstHeader;
        const MIN_SIZE_FOR_CROP = 300;

        if (firstHeader.width >= MIN_SIZE_FOR_CROP && firstHeader.height >= MIN_SIZE_FOR_CROP) {
            emit('set-caption', 'Detecting planet for preview...');
            try {
                // Use GPU for preview bounds detection (avoids loading OpenCV)
                const gpuReady = await initGpuAnalyzeWorker();
                let boundsResult = null;

                if (gpuReady) {
                    const frameData = firstHeader.pixelDepth > 8
                        ? new Uint16Array(firstFrameBuffer)
                        : new Uint8Array(firstFrameBuffer);
                    const frames = [{ data: frameData, index: 0 }];
                    const results = await analyzeFrameBatchGpu(frames, firstHeader.width, firstHeader.height, -1, 0.05, true);
                    if (results && results[0] && results[0].bounds) {
                        boundsResult = {
                            bounds: {
                                canCrop: true,
                                centerX: results[0].bounds.centroidX,
                                centerY: results[0].bounds.centroidY,
                                size: Math.max(results[0].bounds.width, results[0].bounds.height)
                            }
                        };
                    }
                }

                if (boundsResult && boundsResult.bounds && boundsResult.bounds.canCrop) {
                    const { centerX, centerY, size } = boundsResult.bounds;
                    const previewMargin = 1 + (cropMarginPercent / 100);
                    const cropSize = Math.ceil(size * previewMargin / 2) * 2;
                    const maxCropSize = Math.min(firstHeader.width, firstHeader.height);

                    if (cropSize < maxCropSize) {
                        const bpp = firstHeader.pixelDepth > 8 ? 2 : 1;
                        const halfSize = Math.floor(cropSize / 2);
                        // Ensure even start coordinates to preserve Bayer pattern alignment
                        let startX = Math.max(0, Math.min(firstHeader.width - cropSize, Math.round(centerX) - halfSize));
                        let startY = Math.max(0, Math.min(firstHeader.height - cropSize, Math.round(centerY) - halfSize));
                        startX = Math.floor(startX / 2) * 2;
                        startY = Math.floor(startY / 2) * 2;

                        const croppedBuffer = new ArrayBuffer(cropSize * cropSize * bpp);
                        const srcView = firstHeader.pixelDepth > 8 ? new Uint16Array(firstFrameBuffer) : new Uint8Array(firstFrameBuffer);
                        const dstView = firstHeader.pixelDepth > 8 ? new Uint16Array(croppedBuffer) : new Uint8Array(croppedBuffer);

                        for (let y = 0; y < cropSize; y++) {
                            const srcOffset = (startY + y) * firstHeader.width + startX;
                            const dstOffset = y * cropSize;
                            dstView.set(srcView.subarray(srcOffset, srcOffset + cropSize), dstOffset);
                        }

                        previewBuffer = croppedBuffer;
                        previewHeader = { ...firstHeader, width: cropSize, height: cropSize };
                        addLog(`Cropped preview to ${cropSize}x${cropSize} for color selector`);
                    }
                }
            } catch (error) {
                addLog(`Could not crop preview: ${error.message}`);
            }
        }

        emit('set-caption', 'Select color profile');

        const bayerChoice = await new Promise((resolve) => {
            emit('show-color-profile-selector', {
                frameBuffer: previewBuffer,
                header: previewHeader,
                autoDetectedProfile: autoDetectedProfile,
                resolve: resolve
            });
        });

        addLog(`User selected color profile: ${bayerChoice}`);

        // PHASE 4: Detect crop region across all files
        // MIN_SIZE_FOR_CROP already defined above
        let cropRegion = null;

        // Check if all files qualify for cropping
        const allQualifyForCrop = fileInfos.every(info =>
            info.header.width >= MIN_SIZE_FOR_CROP && info.header.height >= MIN_SIZE_FOR_CROP
        );

        if (allQualifyForCrop) {
            addLog(`All files qualify for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
            // Use GPU detection (falls back to CPU automatically if needed)
            cropRegion = await detectCropRegionMultiFileGpu(fileInfos, bayerChoice, cropMarginPercent);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else {
            addLog(`Some files too small for auto-crop, skipping crop detection`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        // PHASE 5: Analyze all frames from all files
        // Multi-file processing still uses CPU workers (TODO: convert to GPU)
        await initializeWorkers();
        if (!workersReady) {
            addLog("Stopping SER processing due to worker initialization failure.");
            emit('show-error');
            return;
        }

        // Use streaming ranking - only keep best N% in memory to avoid crashes
        const bestFramesCapacity = Math.max(1, Math.floor(totalFramesToProcess * stackPercentage / 100));
        const bestFramesForStacking = [];
        const allAnalyzedFrames = []; // Only used when manualThreshold is true
        let bestFrameSoFar = null;
        let refCandidateSoFar = null;

        // Helper to clear frame buffer to free memory
        function clearFrameBuffer(frame) {
            if (frame) {
                frame.float32Buffer = null;
                frame.uint8Buffer = null;
            }
        }

        // Streaming rank function - keeps only top N frames in memory
        function rankFrame(frame) {
            // Capture post-crop frames for comparison export (sample evenly)
            const bufferForCapture = frame.float32Buffer || frame.uint8Buffer;
            if (bufferForCapture && frame.width && frame.height) {
                capturePostCropFrame(bufferForCapture, frame.width, frame.height, frame.index, totalFramesToProcess);
            }

            // For manual threshold, we need all frames (may still crash on large sets)
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Track best frame for preview (keep buffer for preview only)
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                // Clear buffer from old best frame if it's not also the refCandidate
                if (bestFrameSoFar && bestFrameSoFar !== refCandidateSoFar) {
                    clearFrameBuffer(bestFrameSoFar);
                }
                bestFrameSoFar = frame;
            }

            // Streaming top-N: only keep best frames
            let evictedFrame = null;
            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                // Find the worst frame in our current best set
                let minSharpnessIndex = 0;
                for (let i = 1; i < bestFramesForStacking.length; i++) {
                    if (bestFramesForStacking[i].sharpness < bestFramesForStacking[minSharpnessIndex].sharpness) {
                        minSharpnessIndex = i;
                    }
                }

                // Replace if current frame is better
                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    evictedFrame = bestFramesForStacking[minSharpnessIndex];
                    bestFramesForStacking[minSharpnessIndex] = frame;
                }
                // Otherwise frame is discarded (not kept in memory)
            }

            // Clear buffers from frames not needed for preview
            // Only bestFrameSoFar and refCandidateSoFar need buffers (for display)
            // All other frames will be re-read during stacking
            // EXCEPT: when manualThreshold is enabled, keep buffers for quality selector preview
            if (!manualThreshold) {
                if (evictedFrame && evictedFrame !== bestFrameSoFar && evictedFrame !== refCandidateSoFar) {
                    clearFrameBuffer(evictedFrame);
                }
                // Clear buffer from current frame if it's not a preview frame
                if (frame !== bestFrameSoFar && frame !== refCandidateSoFar) {
                    clearFrameBuffer(frame);
                }
            }

            // Update reference candidate: most circular from top 1% of sharpest frames
            updateRefCandidate();
        }

        function updateRefCandidate() {
            if (bestFramesForStacking.length === 0) return;

            const sorted = [...bestFramesForStacking].sort((a, b) => b.sharpness - a.sharpness);
            const topCount = Math.max(1, Math.ceil(sorted.length * 0.01));
            const topFrames = sorted.slice(0, topCount);

            const mostCircular = topFrames.reduce((best, f) =>
                (f.circularity || 0) > (best.circularity || 0) ? f : best
            );

            if (!refCandidateSoFar || mostCircular.index !== refCandidateSoFar.index) {
                // Clear buffer from old refCandidate if it's not also bestFrameSoFar
                if (refCandidateSoFar && refCandidateSoFar !== bestFrameSoFar) {
                    clearFrameBuffer(refCandidateSoFar);
                }
                refCandidateSoFar = mostCircular;
            }
        }

        // Concurrency control
        const MAX_IN_FLIGHT = numWorkers * 3;
        let inFlight = 0;
        const waitQueue = [];

        function releaseSlot() {
            inFlight--;
            if (waitQueue.length > 0) {
                waitQueue.shift()();
            }
        }

        async function acquireSlot() {
            if (inFlight < MAX_IN_FLIGHT) {
                inFlight++;
                return;
            }
            await new Promise(resolve => waitQueue.push(resolve));
            inFlight++;
        }

        let globalFrameIndex = 0;
        let completedFrames = 0;
        let successfulFrames = 0;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;
        let totalErrors = 0;
        const maxErrorsBeforeStopDispatching = 20;
        let stopDispatching = false;

        const workerPromises = [];

        // Process each file
        for (let fileIndex = 0; fileIndex < fileInfos.length; fileIndex++) {
            if (stopDispatching) break;

            const { file, header, frameSize, frameCount, filename } = fileInfos[fileIndex];

            // Calculate how many frames to take from this file (proportional to global limit)
            let framesToProcessFromFile = frameCount;
            if (maxFrames > 0) {
                const proportion = frameCount / totalFramesAvailable;
                framesToProcessFromFile = Math.ceil(proportion * totalFramesToProcess);
            }

            addLog(`Processing ${filename}: ${framesToProcessFromFile} frames`);

            const headerForWorker = {
                fileId: header.fileId,
                width: header.width,
                height: header.height,
                pixelDepth: header.pixelDepth,
                colorID: header.colorID
            };

            for (let i = 0; i < framesToProcessFromFile && i < frameCount; i++) {
                if (stopDispatching) break;

                const offset = 178 + (i * frameSize);
                if (offset + frameSize > file.size) {
                    addLog(`${filename}: Stopping at frame ${i} due to reaching end of file.`);
                    break;
                }

                await acquireSlot();

                const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();

                // Pick a worker that's not currently recycling
                let workerIndex = globalFrameIndex % numWorkers;
                let attempts = 0;
                while (recyclingWorkers.has(workerIndex) && attempts < numWorkers) {
                    workerIndex = (workerIndex + 1) % numWorkers;
                    attempts++;
                }
                // If all workers are recycling, wait a bit for one to finish
                if (attempts >= numWorkers) {
                    await new Promise(r => setTimeout(r, 100));
                }

                const currentGlobalIndex = globalFrameIndex;

                // Determine if this frame should capture pre-crop for comparison video
                const preCropSampleInterval = Math.max(1, Math.floor(totalFramesToProcess / 10));
                const shouldCapturePreCrop = cropRegion && (currentGlobalIndex % preCropSampleInterval === 0);

                const dataToWorker = {
                    type: cropRegion ? 'analyze-cropped' : 'ser',
                    frameBuffer: frameBuffer,
                    header: headerForWorker,
                    bayerChoice: bayerChoice,
                    cropRegion: cropRegion,
                    capturePreCrop: shouldCapturePreCrop,
                    index: currentGlobalIndex,
                    surfaceMode: surfaceMode
                };

                const promise = processFrameWithWorker(workerIndex, dataToWorker, [frameBuffer])
                    .then(result => {
                        if (result.skipped) {
                            if (result.reason === 'cut-off') {
                                cutOffFrames++;
                            } else if (result.reason === 'oversized') {
                                oversizedFrames++;
                            } else {
                                skippedFrames++;
                            }
                            completedFrames++;
                            return;
                        }

                        // Capture pre-crop frame if available (for comparison video)
                        if (result.preCropRgbaBuffer && result.preCropWidth && result.preCropHeight) {
                            capturePreCropFrame(result.preCropRgbaBuffer, result.preCropWidth, result.preCropHeight, result.index, totalFramesToProcess);
                        }

                        const currentFrame = {
                            sharpness: result.sharpness,
                            blob: result.pngBlob,
                            croppedBuffer: result.croppedBuffer,
                            float32Buffer: result.float32Buffer,
                            width: result.width,
                            height: result.height,
                            index: result.index,
                            sourceFile: filename,
                            subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                            circularity: result.circularity || 0
                        };

                        // Validate frame has valid blob and rank it (streaming)
                        if (currentFrame.blob && currentFrame.blob instanceof Blob && currentFrame.blob.size > 0) {
                            rankFrame(currentFrame);
                            successfulFrames++;
                        }

                        completedFrames++;

                        if (completedFrames % 50 === 0 || completedFrames === totalFramesToProcess) {
                            emit('update-loading', {
                                progress: (completedFrames / totalFramesToProcess) * 100,
                                current: completedFrames,
                                total: totalFramesToProcess
                            });
                            addLog(`Analyzed frame ${completedFrames}/${totalFramesToProcess} (file ${fileIndex + 1}/${fileInfos.length})`);

                            // Update preview with best frame so far
                            if (bestFrameSoFar) {
                                emit('best-frame-updated', bestFrameSoFar);
                            }
                            if (refCandidateSoFar) {
                                emit('ref-candidate-updated', refCandidateSoFar);
                            }
                        }
                    })
                    .catch(error => {
                        totalErrors++;
                        completedFrames++;
                        // Check for heap corruption and force immediate recycle
                        if (isHeapCorruptionError(error)) {
                            forceWorkerRecycle(workerIndex);
                        }
                        if (totalErrors <= 3) {
                            addLog(`Error processing frame ${currentGlobalIndex} from ${filename}: ${error}`);
                        } else if (totalErrors === 4) {
                            addLog(`Further frame errors suppressed...`);
                        }
                        if (totalErrors >= maxErrorsBeforeStopDispatching && !stopDispatching) {
                            stopDispatching = true;
                            addLog(`Too many errors (${totalErrors}), stopped dispatching new frames.`);
                        }
                    })
                    .finally(() => {
                        releaseSlot();
                    });

                workerPromises.push(promise);
                globalFrameIndex++;
            }
        }

        // Wait for all worker tasks to complete
        await Promise.all(workerPromises);

        // PHASE 6: Ranking already done via streaming rankFrame()
        // bestFramesForStacking already contains the best 30%

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} crop-failed`);
        if (totalErrors > 0) skipMsgs.push(`${totalErrors} errors`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';

        addLog(`Analyzed ${successfulFrames} frames across ${fileInfos.length} files. Selected best ${bestFramesForStacking.length} for stacking.${skippedMsg}`);

        // Log distribution of selected frames across files
        const fileDistribution = {};
        bestFramesForStacking.forEach(frame => {
            fileDistribution[frame.sourceFile] = (fileDistribution[frame.sourceFile] || 0) + 1;
        });
        addLog(`Frame distribution: ${Object.entries(fileDistribution).map(([file, count]) => `${file}: ${count}`).join(', ')}`);

        emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: globalFrameIndex, done: true });

        // PHASE 7: Stack or manual selection
        if (manualThreshold) {
            // Sort frames by sharpness for manual selection UI
            allAnalyzedFrames.sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allAnalyzedFrames.length} frames`);
            emit('quality-selection-ready', {
                frames: allAnalyzedFrames,
                workers: [], // GPU mode creates its own workers
                noiseRobustAlignment,
                useWebGPU: true
            });
            return;
        } else {
            // Client-side stacking (always on)
            emit('set-caption', 'Stacking frames locally...');
            addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

            const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, noiseRobustAlignment, true, null, surfaceMode);

            if (stackResult && stackResult.blob) {
                addLog('Client-side stacking complete');
                emit('stacked-image-ready', {
                    blob: stackResult.blob,
                    float32Data: stackResult.float32Data,
                    width: stackResult.width,
                    height: stackResult.height
                });
            } else {
                addLog('Client-side stacking failed - no valid frames');
                emit('stack-failed', { component: 'useSerReader', reason: 'no valid frames' });
                emit('stop-loading');
            }
        }

        // Terminate workers after all tasks are done (CPU mode only)
        if (unifiedAnalyzeWorkers.length > 0) {
            unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
        pendingFrames.clear();
        workersReady = false;
    }

    return { readSerFile, readSerFiles };
}
