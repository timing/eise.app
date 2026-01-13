
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';
import { useStacker } from '@/composables/useStacker';

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
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js'));
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
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    // Map of pending frame resolvers per worker: workerIndex -> { frameIndex -> {resolve, reject, timeout} }
    const pendingFrames = new Map();
    let framesSinceRecycle = 0;
    const RECYCLE_THRESHOLD = 800; // Recycle workers every N frames to prevent WASM heap exhaustion

    // Recycle workers to prevent WASM heap exhaustion on large files
    async function recycleWorkers() {
        // Wait for all pending frames to complete
        const allPending = [];
        for (const [workerIndex, frameMap] of pendingFrames) {
            for (const [frameIndex, pending] of frameMap) {
                allPending.push(new Promise(resolve => {
                    const originalResolve = pending.resolve;
                    const originalReject = pending.reject;
                    pending.resolve = (result) => { originalResolve(result); resolve(); };
                    pending.reject = (error) => { originalReject(error); resolve(); };
                }));
            }
        }
        if (allPending.length > 0) {
            await Promise.all(allPending);
        }

        // Terminate old workers
        unifiedAnalyzeWorkers.forEach(w => w.terminate());
        unifiedAnalyzeWorkers.length = 0;
        pendingFrames.clear();

        // Create fresh workers
        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js'));
        }

        // Wait for them to initialize
        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Worker ${i} recycling timed out.`)), 30000);
                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        resolve();
                    }
                };
                worker.onerror = (e) => {
                    clearTimeout(timeout);
                    reject(e);
                };
                worker.postMessage({ type: 'init' });
            });
        });

        await Promise.all(workerPromises);
        setupWorkerHandlers();
        framesSinceRecycle = 0;
        addLog('Workers recycled to prevent memory exhaustion');
    }

    // Set up single message handler per worker (call after workers are created)
    function setupWorkerHandlers() {
        unifiedAnalyzeWorkers.forEach((worker, workerIndex) => {
            pendingFrames.set(workerIndex, new Map());

            worker.addEventListener('message', (e) => {
                const frameIndex = e.data.index;
                const pending = pendingFrames.get(workerIndex)?.get(frameIndex);
                if (!pending) return; // Not a frame message or already handled

                clearTimeout(pending.timeout);
                pendingFrames.get(workerIndex).delete(frameIndex);

                if (e.data.error) {
                    pending.reject(e.data.error);
                } else if (e.data.type === 'bounds') {
                    pending.resolve({ type: 'bounds', bounds: e.data.bounds, index: e.data.index });
                } else if (e.data.skipped) {
                    pending.resolve({ skipped: true, reason: e.data.reason, index: e.data.index });
                } else {
                    pending.resolve({
                        sharpness: e.data.sharpness,
                        pngBlob: e.data.pngBlob,
                        croppedBuffer: e.data.croppedBuffer,
                        rgbaBuffer: e.data.rgbaBuffer,
                        width: e.data.width,
                        height: e.data.height,
                        index: e.data.index,
                        subPixelOffset: e.data.subPixelOffset,
                        circularity: e.data.circularity || 0
                    });
                }
            });
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
                frameBuffer: frameBuffer,  // Transfer directly, no copy needed
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

        // Add margin to the max size and round up to even number
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        let finalSize = Math.ceil(maxSize * marginMultiplier / 2) * 2;

        // Limit crop size to frame dimensions
        const maxAllowedSize = Math.min(header.width, header.height);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        // Calculate median center as fallback reference
        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);
            return { size: finalSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        // Calculate median size for outlier detection (reject doubled/smeared frames)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    async function readSerFile(file, maxFrames = -1, enableAutoCrop = false, clientSideStacking = false, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping SER processing due to worker initialization failure.");
            emit('show-error');
            return;
        }

        emit('start-loading', 'Reading file header');
        emit('update-loading', 0); // Initial progress

        const headerBuf = await file.slice(0, 178).arrayBuffer();
        const header = parseSerHeader(headerBuf);

        // Calculate bytes per pixel and frame size
        const bpp = header.pixelDepth > 8 ? 2 : 1;
        const frameSize = header.width * header.height * bpp;

        // Validate header against actual file size
        const expectedFileSize = 178 + (frameSize * header.frameCount);
        const actualFrameCount = Math.floor((file.size - 178) / frameSize);

        addLog(`SER Header: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit, colorID=${header.colorID}`);

        // Use calculated frame count if header value seems wrong
        if (actualFrameCount !== header.frameCount) {
            addLog(`Warning: Header says ${header.frameCount} frames, but file size suggests ${actualFrameCount} frames. Using calculated value.`);
            header.frameCount = actualFrameCount;
        }

        // Determine initial bayer choice from header for auto-detection hint
        // Using BGR output variants because we later convert BGR->RGBA
        const bayerMap = { 0: "MONO", 8: "COLOR_BayerBG2RGB", 9: "COLOR_BayerGB2RGB", 10: "COLOR_BayerGR2RGB", 11: "COLOR_BayerRG2RGB" };
        let autoDetectedProfile = bayerMap[header.colorID];
        if (!autoDetectedProfile) {
            autoDetectedProfile = "COLOR_BayerRG2BGR";
        }

        // Read first frame for color profile selector
        const firstFrameBuffer = await file.slice(178, 178 + frameSize).arrayBuffer();

        // Try to crop the first frame for better preview in color selector
        // Use MONO mode for bounds detection (works on raw luminance)
        let previewBuffer = firstFrameBuffer;
        let previewHeader = header;
        const MIN_SIZE_FOR_CROP = 300;

        if (enableAutoCrop && header.width >= MIN_SIZE_FOR_CROP && header.height >= MIN_SIZE_FOR_CROP) {
            emit('set-caption', 'Detecting planet for preview...');
            try {
                const headerForWorker = {
                    fileId: header.fileId,
                    width: header.width,
                    height: header.height,
                    pixelDepth: header.pixelDepth,
                    colorID: header.colorID
                };
                // Need a copy since we transfer the buffer
                const bufferCopy = firstFrameBuffer.slice(0);
                const boundsResult = await processFrameWithWorker(0, {
                    type: 'detect-bounds',
                    frameBuffer: bufferCopy,
                    header: headerForWorker,
                    bayerChoice: 'MONO',
                    index: 0
                }, [bufferCopy]);

                if (boundsResult.bounds && boundsResult.bounds.canCrop) {
                    const { centerX, centerY, size } = boundsResult.bounds;
                    const previewMargin = 1 + (cropMarginPercent / 100);
                    const cropSize = Math.ceil(size * previewMargin / 2) * 2;
                    const maxCropSize = Math.min(header.width, header.height);

                    if (cropSize < maxCropSize) {
                        // Crop the raw buffer for preview
                        const bpp = header.pixelDepth > 8 ? 2 : 1;
                        const halfSize = Math.floor(cropSize / 2);
                        // Ensure even start coordinates to preserve Bayer pattern alignment
                        let startX = Math.max(0, Math.min(header.width - cropSize, Math.round(centerX) - halfSize));
                        let startY = Math.max(0, Math.min(header.height - cropSize, Math.round(centerY) - halfSize));
                        startX = Math.floor(startX / 2) * 2;
                        startY = Math.floor(startY / 2) * 2;

                        const croppedBuffer = new ArrayBuffer(cropSize * cropSize * bpp);
                        const srcView = header.pixelDepth > 8 ? new Uint16Array(firstFrameBuffer) : new Uint8Array(firstFrameBuffer);
                        const dstView = header.pixelDepth > 8 ? new Uint16Array(croppedBuffer) : new Uint8Array(croppedBuffer);

                        for (let y = 0; y < cropSize; y++) {
                            const srcOffset = (startY + y) * header.width + startX;
                            const dstOffset = y * cropSize;
                            dstView.set(srcView.subarray(srcOffset, srcOffset + cropSize), dstOffset);
                        }

                        previewBuffer = croppedBuffer;
                        previewHeader = { ...header, width: cropSize, height: cropSize };
                        addLog(`Cropped preview to ${cropSize}x${cropSize} for color selector`);
                    }
                }
            } catch (error) {
                addLog(`Could not crop preview: ${error.message}`);
                // Fall back to uncropped preview
            }
        }

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
        // MIN_SIZE_FOR_CROP already defined above for preview cropping
        let cropRegion = null;
        let croppedFrameBuffers = []; // Store cropped raw data for SER export

        if (enableAutoCrop && header.width >= MIN_SIZE_FOR_CROP && header.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${header.width}x${header.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegion(file, header, frameSize, frameCount, bayerChoice, cropMarginPercent);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop) {
            addLog(`Frame size ${header.width}x${header.height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = []; // These will store {sharpness, blob, croppedBuffer}
        const allAnalyzedFrames = []; // Keep all frames when manual threshold is enabled
        let bestFrameSoFar = null; // Best frame found so far (for preview)
        let refCandidateSoFar = null; // Most circular from top frames (for preview)

        function rankFrame(frame) {
            // Validate frame has valid blob
            if (!frame.blob || !(frame.blob instanceof Blob) || frame.blob.size === 0) {
                console.warn(`Skipping frame ${frame.index}: invalid blob (type=${frame.blob?.constructor?.name}, size=${frame.blob?.size})`);
                return;
            }

            // Keep all frames when manual threshold is enabled
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Update best frame for preview
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            // Keep track of best frames for stacking (still needed for non-manual mode)
            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
                    (currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    bestFramesForStacking[minSharpnessIndex] = frame;
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

            if (!refCandidateSoFar || mostCircular.blob !== refCandidateSoFar.blob) {
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

        for (let i = 0; i < frameCount; i++) {
            if (stopDispatching) {
                break;
            }
            const offset = 178 + (i * frameSize);
            if (offset + frameSize > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            // Recycle workers periodically to prevent WASM heap exhaustion
            if (framesSinceRecycle >= RECYCLE_THRESHOLD) {
                await recycleWorkers();
            }

            // Wait for a slot before reading the frame (limits memory usage)
            await acquireSlot();

            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
            const workerIndex = i % numWorkers;

            const dataToWorker = {
                type: cropRegion ? 'analyze-cropped' : 'ser',
                frameBuffer: frameBuffer,
                header: headerForWorker,
                bayerChoice: bayerChoice,
                cropRegion: cropRegion,
                clientSideStacking: clientSideStacking,
                index: i
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
                        if (completedFrames % 50 === 0) {
                            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                            emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: completedFrames });
                        }
                        return;
                    }

                    const currentFrame = {
                        sharpness: result.sharpness,
                        blob: result.pngBlob,
                        croppedBuffer: result.croppedBuffer,
                        rgbaBuffer: result.rgbaBuffer,
                        width: result.width,
                        height: result.height,
                        index: result.index,
                        subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                        circularity: result.circularity || 0
                    };

                    rankFrame(currentFrame);

                    if (result.croppedBuffer) {
                        croppedFrameBuffers[result.index] = result.croppedBuffer;
                    }

                    successfulFrames++;
                    completedFrames++;

                    if (completedFrames === 1) {
                        addLog(`First frame succeeded (index ${result.index}, sharpness ${result.sharpness?.toFixed(2)}, circularity ${result.circularity?.toFixed(2)})`);
                    }

                    if (completedFrames % 50 === 0 || completedFrames === frameCount) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                        addLog(`Analyzed frame ${completedFrames}/${frameCount}`);

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
                    if (totalErrors <= 3) {
                        addLog(`Error processing frame ${i}: ${error}`);
                    } else if (totalErrors === 4) {
                        addLog(`Further frame errors suppressed...`);
                    }
                    if (totalErrors >= maxErrorsBeforeStopDispatching && !stopDispatching) {
                        stopDispatching = true;
                        addLog(`Too many errors (${totalErrors}), stopped dispatching new frames. Waiting for remaining results...`);
                    }
                })
                .finally(() => {
                    releaseSlot();  // Always release slot when done
                });
            workerPromises.push(promise);
            framesSinceRecycle++;
        }

        // Wait for all worker tasks to complete
        await Promise.all(workerPromises);

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
                workers: unifiedAnalyzeWorkers // Pass workers for later stacking
            });
            // Don't terminate workers yet - they'll be used for stacking after selection
            return;
        } else if (clientSideStacking) {
            // Client-side stacking: use one of the existing workers (before terminating them)
            emit('set-caption', 'Stacking frames locally...');
            addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

            // Emit for debug frame access
            emit('debug-frames-available', { frames: bestFramesForStacking });

            // Use the first worker for stacking (it's already initialized with OpenCV)
            const stackingWorker = unifiedAnalyzeWorkers[0];
            const stackedBlob = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale);

            if (stackedBlob) {
                addLog('Client-side stacking complete');
                emit('stacked-image-ready', { blob: stackedBlob });
            } else {
                addLog('Client-side stacking failed - no valid frames');
                emit('stop-loading');
            }
        } else {
            // Server-side stacking: upload PNGs
            emit('set-caption', 'Uploading best frames for stacking...');

            // Blobs are already available from worker processing, no need to re-render
            const pngBlobs = bestFramesForStacking.map(f => ({ pngFile: [f.blob] }));

            await uploadFrames(pngBlobs);
        }

        // Terminate workers after all tasks are done (including stacking)
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
        unifiedAnalyzeWorkers.length = 0;
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

        const marginMultiplier = 1 + (cropMarginPercent / 100);
        let finalSize = Math.ceil(maxSize * marginMultiplier / 2) * 2;

        // Use the smallest frame dimensions across all files as limit
        const maxAllowedSize = Math.min(...fileInfos.map(info => Math.min(info.header.width, info.header.height)));
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds smallest frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${actualSamples} frames croppable)`);
            return { size: finalSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${actualSamples} frames croppable across ${fileInfos.length} files)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Process multiple SER files and combine their frames for stacking
    // NOTE: Future consideration - similar multi-file support could be added to useAviReader.js
    async function readSerFiles(files, maxFrames = -1, enableAutoCrop = false, clientSideStacking = false, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping SER processing due to worker initialization failure.");
            emit('show-error');
            return;
        }

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
        const bayerMap = { 0: "MONO", 8: "COLOR_BayerBG2RGB", 9: "COLOR_BayerGB2RGB", 10: "COLOR_BayerGR2RGB", 11: "COLOR_BayerRG2RGB" };
        let autoDetectedProfile = bayerMap[firstHeader.colorID] || "COLOR_BayerRG2BGR";

        const firstFrameBuffer = await fileInfos[0].file.slice(178, 178 + firstFrameSize).arrayBuffer();

        // Try to crop the first frame for better preview in color selector
        let previewBuffer = firstFrameBuffer;
        let previewHeader = firstHeader;
        const MIN_SIZE_FOR_CROP = 300;

        if (enableAutoCrop && firstHeader.width >= MIN_SIZE_FOR_CROP && firstHeader.height >= MIN_SIZE_FOR_CROP) {
            emit('set-caption', 'Detecting planet for preview...');
            try {
                const headerForWorker = {
                    fileId: firstHeader.fileId,
                    width: firstHeader.width,
                    height: firstHeader.height,
                    pixelDepth: firstHeader.pixelDepth,
                    colorID: firstHeader.colorID
                };
                const bufferCopy = firstFrameBuffer.slice(0);
                const boundsResult = await processFrameWithWorker(0, {
                    type: 'detect-bounds',
                    frameBuffer: bufferCopy,
                    header: headerForWorker,
                    bayerChoice: 'MONO',
                    index: 0
                }, [bufferCopy]);

                if (boundsResult.bounds && boundsResult.bounds.canCrop) {
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

        if (enableAutoCrop && allQualifyForCrop) {
            addLog(`All files qualify for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
            cropRegion = await detectCropRegionMultiFile(fileInfos, bayerChoice, cropMarginPercent);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop) {
            addLog(`Some files too small for auto-crop, skipping crop detection`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        // PHASE 5: Analyze all frames from all files
        // Use streaming ranking - only keep best N% in memory to avoid crashes
        const bestFramesCapacity = Math.max(1, Math.floor(totalFramesToProcess * stackPercentage / 100));
        const bestFramesForStacking = [];
        const allAnalyzedFrames = []; // Only used when manualThreshold is true
        let bestFrameSoFar = null;
        let refCandidateSoFar = null;

        // Streaming rank function - keeps only top N frames in memory
        function rankFrame(frame) {
            // For manual threshold, we need all frames (may still crash on large sets)
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Track best frame for preview
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            // Streaming top-N: only keep best frames
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
                    bestFramesForStacking[minSharpnessIndex] = frame;
                }
                // Otherwise frame is discarded (not kept in memory)
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

            if (!refCandidateSoFar || mostCircular.blob !== refCandidateSoFar.blob) {
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

                // Recycle workers periodically to prevent WASM heap exhaustion
                if (framesSinceRecycle >= RECYCLE_THRESHOLD) {
                    await recycleWorkers();
                }

                await acquireSlot();

                const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                const workerIndex = globalFrameIndex % numWorkers;
                const currentGlobalIndex = globalFrameIndex;

                const dataToWorker = {
                    type: cropRegion ? 'analyze-cropped' : 'ser',
                    frameBuffer: frameBuffer,
                    header: headerForWorker,
                    bayerChoice: bayerChoice,
                    cropRegion: cropRegion,
                    clientSideStacking: clientSideStacking,
                    index: currentGlobalIndex
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

                        const currentFrame = {
                            sharpness: result.sharpness,
                            blob: result.pngBlob,
                            croppedBuffer: result.croppedBuffer,
                            rgbaBuffer: result.rgbaBuffer,
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
                framesSinceRecycle++;
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
                workers: unifiedAnalyzeWorkers
            });
            return;
        } else if (clientSideStacking) {
            emit('set-caption', 'Stacking frames locally...');
            addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

            const stackingWorker = unifiedAnalyzeWorkers[0];
            const stackedBlob = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale);

            if (stackedBlob) {
                addLog('Client-side stacking complete');
                emit('stacked-image-ready', { blob: stackedBlob });
            } else {
                addLog('Client-side stacking failed - no valid frames');
                emit('stop-loading');
            }
        }

        // Terminate workers after all tasks are done
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
        unifiedAnalyzeWorkers.length = 0;
        pendingFrames.clear();
        workersReady = false;
    }

    return { readSerFile, readSerFiles };
}
