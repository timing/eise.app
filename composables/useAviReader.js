// composables/useAviReader.js

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useLiteMemoryLimits } from '@/composables/useLiteMemoryLimits';

/**
 * Determines if an AVI FourCC represents an "easy" (uncompressed/raw) format.
 * @param {string} fourCC The FourCC code.
 * @returns {boolean} True if easy, false otherwise.
 */
function isEasyAviFourCC(fourCC) {
    if (!fourCC) return false;
    // Null fourCC (\0\0\0\0) is used by FFmpeg rawvideo for uncompressed BGR - treat as DIB
    if (fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00') return true;
    const easyFourCCs = ['DIB ', 'Y800', 'YUY2', 'UYVY', 'RGB ', 'RAW ']; // 'RGB ' and 'RAW ' are sometimes used
    return easyFourCCs.includes(fourCC.toUpperCase());
}

/**
 * Check if FourCC is MJPEG (Motion JPEG)
 */
function isMjpegFourCC(fourCC) {
    if (!fourCC) return false;
    return fourCC.toUpperCase() === 'MJPG';
}

/**
 * Flip a raw frame buffer vertically (for DIB bottom-up storage)
 * @param {ArrayBuffer|Uint8Array} buffer - Raw frame data
 * @param {number} width - Frame width in pixels
 * @param {number} height - Frame height in pixels
 * @param {number} bytesPerPixel - Bytes per pixel (1 for 8-bit, 2 for 16-bit)
 * @returns {Uint8Array} - Flipped frame data
 */
function flipFrameVertically(buffer, width, height, bytesPerPixel = 1) {
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dst = new Uint8Array(src.length);
    const rowBytes = width * bytesPerPixel;

    for (let y = 0; y < height; y++) {
        const srcOffset = y * rowBytes;
        const dstOffset = (height - 1 - y) * rowBytes;
        dst.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }

    return dst;
}

/**
 * Parse AVI frame index from movi list - builds array of {offset, size} for each video frame
 * Scans chunk headers to find actual video frames, skipping audio and other chunks.
 * Works for all AVI formats (MJPEG, DIB, Y800, etc.) - not just variable-size formats.
 */
async function parseAviFrameIndex(file, moviListOffset, moviListSize, maxFrames = -1) {
    const frameIndex = [];
    const chunkHeaderSize = 8; // 4 bytes FourCC + 4 bytes size
    const fileSize = file.size;

    // For large AVI files with AVIX extension, scan entire file instead of just first movi chunk
    // This handles OpenDML/AVI 2.0 files that split data across multiple RIFF chunks
    const scanWholeFile = fileSize > moviListOffset + moviListSize + 1024;

    let position = moviListOffset;
    const scanEnd = scanWholeFile ? fileSize : moviListOffset + moviListSize;

    // Log scan range for debugging large file issues
    if (scanWholeFile) {
        console.log(`Frame scanner: scanning entire file (${(fileSize / 1024 / 1024).toFixed(0)}MB)`);
    }

    while (position < scanEnd - chunkHeaderSize) {
        if (maxFrames > 0 && frameIndex.length >= maxFrames) break;

        // Read chunk header
        const headerSlice = await file.slice(position, position + chunkHeaderSize).arrayBuffer();
        const headerView = new DataView(headerSlice);

        const chunkId = String.fromCharCode(
            headerView.getUint8(0),
            headerView.getUint8(1),
            headerView.getUint8(2),
            headerView.getUint8(3)
        );
        const chunkSize = headerView.getUint32(4, true);

        // Sanity check chunk size
        if (chunkSize > fileSize - position || chunkSize > 100 * 1024 * 1024) {
            // Invalid chunk size - might be RIFF/LIST header, skip 4 bytes and retry
            if (chunkId === 'RIFF' || chunkId === 'LIST') {
                // Skip RIFF/LIST type field (4 bytes after size)
                position += 12;
                continue;
            }
            // Unknown large chunk, skip to next position
            position += 4;
            continue;
        }

        // Video chunks are typically '00dc', '01dc', etc. (d=compressed video)
        // or '00db', '01db' (d=uncompressed video)
        if (chunkId.match(/^\d\ddc$/i) || chunkId.match(/^\d\ddb$/i)) {
            frameIndex.push({
                offset: position + chunkHeaderSize,
                size: chunkSize
            });
        }

        // Move to next chunk (size is padded to word boundary)
        const paddedSize = (chunkSize + 1) & ~1;
        position += chunkHeaderSize + paddedSize;

        // Log progress every 5000 frames
        if (frameIndex.length % 5000 === 0 && frameIndex.length > 0) {
            console.log(`Frame scanner: ${frameIndex.length} frames found...`);
        }
    }

    return frameIndex;
}


// Convert raw AVI frame data to RGBA for canvas display - no OpenCV needed
// Supports DIB (BGR24), Y800 (grayscale/Bayer), YUY2/UYVY
async function renderAviFrameToBlob(canvas, frameDataBuffer, aviHeader, fourCC, bayerChoice) {
    const { width, height, bpp } = aviHeader;
    const src = new Uint8Array(frameDataBuffer);
    const rgba = new Uint8ClampedArray(width * height * 4);

    // Null fourCC from FFmpeg rawvideo is also uncompressed BGR
    const isUncompressedBGR = fourCC === 'DIB ' || fourCC === 'RGB ' || fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00' || !fourCC;

    // Check for 8-bit DIB (raw Bayer or grayscale) - same handling as Y800
    const is8bitRaw = (fourCC === 'Y800') || (isUncompressedBGR && bpp === 8);

    if (is8bitRaw) {
        if (bayerChoice && bayerChoice !== "MONO") {
            // Bayer demosaic - simple bilinear for preview (fast, good enough for preview)
            demosaicBayerToRgba(src, rgba, width, height, bayerChoice);
        } else {
            // Grayscale → RGBA
            for (let i = 0, j = 0; i < src.length; i++, j += 4) {
                rgba[j] = rgba[j + 1] = rgba[j + 2] = src[i];
                rgba[j + 3] = 255;
            }
        }
    } else if (isUncompressedBGR) {
        // BGR24 → RGBA (swap B and R)
        for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
            rgba[j] = src[i + 2];     // R ← B
            rgba[j + 1] = src[i + 1]; // G
            rgba[j + 2] = src[i];     // B ← R
            rgba[j + 3] = 255;        // A
        }
    } else if (fourCC === 'YUY2') {
        // YUY2 (YUYV) → RGBA: Y0 U Y1 V pattern
        for (let i = 0, j = 0; i < src.length; i += 4, j += 8) {
            const y0 = src[i], u = src[i + 1], y1 = src[i + 2], v = src[i + 3];
            yuvToRgba(y0, u, v, rgba, j);
            yuvToRgba(y1, u, v, rgba, j + 4);
        }
    } else if (fourCC === 'UYVY') {
        // UYVY → RGBA: U Y0 V Y1 pattern
        for (let i = 0, j = 0; i < src.length; i += 4, j += 8) {
            const u = src[i], y0 = src[i + 1], v = src[i + 2], y1 = src[i + 3];
            yuvToRgba(y0, u, v, rgba, j);
            yuvToRgba(y1, u, v, rgba, j + 4);
        }
    } else {
        console.error(`Unsupported FourCC for direct AVI rendering: ${fourCC}`);
        return null;
    }

    // Auto-stretch (normalize to 0-255 range)
    autoStretchRgba(rgba);

    // Render to canvas
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(rgba, width, height);
    ctx.putImageData(imageData, 0, 0);

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// YUV to RGBA conversion (BT.601)
function yuvToRgba(y, u, v, rgba, offset) {
    const c = y - 16;
    const d = u - 128;
    const e = v - 128;
    rgba[offset] = Math.max(0, Math.min(255, (298 * c + 409 * e + 128) >> 8));           // R
    rgba[offset + 1] = Math.max(0, Math.min(255, (298 * c - 100 * d - 208 * e + 128) >> 8)); // G
    rgba[offset + 2] = Math.max(0, Math.min(255, (298 * c + 516 * d + 128) >> 8));       // B
    rgba[offset + 3] = 255; // A
}

// Simple bilinear Bayer demosaic for preview
function demosaicBayerToRgba(src, rgba, width, height, bayerChoice) {
    // OpenCV uses inverted naming (see CLAUDE.md):
    // COLOR_BayerBG2RGB = Industry RGGB
    // COLOR_BayerRG2RGB = Industry BGGR
    // COLOR_BayerGB2RGB = Industry GRBG
    // COLOR_BayerGR2RGB = Industry GBRG
    const pattern = bayerChoice.includes('BG') ? 'RGGB' :
                    bayerChoice.includes('RG') ? 'BGGR' :
                    bayerChoice.includes('GB') ? 'GRBG' :
                    bayerChoice.includes('GR') ? 'GBRG' : 'RGGB';

    // For each pixel, determine what color it is and interpolate the others
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const j = i * 4;
            const raw = src[i];

            // Determine position in 2x2 Bayer pattern
            const px = x % 2, py = y % 2;
            let r, g, b;

            // Get neighboring pixels (clamped to edges)
            const getPixel = (dx, dy) => {
                const nx = Math.max(0, Math.min(width - 1, x + dx));
                const ny = Math.max(0, Math.min(height - 1, y + dy));
                return src[ny * width + nx];
            };

            if (pattern === 'RGGB') {
                if (px === 0 && py === 0) { // R
                    r = raw;
                    g = (getPixel(1, 0) + getPixel(0, 1)) >> 1;
                    b = getPixel(1, 1);
                } else if (px === 1 && py === 1) { // B
                    r = getPixel(-1, -1);
                    g = (getPixel(-1, 0) + getPixel(0, -1)) >> 1;
                    b = raw;
                } else if (px === 1 && py === 0) { // G (R row)
                    r = getPixel(-1, 0);
                    g = raw;
                    b = getPixel(0, 1);
                } else { // G (B row)
                    r = getPixel(0, -1);
                    g = raw;
                    b = getPixel(1, 0);
                }
            } else if (pattern === 'BGGR') {
                if (px === 0 && py === 0) { // B
                    b = raw;
                    g = (getPixel(1, 0) + getPixel(0, 1)) >> 1;
                    r = getPixel(1, 1);
                } else if (px === 1 && py === 1) { // R
                    b = getPixel(-1, -1);
                    g = (getPixel(-1, 0) + getPixel(0, -1)) >> 1;
                    r = raw;
                } else if (px === 1 && py === 0) { // G (B row)
                    b = getPixel(-1, 0);
                    g = raw;
                    r = getPixel(0, 1);
                } else { // G (R row)
                    b = getPixel(0, -1);
                    g = raw;
                    r = getPixel(1, 0);
                }
            } else if (pattern === 'GBRG') {
                if (px === 0 && py === 0) { // G (B row)
                    b = getPixel(1, 0);
                    g = raw;
                    r = getPixel(0, 1);
                } else if (px === 1 && py === 1) { // G (R row)
                    b = getPixel(0, -1);
                    g = raw;
                    r = getPixel(-1, 0);
                } else if (px === 1 && py === 0) { // B
                    b = raw;
                    g = (getPixel(-1, 0) + getPixel(0, 1)) >> 1;
                    r = getPixel(-1, 1);
                } else { // R
                    b = getPixel(1, -1);
                    g = (getPixel(1, 0) + getPixel(0, -1)) >> 1;
                    r = raw;
                }
            } else { // GRBG
                if (px === 0 && py === 0) { // G (R row)
                    r = getPixel(1, 0);
                    g = raw;
                    b = getPixel(0, 1);
                } else if (px === 1 && py === 1) { // G (B row)
                    r = getPixel(0, -1);
                    g = raw;
                    b = getPixel(-1, 0);
                } else if (px === 1 && py === 0) { // R
                    r = raw;
                    g = (getPixel(-1, 0) + getPixel(0, 1)) >> 1;
                    b = getPixel(-1, 1);
                } else { // B
                    r = getPixel(1, -1);
                    g = (getPixel(1, 0) + getPixel(0, -1)) >> 1;
                    b = raw;
                }
            }

            rgba[j] = r;
            rgba[j + 1] = g;
            rgba[j + 2] = b;
            rgba[j + 3] = 255;
        }
    }
}

// Auto-stretch RGBA to use full 0-255 range
function autoStretchRgba(rgba) {
    let min = 255, max = 0;
    // Find min/max across RGB (skip alpha)
    for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = rgba[i + c];
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    if (max <= min) return; // No stretch needed
    const scale = 255 / (max - min);
    for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            rgba[i + c] = Math.round((rgba[i + c] - min) * scale);
        }
    }
}

export function useAviReader() {
    const { addLog, emit } = useEventBus();
    const { stackFramesLocally } = useStacker();
    const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();

    const previewCanvas = document.createElement('canvas');

    // Limit workers to prevent OpenCV WASM memory exhaustion
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;
    const recyclingWorkers = new Set(); // Track which workers are currently being recycled

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
            workersReady = true;
            addLog("Analysis workers ready.");
        } catch (error) {
            console.error("Worker initialization failed:", error);
            reportError(error, { component: 'useAviReader', action: 'initializeWorkers' });
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            // Handle cleanup of created workers if necessary
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    // Recycle all workers to get fresh WASM heaps (used on error recovery)
    async function recycleWorkers() {
        addLog("Recycling workers to free WASM memory...");

        // Terminate all existing workers
        unifiedAnalyzeWorkers.forEach(w => w.terminate());
        unifiedAnalyzeWorkers.length = 0;
        workersReady = false;

        // Create fresh workers
        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
        }

        // Wait for them to initialize
        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Worker ${i} recycle init timed out.`)), 30000);
                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        resolve();
                    } else if (e.data.type === 'error') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        reject(new Error(e.data.message || 'Worker recycle error'));
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
        workersReady = true;
        addLog("Workers recycled successfully.");
    }

    // Recycle a single worker on error (other workers keep running)
    async function recycleSingleWorker(workerIndex) {
        if (recyclingWorkers.has(workerIndex)) return;
        recyclingWorkers.add(workerIndex);

        // Terminate old worker
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

        recyclingWorkers.delete(workerIndex);
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

    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                reject(new Error(`Worker timeout for frame ${data.index}`));
            }, 30000); // 30 second timeout per frame

            const messageHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                if (e.data.error) {
                    reject(e.data.error);
                } else if (e.data.type === 'bounds') {
                    resolve({ type: 'bounds', bounds: e.data.bounds, index: e.data.index });
                } else if (e.data.skipped) {
                    // Frame was skipped (e.g., couldn't crop)
                    resolve({ skipped: true, reason: e.data.reason, index: e.data.index });
                } else {
                    // Worker now returns sharpness and the processed pngBlob
                    resolve({
                        sharpness: e.data.sharpness,
                        pngBlob: e.data.pngBlob,
                        uint8Buffer: e.data.uint8Buffer,        // GPU path
                        float32Buffer: e.data.float32Buffer,    // CPU fallback path
                        width: e.data.width,
                        height: e.data.height,
                        index: e.data.index,
                        circularity: e.data.circularity || 0
                    });
                }
            };
            const errorHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('error', errorHandler);
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            worker.postMessage(data, transferables);
        });
    }

    // Detect bounds for a sample of frames to determine crop region
    async function detectCropRegion(file, aviHeader, frameCount, cropMarginPercent = 10, frameIndex = null) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50)); // ~50 samples max
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        // Concurrency control for bounds detection
        const MAX_IN_FLIGHT = numWorkers * 2;
        let inFlight = 0;
        const waitQueue = [];

        function releaseSlot() {
            inFlight--;
            if (waitQueue.length > 0) waitQueue.shift()();
        }

        async function acquireSlot() {
            if (inFlight < MAX_IN_FLIGHT) { inFlight++; return; }
            await new Promise(resolve => waitQueue.push(resolve));
            inFlight++;
        }

        let maxSize = 0;
        let canCropCount = 0;
        const boundsPromises = [];
        const detectedCenters = []; // Collect center positions for stable reference
        const detectedSizes = []; // Collect sizes to calculate median for outlier detection

        const headerForWorker = {
            width: aviHeader.width,
            height: aviHeader.height,
            fourCC: aviHeader.fourCC,
            bpp: aviHeader.bpp
        };

        const frameChunkHeaderSize = 8;
        const frameDataLength = aviHeader.frameDataSize;

        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];

            // Use frame index if available (handles interleaved audio chunks correctly)
            // Otherwise fall back to calculated offset (legacy behavior)
            let frameDataStart, actualFrameSize;
            if (frameIndex && frameIndex[i]) {
                frameDataStart = frameIndex[i].offset;
                actualFrameSize = frameIndex[i].size;
            } else {
                const frameOffset = aviHeader.moviListOffset + i * (frameChunkHeaderSize + frameDataLength + (frameDataLength % 2));
                frameDataStart = frameOffset + frameChunkHeaderSize;
                actualFrameSize = frameDataLength;
            }

            if (frameDataStart + actualFrameSize > file.size) break;

            await acquireSlot();

            let frameBuffer;
            try {
                frameBuffer = await file.slice(frameDataStart, frameDataStart + actualFrameSize).arrayBuffer();
            } catch (readError) {
                releaseSlot();
                console.error(`Crop detection: File read error at sample ${idx} (frame ${i}):`, readError);
                continue; // Skip this sample
            }
            const workerIndex = idx % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];
            if (!worker) {
                releaseSlot();
                console.error(`No worker available at index ${workerIndex}`);
                continue;
            }

            const dataToWorker = {
                type: 'detect-bounds',
                frameBuffer: frameBuffer,
                header: headerForWorker,
                bayerChoice: aviHeader.bayerChoice,
                index: idx
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [frameBuffer])
                .then(result => {
                    if (result.bounds && result.bounds.canCrop) {
                        canCropCount++;
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
                })
                .finally(() => releaseSlot());

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
        const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0;

        // Use median size with margin, capped at frame dimensions
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(aviHeader.width, aviHeader.height);
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds frame size ${maxAllowedSize}, clamping`);
        }

        // Calculate median center position as fallback reference
        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, margin: ${cropMarginPercent}% (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Robust AVI header parser
    // actualFileSize is optional - used for sanity checking frame count
    async function parseFullAviHeader(buffer, actualFileSize = null) {
        const view = new DataView(buffer);
        const fileEnd = buffer.byteLength;

        // Safe read helpers with bounds checking
        const safeReadFourCC = (v, o) => {
            if (o < 0 || o + 4 > fileEnd) {
                throw new Error(`Cannot read FourCC at offset ${o} (buffer size: ${fileEnd})`);
            }
            return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
        };
        const safeGetUint32 = (v, o, littleEndian = true) => {
            if (o < 0 || o + 4 > fileEnd) {
                throw new Error(`Cannot read Uint32 at offset ${o} (buffer size: ${fileEnd})`);
            }
            return v.getUint32(o, littleEndian);
        };
        const safeGetInt32 = (v, o, littleEndian = true) => {
            if (o < 0 || o + 4 > fileEnd) {
                throw new Error(`Cannot read Int32 at offset ${o} (buffer size: ${fileEnd})`);
            }
            return v.getInt32(o, littleEndian);
        };
        const safeGetUint16 = (v, o, littleEndian = true) => {
            if (o < 0 || o + 2 > fileEnd) {
                throw new Error(`Cannot read Uint16 at offset ${o} (buffer size: ${fileEnd})`);
            }
            return v.getUint16(o, littleEndian);
        };

        addLog("Starting AVI header parsing...");

        try {
            // Minimum AVI file size check (RIFF header + AVI signature)
            if (fileEnd < 12) {
                addLog(`File too small to be valid AVI (${fileEnd} bytes)`);
                throw new Error('File too small to be a valid AVI file');
            }

            if (safeReadFourCC(view, 0) !== 'RIFF' || safeReadFourCC(view, 8) !== 'AVI ') {
                addLog("File is not a valid RIFF AVI file.");
                throw new Error('Not a valid AVI file');
            }
            addLog("File identified as RIFF AVI.");

            let offset = 12;

            let avihData = null;
            let strhData = null;
            let strfData = null;
            let strdData = null;
            let moviListOffset = -1;
            let moviListSize = -1;

            addLog("Scanning for RIFF chunks...");
            while (offset < fileEnd - 8) {
                // Bounds check before reading chunk header
                if (offset + 8 > fileEnd) {
                    addLog(`Reached end of file while scanning chunks at offset ${offset}`);
                    break;
                }
                const chunkId = safeReadFourCC(view, offset);
                let chunkSize = safeGetUint32(view, offset + 4, true);
                const chunkDataOffset = offset + 8;
                addLog(`Found chunk '${chunkId}' at offset ${offset} with size ${chunkSize}`);

                // Sanity check chunk size
                if (chunkSize > fileEnd - chunkDataOffset) {
                    addLog(`Chunk '${chunkId}' size ${chunkSize} exceeds remaining file size, truncating`);
                    chunkSize = fileEnd - chunkDataOffset;
                }

                if (chunkId === 'LIST') {
                    if (chunkDataOffset + 4 > fileEnd) break;
                    const listType = safeReadFourCC(view, chunkDataOffset);
                    addLog(`  - It's a LIST chunk with type '${listType}'`);
                    if (listType === 'hdrl') {
                        let hdrlOffset = chunkDataOffset + 4;
                        let videoStreamFound = false;
                        addLog("  - Parsing 'hdrl' list...");
                        while (hdrlOffset < chunkDataOffset + chunkSize - 4 && hdrlOffset + 8 <= fileEnd) {
                            const subChunkId = safeReadFourCC(view, hdrlOffset);
                            const subChunkSize = safeGetUint32(view, hdrlOffset + 4, true);
                            const subChunkPaddedSize = (subChunkSize + 1) & ~1;
                            addLog(`    - Found sub-chunk '${subChunkId}' of size ${subChunkSize}`);

                            if (subChunkId === 'avih') {
                                avihData = { offset: hdrlOffset + 8, size: subChunkSize };
                                addLog("      - Found 'avih' chunk.");
                            } else if (subChunkId === 'LIST' && hdrlOffset + 12 <= fileEnd && safeReadFourCC(view, hdrlOffset + 8) === 'strl') {
                                addLog("      - Found 'strl' list.");
                                if (!videoStreamFound) {
                                    let streamOffset = hdrlOffset + 12;
                                    while (streamOffset < hdrlOffset + 8 + subChunkSize && streamOffset + 8 <= fileEnd) {
                                        const streamChunkId = safeReadFourCC(view, streamOffset);
                                        const streamChunkSize = safeGetUint32(view, streamOffset + 4, true);
                                        const streamChunkPaddedSize = (streamChunkSize + 1) & ~1;

                                        addLog(`        - Found '${streamChunkId}' chunk (${streamChunkSize} bytes)`);
                                        if (streamChunkId === 'strh' && streamOffset + 12 <= fileEnd && safeReadFourCC(view, streamOffset + 8) === 'vids') {
                                            videoStreamFound = true;
                                            strhData = { offset: streamOffset + 8, size: streamChunkSize };
                                        } else if (streamChunkId === 'strf' && videoStreamFound && !strfData) {
                                            strfData = { offset: streamOffset + 8, size: streamChunkSize };
                                        } else if (streamChunkId === 'strd' && videoStreamFound) {
                                            // Stream data chunk - may contain Bayer pattern info
                                            strdData = { offset: streamOffset + 8, size: streamChunkSize };
                                        }
                                        streamOffset += 8 + streamChunkPaddedSize;
                                    }
                                }
                            }
                            hdrlOffset += 8 + subChunkPaddedSize;
                        }
                    } else if (listType === 'movi') {
                        moviListOffset = chunkDataOffset + 4;
                        moviListSize = chunkSize - 4;
                        addLog(`  - Found 'movi' list at offset ${moviListOffset}.`);
                    }
                }
                const chunkPaddedSize = (chunkSize + 1) & ~1;
                offset += 8 + chunkPaddedSize;
            }

            addLog("Finished scanning chunks. Verifying header data...");
            if (!avihData || !strhData || !strfData) {
                addLog(`Missing critical chunks: avih=${!!avihData}, strh=${!!strhData}, strf=${!!strfData}`);
                throw new Error("Missing critical AVI header chunks (avih, strh, or strf).");
            }
            addLog("All critical header chunks found.");

            // Verify chunk data is within bounds before reading
            if (avihData.offset + 20 > fileEnd) {
                throw new Error(`avih chunk data extends beyond file (offset ${avihData.offset}, file size ${fileEnd})`);
            }
            if (strhData.offset + 36 > fileEnd) {
                throw new Error(`strh chunk data extends beyond file (offset ${strhData.offset}, file size ${fileEnd})`);
            }
            if (strfData.offset + 20 > fileEnd) {
                throw new Error(`strf chunk data extends beyond file (offset ${strfData.offset}, file size ${fileEnd})`);
            }

            let frameCount = safeGetUint32(view, avihData.offset + 16, true);
            if (frameCount === 0) {
                frameCount = safeGetUint32(view, strhData.offset + 32, true); // Fallback to dwLength from stream header
                addLog(`Frame count from avih was 0, using count from strh: ${frameCount}`);
            }

            const width = safeGetUint32(view, strfData.offset + 4, true);
            const rawBiHeight = safeGetInt32(view, strfData.offset + 8, true);
            const height = Math.abs(rawBiHeight);
            const needsVerticalFlip = rawBiHeight > 0; // Positive biHeight = bottom-up storage
            addLog(`DIB biHeight: ${rawBiHeight} (${needsVerticalFlip ? 'bottom-up, will flip' : 'top-down, no flip'})`);
            const bpp = safeGetUint16(view, strfData.offset + 14, true);

            const compression = safeReadFourCC(view, strfData.offset + 16);
            const isCompressionNull = compression.charCodeAt(0) === 0 && compression.charCodeAt(1) === 0 && compression.charCodeAt(2) === 0 && compression.charCodeAt(3) === 0;
            let fourCC = isCompressionNull ? safeReadFourCC(view, strhData.offset + 4) : compression;
            addLog(`Determined FourCC: '${fourCC}' (compression: '${compression}', handler: '${safeReadFourCC(view, strhData.offset + 4)}')`);

            // Null fourCC is valid (FFmpeg rawvideo uses it)
            const hasValidFourCC = fourCC !== undefined;
            if (!width || !height || !frameCount || !hasValidFourCC || moviListOffset === -1) {
                addLog(`Incomplete header info: w=${width}, h=${height}, f=${frameCount}, fourCC='${fourCC}', movi=${moviListOffset}`);
                throw new Error(`Incomplete AVI header info`);
            }

            addLog("Header parsed successfully. Calculating frame data size...");
            let frameDataSize = 0;
            // Null fourCC from FFmpeg rawvideo is uncompressed BGR like DIB
            const isUncompressedBGR = fourCC === 'DIB ' || fourCC === 'RGB ' || fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00';
            if (isUncompressedBGR) {
                frameDataSize = width * height * (bpp / 8);
            } else if (fourCC === 'Y800') {
                frameDataSize = width * height;
            } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                frameDataSize = width * height * 2;
            } else {
                // Unsupported FourCC - return header anyway so caller can decide to fallback
                addLog(`FourCC '${fourCC}' is compressed/unsupported for direct rendering.`);
                frameDataSize = -1; // Signal that frame size is unknown
            }
            if (frameDataSize > 0) {
                addLog(`Calculated frameDataSize: ${frameDataSize}`);

                // Sanity check: estimate frame count from file size
                // Some capture software writes incorrect frameCount in header
                if (actualFileSize) {
                    const estimatedFrames = Math.floor((actualFileSize - moviListOffset) / frameDataSize);
                    if (frameCount <= 10 && estimatedFrames > 100) {
                        addLog(`Header frameCount=${frameCount} appears incorrect (file size suggests ~${estimatedFrames} frames). Will scan for actual count.`);
                    }
                }
            }

            let bayerChoice = "MONO";

            // Try to detect Bayer pattern from strd chunk
            if (!strdData) {
                addLog(`No strd chunk found in AVI header`);
            } else if (strdData.size === 0) {
                addLog(`Found strd chunk but it's empty`);
            }
            if (strdData && strdData.size > 0) {
                addLog(`Found strd chunk (${strdData.size} bytes), checking for Bayer pattern info...`);
                try {
                    // Read strd content as text to search for Bayer pattern strings
                    const strdBytes = new Uint8Array(buffer, strdData.offset, Math.min(strdData.size, 256));
                    const strdText = String.fromCharCode(...strdBytes);
                    addLog(`strd content (first 256 bytes): ${strdText.replace(/[^\x20-\x7E]/g, '.')}`);

                    // Search for common Bayer pattern identifiers
                    const strdUpper = strdText.toUpperCase();
                    if (strdUpper.includes('RGGB')) {
                        bayerChoice = 'COLOR_BayerBG2RGB'; // OpenCV inverted naming
                        addLog(`Detected RGGB Bayer pattern from strd`);
                    } else if (strdUpper.includes('BGGR')) {
                        bayerChoice = 'COLOR_BayerRG2RGB';
                        addLog(`Detected BGGR Bayer pattern from strd`);
                    } else if (strdUpper.includes('GRBG')) {
                        bayerChoice = 'COLOR_BayerGB2RGB';
                        addLog(`Detected GRBG Bayer pattern from strd`);
                    } else if (strdUpper.includes('GBRG')) {
                        bayerChoice = 'COLOR_BayerGR2RGB';
                        addLog(`Detected GBRG Bayer pattern from strd`);
                    } else if (strdUpper.includes('MONO') || strdUpper.includes('GREY') || strdUpper.includes('GRAY')) {
                        bayerChoice = 'MONO';
                        addLog(`Detected MONO/grayscale from strd`);
                    }
                } catch (e) {
                    addLog(`Failed to parse strd chunk: ${e.message}`);
                }
            }

            // If no Bayer pattern found in strd, default for raw 8-bit formats
            const is8bitRaw = (fourCC === 'Y800') || (isUncompressedBGR && bpp === 8);
            if (bayerChoice === "MONO" && is8bitRaw && (width % 2 === 0 && height % 2 === 0)) {
                // Default to RGGB = BG (OpenCV's inverted naming) - common for planetary cameras
                bayerChoice = 'COLOR_BayerBG2RGB';
                addLog(`No Bayer pattern in strd, defaulting ${fourCC} (${bpp}bpp) to RGGB`);
            }

            const result = { width, height, frameCount, fourCC, frameDataSize, bpp, bayerChoice, moviListOffset, moviListSize, needsVerticalFlip };
            addLog(`Final parsed header: ${JSON.stringify(result)}`);
            return result;

        } catch (e) {
            addLog(`[ERROR] in parseFullAviHeader: ${e.message}`);
            console.error("Error parsing full AVI header:", e);
            reportError(e, { component: 'useAviReader', action: 'parseFullAviHeader' });
            return null;
        }
    }


    async function readAviFile(file, maxFrames = -1, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false, preloadedBuffer = null, surfaceMode = false, useVngDemosaic = true, preParsedHeader = null) {
        // Reset comparison export captures for new processing
        resetCaptures();

        emit('start-loading', 'Parsing AVI header...');
        emit('update-loading', 0);

        // Use pre-parsed header if provided (avoids parsing twice)
        let aviHeader = preParsedHeader;
        if (!aviHeader) {
            // Use preloaded buffer if provided, otherwise read from file
            let headerBuffer;
            if (preloadedBuffer) {
                const headerProbeSize = Math.min(preloadedBuffer.byteLength, 1024 * 1024 * 5);
                headerBuffer = preloadedBuffer.buffer.slice(0, headerProbeSize);
            } else {
                const headerProbeSize = Math.min(file.size, 1024 * 1024 * 5);
                headerBuffer = await file.slice(0, headerProbeSize).arrayBuffer();
            }
            aviHeader = await parseFullAviHeader(headerBuffer, file.size);
        }

        if (!aviHeader) {
            addLog(`Failed to parse AVI header for ${file.name}.`);
            emit('upload-error', `Failed to parse AVI header for ${file.name}. File may be corrupt.`);
            emit('show-error');
            return; // Stop processing
        }

        // Check format BEFORE initializing workers to avoid wasting memory on fallback
        if (isMjpegFourCC(aviHeader.fourCC)) {
            // MJPEG uses GPU path with native JPEG decoding
            addLog(`MJPEG AVI detected. Using GPU processing with native JPEG decoding.`);
            return await readMjpegAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, noiseRobustAlignment, surfaceMode);
        }

        // Check for 8-bit raw Bayer data (Y800 or 8-bit DIB)
        const fourCC = aviHeader.fourCC;
        const isUncompressedBGR = fourCC === 'DIB ' || fourCC === 'RGB ' || fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00';
        const is8bitRaw = (fourCC === 'Y800') || (isUncompressedBGR && aviHeader.bpp === 8);

        if (is8bitRaw) {
            // 8-bit raw Bayer uses SER-like two-pass flow with color selector + VNG demosaic
            addLog(`8-bit raw AVI detected (${fourCC}, ${aviHeader.bpp}bpp). Using two-pass flow with VNG demosaic.`);
            return await readRawBayerAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, noiseRobustAlignment, surfaceMode, useVngDemosaic);
        }

        if (!isEasyAviFourCC(aviHeader.fourCC)) {
            addLog(`AVI format '${aviHeader.fourCC || 'unknown'}' is not supported for direct processing.`);
            return 'fallback';
        }

        // Only initialize workers after we know we can process this format
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping AVI processing due to worker initialization failure.");
            emit('show-error');
            return;
        }

        addLog(`Easy AVI detected. Header: ${aviHeader.width}x${aviHeader.height}, ${aviHeader.frameCount} frames, FourCC: ${aviHeader.fourCC}, FrameSize: ${aviHeader.frameDataSize} bytes.`);

        // Build frame index by scanning chunk headers
        emit('set-caption', 'Parsing AVI frame index...');
        const frameIndex = await parseAviFrameIndex(file, aviHeader.moviListOffset, aviHeader.moviListSize, maxFrames);
        addLog(`Found ${frameIndex.length} video frames in AVI`);

        // Use scanned frame count (header frameCount can be wrong for large files)
        const frameCount = frameIndex.length;

        if (frameIndex.length === 0) {
            addLog('No video frames found in AVI file');
            emit('upload-error', 'No video frames found in AVI file.');
            emit('stop-loading');
            return;
        }

        // Determine if we should auto-crop (only for frames larger than minimum)
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (aviHeader.width >= MIN_SIZE_FOR_CROP && aviHeader.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${aviHeader.width}x${aviHeader.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegion(file, aviHeader, frameCount, 10, frameIndex);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else {
            addLog(`Frame size ${aviHeader.width}x${aviHeader.height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = []; // These will store {sharpness, blob} (8-bit PNG)
        let bestFrameSoFar = null; // Best frame found so far (for preview)
        const allAnalyzedFrames = []; // For manual threshold selection

        function rankFrame(frame) { // frame is {sharpness, blob}
            // Capture post-crop frames for comparison export (sample evenly)
            // Use uint8Buffer directly (no conversion needed)
            if (frame.uint8Buffer && frame.width && frame.height) {
                capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frame.index, frameCount);
            }

            // Store all frames when manual threshold is enabled
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Update best frame for preview
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
                    (currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    bestFramesForStacking[minSharpnessIndex] = frame;
                }
            }
        }

        // Concurrency control: limit frames in flight to prevent memory exhaustion
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

        const workerPromises = [];
        let completedFrames = 0;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;
        let errorCount = 0;
        const maxConsecutiveErrors = 10;

        const headerForWorker = {
            width: aviHeader.width,
            height: aviHeader.height,
            fourCC: aviHeader.fourCC,
            bpp: aviHeader.bpp
        };

        // Loop through frames using frame index (handles interleaved audio correctly)
        for (let i = 0; i < frameCount; i++) {
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors. Check console for details.`);
                break;
            }

            const frame = frameIndex[i];
            const frameDataStart = frame.offset;
            const frameSize = frame.size;

            if (frameDataStart + frameSize > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            // Wait for a slot before reading the frame (limits memory usage)
            await acquireSlot();

            let frameBuffer;
            try {
                frameBuffer = await file.slice(frameDataStart, frameDataStart + frameSize).arrayBuffer();
            } catch (readError) {
                releaseSlot();
                addLog(`File read error at frame ${i}: ${readError.message}`);
                throw readError; // Re-throw to stop processing
            }
            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];
            if (!worker) {
                releaseSlot();
                addLog(`No worker available at index ${workerIndex}`);
                break;
            }

            // Determine if this frame should capture pre-crop for comparison video
            const preCropSampleInterval = Math.max(1, Math.floor(frameCount / 10));
            const shouldCapturePreCrop = cropRegion && (i % preCropSampleInterval === 0);

            const dataToWorker = {
                type: cropRegion ? 'analyze-cropped' : 'avi',
                frameBuffer: frameBuffer,
                aviHeader: { ...aviHeader },
                header: headerForWorker,
                bayerChoice: aviHeader.bayerChoice,
                cropRegion: cropRegion,
                capturePreCrop: shouldCapturePreCrop,
                index: i,
                surfaceMode: surfaceMode
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [frameBuffer])
                .then(async (result) => {
                    errorCount = 0;

                    if (result.skipped) {
                        if (result.reason === 'cut-off') {
                            cutOffFrames++;
                        } else if (result.reason === 'oversized') {
                            oversizedFrames++;
                        } else {
                            skippedFrames++;
                        }
                        completedFrames++;
                        if (result.index % 10 === 0) {
                            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                            emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: completedFrames });
                        }
                        return;
                    }

                    // Capture pre-crop frame if available (for comparison video)
                    if (result.preCropRgbaBuffer && result.preCropWidth && result.preCropHeight) {
                        capturePreCropFrame(result.preCropRgbaBuffer, result.preCropWidth, result.preCropHeight, result.index, frameCount);
                    }

                    const currentFrame = {
                        sharpness: result.sharpness,
                        blob: result.pngBlob,
                        uint8Buffer: result.uint8Buffer,        // GPU path
                        float32Buffer: result.float32Buffer,    // CPU fallback path
                        width: result.width,
                        height: result.height,
                        index: result.index,
                        subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                        circularity: result.circularity || 0
                    };
                    rankFrame(currentFrame);

                    completedFrames++;

                    if (result.index % 10 === 0 || result.index === frameCount - 1) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                        addLog(`Analyzed frame ${completedFrames}/${frameCount}`);

                        if (bestFrameSoFar) {
                            emit('best-frame-updated', bestFrameSoFar);
                        }
                    }
                })
                .catch(error => {
                    errorCount++;
                    completedFrames++;
                    // Check for heap corruption and force immediate recycle
                    if (isHeapCorruptionError(error)) {
                        forceWorkerRecycle(workerIndex);
                    }
                    addLog(`Error processing AVI frame ${i}: ${error}`);
                    console.error(`Error processing AVI frame ${i}:`, error);
                })
                .finally(() => {
                    releaseSlot();
                });
            workerPromises.push(promise);
        }

        await Promise.all(workerPromises);

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} crop-failed`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Finished analyzing ${frameCount} AVI frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: frameCount, done: true });

        // Manual threshold: let user select frames
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: unifiedAnalyzeWorkers,
                noiseRobustAlignment,
                useWebGPU,
                drizzleScale,
                frameReReader: null // AVI frames already have uint8Buffer loaded
            });
            return; // Don't terminate workers yet - they'll be used for stacking
        }

        // Check for no valid frames before attempting to stack
        if (bestFramesForStacking.length === 0) {
            const totalSkipped = cutOffFrames + skippedFrames + oversizedFrames;
            let errorMsg = 'Stacking failed: no valid frames could be processed.';

            if (cutOffFrames === frameCount) {
                errorMsg = `All ${frameCount} frames were rejected because the object touches the frame edge. Try selecting "Surface" mode for close-up Moon/Sun images, or use a wider field of view.`;
            } else if (cutOffFrames > frameCount * 0.9) {
                errorMsg = `${cutOffFrames} of ${frameCount} frames were rejected (object touching edge). Try "Surface" mode or ensure the planet is fully in frame.`;
            } else if (skippedFrames === frameCount) {
                errorMsg = `All ${frameCount} frames failed during analysis. The video may be corrupted or contain no recognizable content.`;
            } else if (totalSkipped > 0) {
                errorMsg = `No valid frames: ${cutOffFrames} cut-off, ${skippedFrames} crop-failed, ${oversizedFrames} oversized out of ${frameCount} total.`;
            }

            addLog(errorMsg);
            emit('upload-error', errorMsg);
            emit('stack-failed', { component: 'useAviReader', reason: 'no valid frames (AVI)', details: { cutOffFrames, skippedFrames, oversizedFrames, frameCount } });
            emit('show-error');
            unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
            return;
        }

        // Client-side stacking (always on)
        emit('set-caption', 'Stacking frames locally...');
        addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

        const stackingWorker = unifiedAnalyzeWorkers[0];
        const stackResult = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale, noiseRobustAlignment, useWebGPU, null, surfaceMode);

        if (stackResult && stackResult.blob) {
            addLog('Client-side stacking complete');
            emit('stacked-image-ready', {
                blob: stackResult.blob,
                float32Data: stackResult.float32Data,
                width: stackResult.width,
                height: stackResult.height
            });
        } else {
            addLog('Client-side stacking failed - frames may have been corrupted during processing');
            emit('upload-error', 'Stacking failed unexpectedly. Please try again or use a different video file.');
            emit('stack-failed', { component: 'useAviReader', reason: 'stacking returned null (AVI)' });
            emit('show-error');
        }

        // Terminate workers after all tasks are done (including stacking)
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
    }

    // Process FFmpeg-extracted PNG frames through the same pipeline as AVI
    async function processFFmpegFrames(ffmpeg, pngFilenames, manualThreshold = false, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false, surfaceMode = false) {
        // Reset comparison export captures for new processing
        resetCaptures();

        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping FFmpeg processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        addLog(`Processing ${pngFilenames.length} FFmpeg-extracted frames`);
        emit('set-caption', 'Decoding frames...');

        // Decode first PNG to get dimensions
        const firstPngData = ffmpeg.FS('readFile', pngFilenames[0]);
        const firstBlob = new Blob([firstPngData], { type: 'image/png' });
        const firstBitmap = await createImageBitmap(firstBlob);
        const width = firstBitmap.width;
        const height = firstBitmap.height;
        firstBitmap.close();

        addLog(`Frame dimensions: ${width}x${height}`);

        // Create a virtual header for RGBA frames
        const header = {
            width,
            height,
            fourCC: 'RGBA',
            bpp: 32
        };

        const frameCount = pngFilenames.length;

        // Determine if we should auto-crop
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${width}x${height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionFromPngs(ffmpeg, pngFilenames, header);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else {
            addLog(`Frame size ${width}x${height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null; // Best frame found so far (for preview)
        const allAnalyzedFrames = []; // For manual threshold selection

        function rankFrame(frame, frameIndex) {
            // Store the frame index on the frame object for tracking
            frame.frameIndex = frameIndex;

            // Capture post-crop frames for comparison export (sample evenly)
            // Use uint8Buffer directly (no conversion needed)
            if (frame.uint8Buffer && frame.width && frame.height) {
                capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frameIndex, frameCount);
            }

            // Store all frames when manual threshold is enabled
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            // Update best frame for preview
            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
                    (currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    bestFramesForStacking[minSharpnessIndex] = frame;
                }
            }
        }

        let completedFrames = 0;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;
        let errorCount = 0;
        const maxConsecutiveErrors = 10;

        // Canvas for decoding PNGs to RGBA
        const decodeCanvas = document.createElement('canvas');
        decodeCanvas.width = width;
        decodeCanvas.height = height;
        const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

        // Process in batches to limit memory usage
        const batchSize = numWorkers;

        for (let batchStart = 0; batchStart < frameCount; batchStart += batchSize) {
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors.`);
                break;
            }

            const batchEnd = Math.min(batchStart + batchSize, frameCount);
            const batchPromises = [];

            for (let i = batchStart; i < batchEnd; i++) {
                // Read and decode PNG to RGBA
                const pngData = ffmpeg.FS('readFile', pngFilenames[i]);
                ffmpeg.FS('unlink', pngFilenames[i]); // Free memory as we go

                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, width, height);
                const rgbaBuffer = imageData.data.buffer.slice(0); // Copy for transfer

                // Clear canvas to help GC
                decodeCtx.clearRect(0, 0, width, height);

                const workerIndex = i % numWorkers;
                const worker = unifiedAnalyzeWorkers[workerIndex];

                // Determine if this frame should capture pre-crop for comparison video
                const preCropSampleInterval = Math.max(1, Math.floor(frameCount / 10));
                const shouldCapturePreCrop = cropRegion && (i % preCropSampleInterval === 0);

                const dataToWorker = {
                    type: cropRegion ? 'analyze-cropped' : 'avi',
                    frameBuffer: rgbaBuffer,
                    aviHeader: header,
                    header: header,
                    bayerChoice: 'MONO',
                    cropRegion: cropRegion,
                    capturePreCrop: shouldCapturePreCrop,
                    index: i,
                    surfaceMode: surfaceMode
                };

                const promise = processFrameWithWorker(worker, dataToWorker, [rgbaBuffer])
                    .then(async (result) => {
                        errorCount = 0;

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
                            capturePreCropFrame(result.preCropRgbaBuffer, result.preCropWidth, result.preCropHeight, result.index, frameCount);
                        }

                        const currentFrame = {
                            sharpness: result.sharpness,
                            blob: result.pngBlob,
                            uint8Buffer: result.uint8Buffer,        // GPU path
                            float32Buffer: result.float32Buffer,    // CPU fallback path
                            width: result.width,
                            height: result.height,
                            index: result.index,
                            subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                            circularity: result.circularity || 0
                        };
                        rankFrame(currentFrame, result.index);

                        completedFrames++;
                    })
                    .catch(error => {
                        errorCount++;
                        // Check for heap corruption and force immediate recycle
                        if (isHeapCorruptionError(error)) {
                            forceWorkerRecycle(workerIndex);
                        }
                        addLog(`Error processing frame ${i}: ${error}`);
                        console.error(`Error processing frame ${i}:`, error);
                    });
                batchPromises.push(promise);
            }

            // Wait for batch to complete before starting next
            await Promise.all(batchPromises);

            // Update UI after each batch
            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
            if (completedFrames % 50 === 0 || batchEnd === frameCount) {
                addLog(`Analyzed frame ${completedFrames}/${frameCount}`);
                emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: completedFrames });

                if (bestFrameSoFar) {
                    emit('best-frame-updated', bestFrameSoFar);
                }
            }
        }

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} crop-failed`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: frameCount, done: true });

        // Manual threshold: let user select frames
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: unifiedAnalyzeWorkers,
                noiseRobustAlignment,
                useWebGPU,
                drizzleScale,
                frameReReader: null // AVI frames already have uint8Buffer loaded
            });
            return; // Don't terminate workers yet - they'll be used for stacking
        }

        // Check for no valid frames before attempting to stack
        if (bestFramesForStacking.length === 0) {
            const totalSkipped = cutOffFrames + skippedFrames + oversizedFrames;
            let errorMsg = 'Stacking failed: no valid frames could be processed.';

            if (cutOffFrames === frameCount) {
                // All frames had planet touching edge
                errorMsg = `All ${frameCount} frames were rejected because the object touches the frame edge. Try selecting "Surface" mode for close-up Moon/Sun images, or use a wider field of view.`;
            } else if (cutOffFrames > frameCount * 0.9) {
                // Most frames cut-off
                errorMsg = `${cutOffFrames} of ${frameCount} frames were rejected (object touching edge). Try "Surface" mode or ensure the planet is fully in frame.`;
            } else if (skippedFrames === frameCount) {
                // All frames failed crop/analysis
                errorMsg = `All ${frameCount} frames failed during analysis. The video may be corrupted or contain no recognizable content.`;
            } else if (totalSkipped > 0) {
                errorMsg = `No valid frames: ${cutOffFrames} cut-off, ${skippedFrames} crop-failed, ${oversizedFrames} oversized out of ${frameCount} total.`;
            }

            addLog(errorMsg);
            emit('upload-error', errorMsg);
            emit('stack-failed', { component: 'useAviReader', reason: 'no valid frames (FFmpeg)', details: { cutOffFrames, skippedFrames, oversizedFrames, frameCount } });
            emit('show-error');
            unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
            return;
        }

        // Client-side stacking: use one of the existing workers (before terminating them)
        emit('set-caption', 'Stacking frames locally...');
        addLog(`Starting client-side stacking of ${bestFramesForStacking.length} frames`);

        const stackingWorker = unifiedAnalyzeWorkers[0];
        const stackResult = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale, noiseRobustAlignment, useWebGPU, null, surfaceMode);

        if (stackResult && stackResult.blob) {
            addLog('Client-side stacking complete');
            emit('stacked-image-ready', {
                blob: stackResult.blob,
                float32Data: stackResult.float32Data,
                width: stackResult.width,
                height: stackResult.height
            });
        } else {
            // This should rarely happen now that we check bestFramesForStacking above
            addLog('Client-side stacking failed - frames may have been corrupted during processing');
            emit('upload-error', 'Stacking failed unexpectedly. Please try again or use a different video file.');
            emit('stack-failed', { component: 'useAviReader', reason: 'stacking returned null (FFmpeg)' });
            emit('show-error');
        }

        // Terminate workers after all tasks are done (including stacking)
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
    }

    // Detect crop region from PNG frames
    async function detectCropRegionFromPngs(ffmpeg, pngFilenames, header) {
        emit('set-caption', 'Detecting planet position...');

        const frameCount = pngFilenames.length;
        // Sample fewer frames for large videos to save memory
        const maxSamples = 20;
        const sampleInterval = Math.max(1, Math.floor(frameCount / maxSamples));
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        // Canvas for decoding
        const decodeCanvas = document.createElement('canvas');
        decodeCanvas.width = header.width;
        decodeCanvas.height = header.height;
        const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = []; // Collect center positions for stable reference
        const detectedSizes = []; // Collect sizes for median calculation

        // Process sequentially to limit memory usage
        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];

            try {
                // Read and decode PNG
                const pngData = ffmpeg.FS('readFile', pngFilenames[i]);
                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, header.width, header.height);
                const rgbaBuffer = imageData.data.buffer.slice(0);

                const workerIndex = idx % numWorkers;
                const worker = unifiedAnalyzeWorkers[workerIndex];

                const dataToWorker = {
                    type: 'detect-bounds',
                    frameBuffer: rgbaBuffer,
                    header: header,
                    bayerChoice: 'MONO',
                    index: idx
                };

                // Wait for each frame to complete before moving to next (sequential processing)
                const result = await processFrameWithWorker(worker, dataToWorker, [rgbaBuffer]);

                if (result.bounds && result.bounds.canCrop) {
                    canCropCount++;
                    maxSize = Math.max(maxSize, result.bounds.size);
                    // Use actual detected center (not derived from clamped crop coords)
                    detectedCenters.push({ x: result.bounds.centerX, y: result.bounds.centerY });
                    detectedSizes.push(result.bounds.size);
                } else if (result.bounds) {
                    console.log(`Frame ${i} can't crop: ${result.bounds.reason || 'unknown'}`);
                }

                // Clear canvas to help GC
                decodeCtx.clearRect(0, 0, header.width, header.height);

            } catch (error) {
                console.error(`Error detecting bounds for sample ${idx}:`, error);
            }

            emit('update-loading', { progress: ((idx + 1) / sampleIndices.length) * 100, current: idx + 1, total: sampleIndices.length });
        }

        // Only need 50% of frames to be croppable (was 80%, but too strict for videos where planet moves near edges)
        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Calculate median size (more robust than max which can be skewed by moons/noise)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0;

        // Use median size with 5% margin, capped at frame dimensions
        const marginMultiplier = 1.10; // 10% margin for padding around planet
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(header.width, header.height);
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} (from median ${medianSize}) exceeds frame size ${maxAllowedSize}, clamping`);
        }

        // Calculate median center position as fallback reference
        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize}, max detected: ${maxSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY } };
    }

    // GPU worker for MJPEG processing
    let gpuWorker = null;
    let gpuReady = false;

    async function initializeGpuWorker() {
        if (gpuReady) return true;

        gpuWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'));

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('GPU worker timeout')), 30000);
                gpuWorker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        resolve();
                    } else if (e.data.type === 'init-error') {
                        clearTimeout(timeout);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.postMessage({ type: 'init' });
            });
            gpuReady = true;
            addLog('GPU analyze worker initialized');
            return true;
        } catch (error) {
            console.error('GPU worker init failed:', error);
            addLog(`GPU worker init failed: ${error.message}, falling back to CPU`);
            reportError(error, { component: 'useAviReader', action: 'initializeGpuWorker' });
            gpuWorker.terminate();
            gpuWorker = null;
            return false;
        }
    }

    // Map OpenCV Bayer pattern names to GPU shader pattern indices
    // OpenCV uses inverted naming: BG = industry RGGB, RG = industry BGGR
    // GPU shader indices: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    function bayerChoiceToGpuPattern(bayerChoice) {
        const mapping = {
            'COLOR_BayerBG2RGB': 0,  // RGGB (OpenCV BG = industry RGGB)
            'COLOR_BayerRG2RGB': 1,  // BGGR (OpenCV RG = industry BGGR)
            'COLOR_BayerGB2RGB': 2,  // GRBG (OpenCV GB = industry GRBG)
            'COLOR_BayerGR2RGB': 3,  // GBRG (OpenCV GR = industry GBRG)
            'MONO': -1  // No demosaic needed
        };
        return mapping[bayerChoice] ?? 0;
    }

    // GPU batch analysis for raw Bayer frames (similar to SER's analyzeFrameBatchGpu)
    async function analyzeBayerBatchGpu(frames, width, height, bayerPattern, threshold = 0.1, metadataOnly = false) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);
                if (e.data.type === 'analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'analyze-error') {
                    reject(new Error(e.data.error));
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
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

    // Decode JPEG data to RGBA using native browser decoding (hardware accelerated)
    async function decodeJpegToRgba(jpegData, width, height) {
        const blob = new Blob([jpegData], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            data: imageData.data,
            width: canvas.width,
            height: canvas.height
        };
    }

    // GPU batch analysis for RGBA frames
    async function analyzeRgbaBatchGpu(frames, width, height) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);
                if (e.data.type === 'analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'analyze-error') {
                    reject(new Error(e.data.error));
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
                type: 'analyze-batch',
                frames,
                width,
                height,
                bayerPattern: -1, // RGBA input, no demosaic
                threshold: 0.1,
                requestId
            });
        });
    }

    // GPU crop and analyze for RGBA frames
    async function cropAndAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, centers, metadataOnly = false) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);
                if (e.data.type === 'crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'crop-analyze-error') {
                    reject(new Error(e.data.error));
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
                type: 'crop-analyze-batch',
                frames,
                srcWidth,
                srcHeight,
                cropSize,
                centers,
                bayerPattern: -1, // RGBA input
                threshold: 0.1,
                requestId,
                metadataOnly
            });
        });
    }

    // Combined detect + crop + analyze in ONE GPU pass for RGBA frames
    // Same as SER's detectCropAnalyzeGpu but for already-decoded RGBA input
    async function detectCropAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, threshold = 0.1, metadataOnly = false) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);
                if (e.data.type === 'detect-crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'detect-crop-analyze-error') {
                    reject(new Error(e.data.error));
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
                type: 'detect-crop-analyze-batch',
                frames,
                srcWidth,
                srcHeight,
                cropSize,
                bayerPattern: -1, // RGBA input, no demosaic
                threshold,
                requestId,
                metadataOnly
            });
        });
    }

    // Combined detect + crop + analyze for raw Bayer frames with specified pattern
    async function detectCropAnalyzeBayerGpu(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold = 0.1, metadataOnly = false) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);
                if (e.data.type === 'detect-crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'detect-crop-analyze-error') {
                    reject(new Error(e.data.error));
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
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

    // Detect crop region for MJPEG using GPU
    async function detectCropRegionMjpegGpu(file, frameIndex, width, height, cropMarginPercent = 10) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: frameIndex.length });

        // Sample every Nth frame
        const sampleInterval = Math.max(1, Math.floor(frameIndex.length / 50));
        const sampleIndices = [];
        for (let i = 0; i < frameIndex.length; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} MJPEG frames for crop detection (GPU)...`);

        const BATCH_SIZE = 32;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleIndices.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, sampleIndices.length);
            const batch = [];

            // Decode JPEG frames for this batch
            for (let i = batchStart; i < batchEnd; i++) {
                const frameIdx = sampleIndices[i];
                const frame = frameIndex[frameIdx];

                try {
                    const jpegData = await file.slice(frame.offset, frame.offset + frame.size).arrayBuffer();
                    const rgba = await decodeJpegToRgba(new Uint8Array(jpegData), width, height);
                    batch.push({ data: rgba.data, index: frameIdx });
                } catch (e) {
                    console.warn(`Failed to decode MJPEG frame ${frameIdx}:`, e);
                }
            }

            if (batch.length === 0) continue;

            const results = await analyzeRgbaBatchGpu(batch, width, height);

            for (const result of results) {
                if (result.bounds) {
                    canCropCount++;
                    detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
                    detectedSizes.push(result.bounds.size || Math.max(result.bounds.width, result.bounds.height));
                }
            }

            emit('update-loading', {
                progress: (batchEnd / sampleIndices.length) * 100,
                current: batchEnd,
                total: sampleIndices.length
            });
        }

        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0;

        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(width, height);
        let finalSize = Math.min(desiredSize, maxAllowedSize);

        if (desiredSize > maxAllowedSize) {
            addLog(`Crop size ${desiredSize} exceeds frame size ${maxAllowedSize}, clamping`);
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${Math.round(medianSize)}, margin: ${cropMarginPercent}%`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Process 8-bit raw Bayer AVI file (Y800 or 8-bit DIB) with SER-like two-pass flow
    // Phase 1: Show color selector, analyze frames (sharpness), store metadata only
    // Phase 2: Re-read selected frames on-demand with VNG demosaic for stacking
    async function readRawBayerAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, noiseRobustAlignment, surfaceMode = false, useVngDemosaic = true) {
        resetCaptures();

        const { width, height, bpp } = aviHeader;
        const frameDataSize = width * height; // 8-bit = 1 byte per pixel

        // Initialize GPU worker for analysis and stacking
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog('GPU not available for 8-bit raw AVI processing');
            emit('upload-error', 'WebGPU required for 8-bit raw AVI processing');
            emit('stop-loading');
            return;
        }

        // Scan for frame index
        emit('set-caption', 'Parsing AVI frame index...');
        const frameIndex = await parseAviFrameIndex(file, aviHeader.moviListOffset, aviHeader.moviListSize, maxFrames);

        if (frameIndex.length === 0) {
            addLog('No frames found in AVI file');
            emit('upload-error', 'No video frames found in AVI file.');
            emit('stop-loading');
            return;
        }

        const frameCount = frameIndex.length;
        addLog(`Found ${frameCount} frames in 8-bit raw AVI (${width}x${height}, ${bpp}bpp)`);

        // Read first frame for color profile selector preview
        emit('set-caption', 'Loading preview frame...');
        const firstFrameInfo = frameIndex[0];
        let previewBuffer = await file.slice(firstFrameInfo.offset, firstFrameInfo.offset + frameDataSize).arrayBuffer();

        // Flip vertically if DIB bottom-up storage
        if (aviHeader.needsVerticalFlip) {
            previewBuffer = flipFrameVertically(previewBuffer, width, height, 1).buffer;
        }

        // Auto-detect based on what was parsed from strd chunk (if any)
        const autoDetectedProfile = aviHeader.bayerChoice || 'COLOR_BayerBG2RGB';

        // Create header for ColorProfileSelector (mimics SER header format)
        let previewHeader = {
            width,
            height,
            pixelDepth: 8,
            colorID: 8 // Treat as RGGB by default (will be overridden by user selection)
        };

        // Generate cropped previews for each Bayer pattern using GPU
        const MIN_SIZE_FOR_CROP = 300;
        let preRenderedThumbnails = null;

        if (width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
            emit('set-caption', 'Generating color profile previews...');
            try {
                const frameData = new Uint8Array(previewBuffer);
                const frames = [{ data: frameData, index: 0 }];

                // First detect bounds using pattern 0 to get object size
                const detectResults = await detectCropAnalyzeBayerGpu(frames, width, height, Math.min(width, height), 0, 0.10, false);

                let previewCropSize = Math.min(width, height);
                if (detectResults && detectResults[0] && detectResults[0].bounds) {
                    const detectedSize = Math.max(detectResults[0].bounds.width, detectResults[0].bounds.height);
                    const margin = 1 + (cropMarginPercent / 100);
                    previewCropSize = Math.min(Math.ceil(detectedSize * margin / 2) * 2, Math.min(width, height));
                }

                // Bayer patterns: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
                const patterns = [
                    { id: 'COLOR_BayerBG2RGB', pattern: 0 },  // RGGB
                    { id: 'COLOR_BayerRG2RGB', pattern: 1 },  // BGGR
                    { id: 'COLOR_BayerGR2RGB', pattern: 3 },  // GBRG
                    { id: 'COLOR_BayerGB2RGB', pattern: 2 },  // GRBG
                ];

                preRenderedThumbnails = [];

                for (const { id, pattern } of patterns) {
                    const results = await detectCropAnalyzeBayerGpu(frames, width, height, previewCropSize, pattern, 0.10, false);
                    if (results && results[0] && results[0].uint8Buffer) {
                        preRenderedThumbnails.push({
                            id,
                            rgba: results[0].uint8Buffer,
                            width: previewCropSize,
                            height: previewCropSize
                        });
                    }
                }

                // Generate mono thumbnail from the first Bayer result (just use grayscale)
                if (preRenderedThumbnails.length > 0) {
                    const firstThumb = preRenderedThumbnails[0];
                    const rgba = new Uint8Array(firstThumb.rgba);
                    const monoRgba = new Uint8Array(rgba.length);
                    // Convert to grayscale
                    for (let i = 0; i < rgba.length; i += 4) {
                        const gray = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
                        monoRgba[i] = gray;
                        monoRgba[i + 1] = gray;
                        monoRgba[i + 2] = gray;
                        monoRgba[i + 3] = 255;
                    }
                    preRenderedThumbnails.push({
                        id: 'MONO',
                        rgba: monoRgba.buffer,
                        width: firstThumb.width,
                        height: firstThumb.height
                    });
                }

                if (preRenderedThumbnails.length === 5) {
                    addLog(`Generated ${preRenderedThumbnails.length} cropped preview thumbnails (${previewCropSize}x${previewCropSize})`);
                } else {
                    addLog(`Only generated ${preRenderedThumbnails.length}/5 thumbnails, falling back`);
                    preRenderedThumbnails = null;
                }
            } catch (error) {
                console.error(`[AVI Preview] Error generating thumbnails:`, error);
                addLog(`Could not generate preview thumbnails: ${error.message}`);
                preRenderedThumbnails = null;
            }
        }

        emit('set-caption', 'Select color profile');

        // Wait for user to select a color profile
        const bayerChoice = await new Promise((resolve) => {
            emit('show-color-profile-selector', {
                frameBuffer: previewBuffer,
                header: previewHeader,
                autoDetectedProfile: autoDetectedProfile,
                thumbnails: preRenderedThumbnails,
                resolve: resolve
            });
        });

        addLog(`User selected color profile: ${bayerChoice}`);

        // Handle MONO selection - no demosaicing needed
        if (bayerChoice === 'MONO') {
            addLog('MONO selected - treating as grayscale, no demosaicing');
            // Fall back to regular AVI processing without Bayer
            // Update aviHeader to mark as MONO and use existing path
            aviHeader.bayerChoice = 'MONO';
            emit('set-caption', 'Processing as grayscale...');
            // Continue with simpler grayscale processing (TODO: could optimize this path too)
        }

        emit('set-caption', 'Analyzing frames...');

        const needsCrop = width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP;

        // Detect crop region using first N frames
        let cropRegion = null;
        if (needsCrop) {
            addLog(`Frame size ${width}x${height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionForBayerAvi(file, frameIndex, width, height, frameDataSize, bayerChoice, cropMarginPercent);
            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        }

        const cropSize = cropRegion?.size || Math.min(width, height);

        emit('set-caption', cropRegion ? 'Cropping, centering, and analyzing frames' : 'Analyzing frames');

        // Analyze frames in batches using GPU
        const batchSize = 16;
        const allAnalyzedFrames = [];
        const frameCenters = new Map();
        let bestFrameSoFar = null;

        const analysisStartTime = performance.now();

        for (let batchStart = 0; batchStart < frameCount; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, frameCount);
            const progress = Math.round((batchStart / frameCount) * 50);
            emit('update-loading', { progress, current: batchStart, total: frameCount });

            // Load batch of raw frames (store offsets for later use in stacking)
            const batchFrames = [];
            const batchOffsets = []; // Store offsets so stacking doesn't need frameIndex
            const needsFlip = aviHeader.needsVerticalFlip;
            for (let i = batchStart; i < batchEnd; i++) {
                const frameInfo = frameIndex[i];
                const rawBuffer = await file.slice(frameInfo.offset, frameInfo.offset + frameDataSize).arrayBuffer();
                const frameData = needsFlip
                    ? flipFrameVertically(rawBuffer, width, height, 1)
                    : new Uint8Array(rawBuffer);
                batchFrames.push({ index: i, data: frameData });
                batchOffsets.push(frameInfo.offset);
            }

            // Analyze batch with GPU
            const batchResults = await analyzeBayerBatchGpu(batchFrames, width, height, bayerChoice, cropRegion);

            for (const result of batchResults) {
                if (result.sharpness > 0) {
                    const offsetIdx = result.index - batchStart;
                    allAnalyzedFrames.push({
                        index: result.index,
                        offset: batchOffsets[offsetIdx], // Store offset directly for stacking phase
                        sharpness: result.sharpness,
                        centerX: result.centerX,
                        centerY: result.centerY,
                        circularity: result.circularity || 0
                    });
                    frameCenters.set(result.index, { x: result.centerX, y: result.centerY });
                    if (!bestFrameSoFar || result.sharpness > bestFrameSoFar.sharpness) {
                        bestFrameSoFar = { index: result.index, sharpness: result.sharpness, centerX: result.centerX, centerY: result.centerY, circularity: result.circularity || 0 };
                    }
                }
            }

            // Emit preview update every few batches
            if (bestFrameSoFar && batchStart % (batchSize * 4) === 0) {
                const bestFrameInfo = frameIndex[bestFrameSoFar.index];
                let previewBuffer = await file.slice(bestFrameInfo.offset, bestFrameInfo.offset + frameDataSize).arrayBuffer();
                if (needsFlip) {
                    previewBuffer = flipFrameVertically(previewBuffer, width, height, 1).buffer;
                }
                const previewBlob = await createBayerPreviewBlob(previewBuffer, width, height, bayerChoice, cropRegion, bestFrameSoFar.centerX, bestFrameSoFar.centerY);
                if (previewBlob) {
                    emit('best-frame-updated', { sharpness: bestFrameSoFar.sharpness, circularity: bestFrameSoFar.circularity, blob: previewBlob, width: cropSize, height: cropSize });
                }
            }
        }

        addLog(`Analyzed ${frameCount} frames, ${allAnalyzedFrames.length} valid`);

        if (allAnalyzedFrames.length === 0) {
            addLog('No valid frames found');
            emit('upload-error', 'No valid frames found in AVI file.');
            emit('stop-loading');
            return;
        }

        // Sort by sharpness and select best frames
        allAnalyzedFrames.sort((a, b) => b.sharpness - a.sharpness);
        const bestFramesCapacity = Math.max(1, Math.floor(allAnalyzedFrames.length * stackPercentage / 100));
        const bestFramesForStacking = allAnalyzedFrames.slice(0, bestFramesCapacity);

        addLog(`Selected ${bestFramesForStacking.length} best frames for stacking (${stackPercentage}%)`);

        // Show best frame preview (during analysis phase)
        if (bestFramesForStacking.length > 0) {
            const bestFrame = bestFramesForStacking[0];
            addLog(`Creating preview for best frame ${bestFrame.index} (sharpness: ${bestFrame.sharpness.toFixed(2)})`);
            // Use offset from frame metadata (stored during analysis)
            let bestFrameBuffer = await file.slice(bestFrame.offset, bestFrame.offset + frameDataSize).arrayBuffer();

            // Flip vertically if DIB bottom-up storage
            if (aviHeader.needsVerticalFlip) {
                bestFrameBuffer = flipFrameVertically(bestFrameBuffer, width, height, 1).buffer;
            }

            // Create preview using simple demosaic
            const previewBlob = await createBayerPreviewBlob(bestFrameBuffer, width, height, bayerChoice, cropRegion, bestFrame.centerX, bestFrame.centerY);
            if (previewBlob) {
                addLog(`Preview blob created: ${previewBlob.size} bytes`);
                // Emit best-frame-updated for preview display (doesn't navigate)
                emit('best-frame-updated', {
                    sharpness: bestFrame.sharpness,
                    circularity: bestFrame.circularity,
                    blob: previewBlob,
                    width: cropSize,
                    height: cropSize
                });
            } else {
                addLog('Preview blob creation failed');
            }
        }

        // Create frameReReader for two-pass stacking
        const needsFlip = aviHeader.needsVerticalFlip;
        const frameReReader = {
            fileType: 'ser-multi', // Use ser-multi to leverage getFrame() method in stacker
            file,
            header: {
                width,
                height,
                pixelDepth: 8
            },
            bayerChoice,
            cropRegion,
            frameDataSize,
            analysisStartTime,
            useVngDemosaic,
            needsVerticalFlip: needsFlip,

            // Re-read a single frame and return raw buffer + center
            async getFrame(frame) {
                const offset = frame.offset;
                if (offset === undefined) {
                    console.warn(`No offset for frame ${frame.index}`);
                    return null;
                }
                let frameBuffer = await this.file.slice(offset, offset + this.frameDataSize).arrayBuffer();

                // Flip vertically if DIB bottom-up storage
                if (this.needsVerticalFlip) {
                    const flipped = flipFrameVertically(frameBuffer, this.header.width, this.header.height, 1);
                    frameBuffer = flipped.buffer;
                }

                return {
                    frameBuffer,
                    centerX: frame.centerX,
                    centerY: this.needsVerticalFlip ? (this.header.height - frame.centerY) : frame.centerY
                };
            },

            // Re-read multiple frames in parallel
            async getFrames(frameIndices) {
                const results = await Promise.all(
                    frameIndices.map(idx => this.getFrame(idx))
                );
                return results.filter(r => r !== null);
            },

            // Generate preview blob on-demand (for QualitySelector)
            async getPreviewBlob(frame) {
                const frameData = await this.getFrame(frame);
                if (!frameData) return null;

                const blob = await createBayerPreviewBlob(
                    frameData.frameBuffer,
                    this.header.width,
                    this.header.height,
                    this.bayerChoice,
                    this.cropRegion,
                    frameData.centerX,
                    frameData.centerY
                );
                return blob;
            }
        };

        addLog(`Created frameReReader for two-pass stacking with VNG=${useVngDemosaic}`);

        // Manual threshold: let user select frames
        if (manualThreshold) {
            // For manual threshold, frames need width/height for the selector UI
            // Add cropSize to each frame for display
            const framesWithSize = allAnalyzedFrames.map(f => ({
                ...f,
                width: cropSize,
                height: cropSize
            }));
            const allFramesSorted = [...framesWithSize].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: null, // Two-pass uses frameReReader instead
                noiseRobustAlignment,
                useWebGPU: true,
                drizzleScale,
                frameReReader,
                surfaceMode
            });
            return; // Don't stack yet - user will select frames
        }

        // Check for no valid frames before stacking
        if (bestFramesForStacking.length === 0) {
            addLog('No valid frames found for stacking');
            emit('upload-error', 'No valid frames found for stacking.');
            emit('stop-loading');
            return;
        }

        // Phase 2: Stack using GPU with VNG demosaic
        emit('set-caption', 'Stacking frames...');
        addLog(`Starting stacking of ${bestFramesForStacking.length} frames`);

        const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, noiseRobustAlignment, true, frameReReader, surfaceMode);

        if (!stackResult || !stackResult.blob) {
            addLog('Stacking failed');
            emit('upload-error', 'Stacking failed. Please try again.');
            emit('stop-loading');
            return;
        }

        addLog(`Stacking complete: ${stackResult.width}x${stackResult.height}`);

        // Emit stacked image ready - this triggers navigation to post-processor
        emit('stacked-image-ready', {
            blob: stackResult.blob,
            float32Data: stackResult.float32Data,
            width: stackResult.width,
            height: stackResult.height
        });

        emit('stop-loading');
    }

    // Detect crop region for 8-bit Bayer AVI by analyzing sample frames
    async function detectCropRegionForBayerAvi(file, frameIndex, width, height, frameDataSize, bayerChoice, cropMarginPercent) {
        const sampleCount = Math.min(10, frameIndex.length);
        const sampleIndices = [];

        // Sample evenly spaced frames
        for (let i = 0; i < sampleCount; i++) {
            sampleIndices.push(Math.floor(i * frameIndex.length / sampleCount));
        }

        const detectedCenters = [];
        const detectedSizes = [];

        for (const idx of sampleIndices) {
            const frameInfo = frameIndex[idx];
            const rawBuffer = await file.slice(frameInfo.offset, frameInfo.offset + frameDataSize).arrayBuffer();

            // Simple object detection on demosaiced frame
            const result = await detectObjectInBayerFrame(rawBuffer, width, height, bayerChoice);
            if (result) {
                detectedCenters.push({ x: result.centerX, y: result.centerY });
                detectedSizes.push(result.size);
            }
        }

        if (detectedCenters.length === 0) {
            addLog('Could not detect object in sample frames');
            return null;
        }

        // Calculate median size with margin
        detectedSizes.sort((a, b) => a - b);
        const medianSize = detectedSizes[Math.floor(detectedSizes.length / 2)];
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        let finalSize = Math.ceil(medianSize * marginMultiplier);

        // Round up to even number for Bayer alignment
        if (finalSize % 2 !== 0) finalSize++;

        // Clamp to frame dimensions
        finalSize = Math.min(finalSize, width, height);

        // Calculate median center
        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        return {
            size: finalSize,
            referenceCenter: { x: medianX, y: medianY },
            medianObjectSize: medianSize
        };
    }

    // Analyze a batch of Bayer frames using GPU (simple demosaic for sharpness)
    async function analyzeBayerBatchGpu(batchFrames, width, height, bayerChoice, cropRegion) {
        // Map bayerChoice to GPU pattern
        const bayerMap = {
            'COLOR_BayerBG2RGB': 0, 'COLOR_BayerRG2RGB': 1,
            'COLOR_BayerGB2RGB': 2, 'COLOR_BayerGR2RGB': 3
        };
        const bayerPattern = bayerMap[bayerChoice] ?? 0;

        // Prepare frames array for batch processing - worker expects { data, index }
        const framesData = batchFrames.map(f => ({ data: f.data, index: f.index }));
        const cropSize = cropRegion?.size || Math.min(width, height);

        try {
            // Send batch to GPU worker for analysis with object detection
            const batchResults = await new Promise((resolve, reject) => {
                const requestId = `bayer_batch_${Date.now()}`;

                const handler = (e) => {
                    if (e.data.requestId === requestId) {
                        gpuWorker.removeEventListener('message', handler);
                        if (e.data.type === 'detect-crop-analyze-result') {
                            resolve(e.data.results);
                        } else if (e.data.type === 'detect-crop-analyze-error') {
                            reject(new Error(e.data.error));
                        }
                    }
                };
                gpuWorker.addEventListener('message', handler);

                gpuWorker.postMessage({
                    type: 'detect-crop-analyze-batch',
                    frames: framesData,
                    srcWidth: width,
                    srcHeight: height,
                    cropSize,
                    bayerPattern,
                    threshold: 0.1,
                    metadataOnly: true, // Just need sharpness + center, not float32 buffer
                    requestId
                });
            });

            // Map results back to frame indices
            return batchFrames.map((frame, i) => {
                const result = batchResults[i] || {};
                return {
                    index: frame.index,
                    sharpness: result.sharpness || 0,
                    centerX: result.centerX ?? width / 2,
                    centerY: result.centerY ?? height / 2,
                    circularity: result.circularity || 0
                };
            });
        } catch (err) {
            addLog(`Batch analysis failed: ${err.message}`);
            // Return default results on error
            return batchFrames.map(frame => ({
                index: frame.index,
                sharpness: 0,
                centerX: width / 2,
                centerY: height / 2
            }));
        }
    }

    // Detect object bounds in a single Bayer frame (for crop region detection)
    async function detectObjectInBayerFrame(rawBuffer, width, height, bayerChoice) {
        const bayerMap = {
            'COLOR_BayerBG2RGB': 0, 'COLOR_BayerRG2RGB': 1,
            'COLOR_BayerGB2RGB': 2, 'COLOR_BayerGR2RGB': 3
        };
        const bayerPattern = bayerMap[bayerChoice] ?? 0;
        const cropSize = Math.min(width, height);

        try {
            // Use batch API with single frame
            const result = await new Promise((resolve, reject) => {
                const requestId = `detect_${Date.now()}`;

                const handler = (e) => {
                    if (e.data.requestId === requestId) {
                        gpuWorker.removeEventListener('message', handler);
                        if (e.data.type === 'detect-crop-analyze-result') {
                            resolve(e.data.results[0] || {});
                        } else if (e.data.type === 'detect-crop-analyze-error') {
                            reject(new Error(e.data.error));
                        }
                    }
                };
                gpuWorker.addEventListener('message', handler);

                gpuWorker.postMessage({
                    type: 'detect-crop-analyze-batch',
                    frames: [{ data: new Uint8Array(rawBuffer), index: 0 }],
                    srcWidth: width,
                    srcHeight: height,
                    cropSize,
                    bayerPattern,
                    threshold: 0.1,
                    metadataOnly: true,
                    requestId
                });
            });

            if (result.bounds) {
                return {
                    centerX: result.bounds.centroidX,
                    centerY: result.bounds.centroidY,
                    size: result.bounds.size || Math.max(result.bounds.width, result.bounds.height)
                };
            }

            // Fallback to center-based detection from GPU
            if (result.centerX !== undefined && result.centerY !== undefined) {
                return {
                    centerX: result.centerX,
                    centerY: result.centerY,
                    size: Math.min(width, height) * 0.8
                };
            }
        } catch (err) {
            addLog(`Object detection failed: ${err.message}`);
        }

        return null;
    }

    // Create a preview blob from Bayer data with simple demosaic
    async function createBayerPreviewBlob(rawBuffer, width, height, bayerChoice, cropRegion, centerX, centerY) {
        try {
            // Simple bilinear demosaic for preview
            const src = new Uint8Array(rawBuffer);
            const rgba = new Uint8ClampedArray(width * height * 4);

            demosaicBayerToRgba(src, rgba, width, height, bayerChoice);
            autoStretchRgba(rgba);

            // Create canvas and render
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            const imageData = new ImageData(rgba, width, height);
            ctx.putImageData(imageData, 0, 0);

            // If crop region, extract cropped portion
            if (cropRegion && centerX !== undefined && centerY !== undefined) {
                const cropSize = cropRegion.size;
                const cropX = Math.max(0, Math.min(width - cropSize, Math.round(centerX - cropSize / 2)));
                const cropY = Math.max(0, Math.min(height - cropSize, Math.round(centerY - cropSize / 2)));

                const croppedCanvas = new OffscreenCanvas(cropSize, cropSize);
                const croppedCtx = croppedCanvas.getContext('2d');
                croppedCtx.drawImage(canvas, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);

                return await croppedCanvas.convertToBlob({ type: 'image/png' });
            }

            return await canvas.convertToBlob({ type: 'image/png' });
        } catch (err) {
            addLog(`Preview creation failed: ${err.message}`);
            return null;
        }
    }

    // Process MJPEG AVI file with GPU acceleration
    async function readMjpegAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, noiseRobustAlignment, surfaceMode = false) {
        resetCaptures();

        // Initialize GPU worker
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog('GPU not available for MJPEG processing, falling back to FFmpeg');
            return 'fallback';
        }

        // Parse MJPEG frame index by scanning chunk headers
        emit('set-caption', 'Parsing MJPEG frame index...');
        const frameIndex = await parseAviFrameIndex(file, aviHeader.moviListOffset, aviHeader.moviListSize, maxFrames);

        if (frameIndex.length === 0) {
            addLog('No MJPEG frames found in file');
            emit('upload-error', 'No video frames found in MJPEG file.');
            emit('stop-loading');
            return;
        }

        addLog(`Found ${frameIndex.length} MJPEG frames`);

        const frameCount = frameIndex.length;
        const { width, height } = aviHeader;

        // Detect crop region
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${width}x${height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionMjpegGpu(file, frameIndex, width, height, cropMarginPercent);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null;
        let refCandidateSoFar = null;
        const allAnalyzedFrames = [];
        const frameCenters = new Map();

        function rankFrame(frame) {
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            if (!bestFrameSoFar || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            if (!refCandidateSoFar || (frame.circularity || 0) > (refCandidateSoFar.circularity || 0)) {
                refCandidateSoFar = frame;
            }

            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                const minIdx = bestFramesForStacking.reduce((minI, f, i, arr) =>
                    f.sharpness < arr[minI].sharpness ? i : minI, 0);
                if (frame.sharpness > bestFramesForStacking[minIdx].sharpness) {
                    bestFramesForStacking[minIdx] = frame;
                }
            }
        }

        let completedFrames = 0;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;

        // Dynamic batch size - start aggressive, OOM handling will scale back
        const frameBytes = width * height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 512 * 1024 * 1024; // 512MB (OOM handling will reduce if needed)
        let effectiveBatchSize = Math.max(4, Math.min(128, Math.floor(targetBatchMemory / frameBytes)));

        // Helper to check for OOM errors
        const isOOMError = (err) => err.message?.includes('Array buffer allocation failed') ||
            err.message?.includes('out of memory') || err.message?.includes('OOM') ||
            err.message?.includes('allocation failed');

        // Helper to decode a batch of frames
        async function decodeBatch(start, end) {
            const decodePromises = [];
            for (let i = start; i < end; i++) {
                const frame = frameIndex[i];
                const frameIdx = i;
                decodePromises.push(
                    file.slice(frame.offset, frame.offset + frame.size).arrayBuffer()
                        .then(jpegData => decodeJpegToRgba(new Uint8Array(jpegData), width, height))
                        .then(rgba => ({ data: rgba.data, index: frameIdx, success: true }))
                        .catch(e => {
                            console.warn(`Failed to decode MJPEG frame ${frameIdx}:`, e);
                            return { index: frameIdx, success: false };
                        })
                );
            }
            return Promise.all(decodePromises);
        }

        // Pipeline: start decoding next batch while GPU processes current batch
        let nextDecodePromise = decodeBatch(0, Math.min(effectiveBatchSize, frameCount));
        let batchStart = 0;

        while (batchStart < frameCount) {
            const batchEnd = Math.min(batchStart + effectiveBatchSize, frameCount);

            // Wait for this batch's decode (started in previous iteration or before loop)
            let decodeResults = await nextDecodePromise;
            // Trim if batch size was reduced due to OOM
            if (decodeResults.length > effectiveBatchSize) {
                decodeResults = decodeResults.slice(0, effectiveBatchSize);
            }

            // Immediately start decoding NEXT batch while we process this one on GPU
            const nextBatchStart = batchStart + decodeResults.length;
            if (nextBatchStart < frameCount) {
                const nextBatchEnd = Math.min(nextBatchStart + effectiveBatchSize, frameCount);
                nextDecodePromise = decodeBatch(nextBatchStart, nextBatchEnd);
            } else {
                nextDecodePromise = null;
            }

            // Process decoded frames
            const batchFrames = [];
            const batchIndices = [];
            for (const result of decodeResults) {
                if (result.success) {
                    batchFrames.push({ data: result.data, index: result.index });
                    batchIndices.push(result.index);
                } else {
                    skippedFrames++;
                    completedFrames++;
                }
            }

            if (batchFrames.length === 0) continue;

            try {
                if (cropRegion) {
                    // Combined detect + crop + analyze in ONE GPU pass (same as SER flow)
                    const combinedResults = await detectCropAnalyzeRgbaGpu(
                        batchFrames, width, height, cropRegion.size, 0.1, true
                    );

                    for (let j = 0; j < combinedResults.length; j++) {
                        const gpuResult = combinedResults[j];
                        const frameIdx = batchIndices[j];

                        // Check if bounds were detected
                        if (!gpuResult.bounds) {
                            skippedFrames++;
                            completedFrames++;
                            continue;
                        }

                        // Check for cut-off (crop region would exceed frame bounds) - skip for Sun/Moon
                        if (!surfaceMode) {
                            const halfCrop = cropRegion.size / 2;
                            const cx = gpuResult.centerX;
                            const cy = gpuResult.centerY;
                            if (cx - halfCrop < 0 || cy - halfCrop < 0 ||
                                cx + halfCrop > width || cy + halfCrop > height) {
                                cutOffFrames++;
                                completedFrames++;
                                continue;
                            }
                        }

                        // Check oversized
                        if (cropRegion.medianObjectSize) {
                            const size = Math.max(gpuResult.bounds.width, gpuResult.bounds.height);
                            if (size / cropRegion.medianObjectSize > 1.3) {
                                oversizedFrames++;
                                completedFrames++;
                                continue;
                            }
                        }

                        const center = { x: gpuResult.centerX, y: gpuResult.centerY };
                        frameCenters.set(frameIdx, center);

                        const currentFrame = {
                            sharpness: gpuResult.sharpness,
                            width: cropRegion.size,
                            height: cropRegion.size,
                            index: frameIdx,
                            centerX: center.x,
                            centerY: center.y,
                            circularity: gpuResult.circularity || 0,
                            uint8Buffer: gpuResult.uint8Buffer // For QualitySelector preview
                        };

                        rankFrame(currentFrame);

                        // Create preview blob if this became new best
                        if (bestFrameSoFar === currentFrame && gpuResult.uint8Buffer) {
                            try {
                                const uint8Data = new Uint8ClampedArray(gpuResult.uint8Buffer);
                                const imageData = new ImageData(uint8Data, cropRegion.size, cropRegion.size);
                                const canvas = new OffscreenCanvas(cropRegion.size, cropRegion.size);
                                const ctx = canvas.getContext('2d');
                                ctx.putImageData(imageData, 0, 0);
                                currentFrame.blob = await canvas.convertToBlob({ type: 'image/png' });
                                emit('best-frame-updated', currentFrame);
                            } catch (e) {
                                console.warn('Failed to create preview:', e);
                            }
                        }

                        completedFrames++;
                    }
                } else {
                    // No crop - analyze full frames
                    const results = await analyzeRgbaBatchGpu(batchFrames, width, height);

                    for (let j = 0; j < results.length; j++) {
                        const result = results[j];
                        const frameIdx = batchIndices[j];

                        const currentFrame = {
                            sharpness: result.sharpness || 0,
                            width: width,
                            height: height,
                            index: frameIdx,
                            centerX: width / 2,
                            centerY: height / 2,
                            circularity: result.circularity || 0
                        };

                        frameCenters.set(frameIdx, { x: width / 2, y: height / 2 });
                        rankFrame(currentFrame);
                        completedFrames++;
                    }
                }
            } catch (error) {
                // Check for OOM and retry with smaller batch
                if (isOOMError(error) && batchFrames.length > 1) {
                    const newSize = Math.max(1, Math.floor(batchFrames.length / 2));
                    addLog(`GPU memory error, reducing batch from ${batchFrames.length} to ${newSize}`);
                    effectiveBatchSize = newSize;
                    nextDecodePromise = null; // Cancel pre-fetch
                    continue; // Retry same batch position with smaller size
                }
                addLog(`GPU batch error: ${error.message}`);
                completedFrames += batchFrames.length;
            }

            emit('update-loading', {
                progress: (completedFrames / frameCount) * 100,
                current: completedFrames,
                total: frameCount
            });

            if (bestFrameSoFar && completedFrames % 100 === 0) {
                emit('best-frame-updated', bestFrameSoFar);
            }

            // Move to next batch
            batchStart += decodeResults.length;
        }

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} decode-failed`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Analyzed ${frameCount} MJPEG frames. Valid: ${allAnalyzedFrames.length || bestFramesForStacking.length}${skippedMsg}`);

        // Create frameReReader for two-pass stacking
        const frameReReader = {
            fileType: 'image', // Use 'image' type since MJPEG produces RGBA like images
            file,
            frameIndex, // Still needed for MJPEG - variable frame sizes
            cropRegion,
            srcWidth: width,
            srcHeight: height,

            async getFrame(frameObj) {
                const frameIdx = frameObj.index ?? frameObj;
                const frameInfo = this.frameIndex[frameIdx];
                if (!frameInfo) return null;

                try {
                    const jpegData = await this.file.slice(frameInfo.offset, frameInfo.offset + frameInfo.size).arrayBuffer();
                    const rgba = await decodeJpegToRgba(new Uint8Array(jpegData), this.srcWidth, this.srcHeight);

                    return {
                        data: rgba.data,
                        width: rgba.width,
                        height: rgba.height,
                        centerX: frameObj.centerX,
                        centerY: frameObj.centerY
                    };
                } catch (e) {
                    console.warn(`Failed to re-read MJPEG frame ${frameIdx}:`, e);
                    return null;
                }
            }
        };

        // Manual threshold mode
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} MJPEG frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: null,
                noiseRobustAlignment,
                useWebGPU: true,
                drizzleScale,
                frameReReader
            });
            return;
        }

        // Automatic stacking
        const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, noiseRobustAlignment, true, frameReReader, surfaceMode);

        // Cleanup
        gpuWorker.terminate();
        gpuWorker = null;
        gpuReady = false;

        if (stackResult && stackResult.blob) {
            addLog('MJPEG GPU stacking complete');
            emit('stacked-image-ready', {
                blob: stackResult.blob,
                float32Data: stackResult.float32Data,
                width: stackResult.width,
                height: stackResult.height
            });
        } else {
            addLog('MJPEG stacking failed - no valid frames');
            emit('stack-failed', { component: 'useAviReader', reason: 'MJPEG no valid frames' });
            emit('stop-loading');
        }
    }

    // Quick format check - only parses header, doesn't initialize workers
    async function checkAviFormat(headerBuffer, actualFileSize = null) {
        const aviHeader = await parseFullAviHeader(headerBuffer, actualFileSize);

        if (!aviHeader) {
            return { isEasy: false, isMjpeg: false, fourCC: 'unknown', error: 'Failed to parse header' };
        }

        const isEasy = isEasyAviFourCC(aviHeader.fourCC);
        const isMjpeg = isMjpegFourCC(aviHeader.fourCC);
        return {
            isEasy,
            isMjpeg,
            isSupported: isEasy || isMjpeg,
            fourCC: aviHeader.fourCC,
            width: aviHeader.width,
            height: aviHeader.height,
            frameCount: aviHeader.frameCount,
            aviHeader // Include full header to avoid re-parsing
        };
    }

    /**
     * Process video frames with pipelined extraction + analysis (memory-optimized for Lite mode)
     * Extracts and analyzes frames concurrently - analysis starts as soon as first frames are ready.
     * Uses only 2 workers to minimize memory overhead on mobile devices.
     * @param ffmpeg - FFmpeg instance with video already loaded
     * @param videoFilename - Name of video file in FFmpeg FS
     * @param totalFrames - Total frames to extract (from Lite mode limit)
     * @param videoDuration - Video duration in seconds
     * @param options - Processing options
     */
    async function processBatchedVideoFrames(ffmpeg, videoFilename, totalFrames, videoDuration, options = {}) {
        const {
            preCropRegion = null,
            manualThreshold = false,
            stackPercentage = 30,
            drizzleScale = 1.0,
            noiseRobustAlignment = false,
            surfaceMode = false
        } = options;

        // Reset comparison export captures
        resetCaptures();

        // Lite mode: use only 2 workers to reduce memory pressure
        const LITE_WORKER_COUNT = 2;
        const liteWorkers = [];

        addLog(`Initializing ${LITE_WORKER_COUNT} analysis workers (Lite mode)...`);
        for (let i = 0; i < LITE_WORKER_COUNT; i++) {
            liteWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
        }

        // Initialize workers
        try {
            await Promise.all(liteWorkers.map((worker, i) =>
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error(`Worker ${i} timeout`)), 30000);
                    worker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
                    };
                    worker.postMessage({ type: 'init' });
                })
            ));
            addLog('Workers ready');
        } catch (err) {
            addLog(`Worker init failed: ${err.message}`);
            liteWorkers.forEach(w => w.terminate());
            emit('stop-loading');
            return;
        }

        const bestFramesCapacity = Math.max(1, Math.floor(totalFrames * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null;
        const allAnalyzedFrames = [];
        let minSharpnessInBest = 0;

        const timeStep = videoDuration / totalFrames;
        let frameWidth = 0;
        let frameHeight = 0;
        let cropRegion = null;
        let header = null;

        let extractedCount = 0;
        let analyzedCount = 0;
        let skippedFrames = 0;
        let discardedLowQuality = 0;

        // Queue for frames awaiting analysis
        const analysisQueue = [];
        let analysisInFlight = 0;
        const MAX_IN_FLIGHT = LITE_WORKER_COUNT; // Match worker count

        // Promise that resolves when all analysis is done
        let resolveAllAnalyzed;
        const allAnalyzedPromise = new Promise(r => resolveAllAnalyzed = r);

        // Decode canvas (reused)
        const decodeCanvas = document.createElement('canvas');
        let decodeCtx = null;

        // Helper to rank a frame
        function rankFrame(frame, frameIndex) {
            frame.frameIndex = frameIndex;

            // Use uint8Buffer directly (no conversion needed)
            if (frame.uint8Buffer && frame.width && frame.height) {
                capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frameIndex, totalFrames);
            }

            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            if (bestFrameSoFar === null || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
                emit('best-frame-updated', bestFrameSoFar);
            }

            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
                if (bestFramesForStacking.length === bestFramesCapacity) {
                    minSharpnessInBest = Math.min(...bestFramesForStacking.map(f => f.sharpness));
                }
            } else if (frame.sharpness > minSharpnessInBest) {
                const minIdx = bestFramesForStacking.reduce((minI, f, i, arr) =>
                    f.sharpness < arr[minI].sharpness ? i : minI, 0);
                bestFramesForStacking[minIdx] = frame;
                minSharpnessInBest = Math.min(...bestFramesForStacking.map(f => f.sharpness));
            }
        }

        // Process a single frame through analysis
        async function analyzeFrame(pngData, frameIndex) {
            try {
                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, frameWidth, frameHeight);
                const rgbaBuffer = imageData.data.buffer.slice(0);
                decodeCtx.clearRect(0, 0, frameWidth, frameHeight);

                const workerIndex = frameIndex % LITE_WORKER_COUNT;
                const worker = liteWorkers[workerIndex];

                const result = await processFrameWithWorker(worker, {
                    type: cropRegion ? 'analyze-cropped' : 'avi',
                    frameBuffer: rgbaBuffer,
                    aviHeader: header,
                    header: header,
                    bayerChoice: 'MONO',
                    cropRegion: cropRegion,
                    capturePreCrop: false,
                    index: frameIndex,
                    surfaceMode: surfaceMode
                }, [rgbaBuffer]);

                if (result.skipped) {
                    skippedFrames++;
                    return;
                }

                // Early discard low quality
                if (bestFramesForStacking.length >= bestFramesCapacity &&
                    result.sharpness < minSharpnessInBest) {
                    discardedLowQuality++;
                    return;
                }

                rankFrame({
                    sharpness: result.sharpness,
                    blob: result.pngBlob,
                    uint8Buffer: result.uint8Buffer,        // GPU path
                    float32Buffer: result.float32Buffer,    // CPU fallback path
                    width: result.width,
                    height: result.height,
                    index: result.index,
                    subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                    circularity: result.circularity || 0
                }, result.index);

            } catch (err) {
                skippedFrames++;
                console.error(`Frame ${frameIndex} analysis failed:`, err);
            }
        }

        // Process analysis queue
        async function processQueue() {
            while (analysisQueue.length > 0 && analysisInFlight < MAX_IN_FLIGHT) {
                const { pngData, index } = analysisQueue.shift();
                analysisInFlight++;

                analyzeFrame(pngData, index).finally(() => {
                    analysisInFlight--;
                    analyzedCount++;
                    emit('update-loading', {
                        progress: (analyzedCount / totalFrames) * 100,
                        current: analyzedCount,
                        total: totalFrames
                    });

                    // Check if more to process or if we're done
                    if (analysisQueue.length > 0) {
                        processQueue();
                    } else if (extractedCount >= totalFrames && analysisInFlight === 0) {
                        resolveAllAnalyzed();
                    }
                });
            }
        }

        // Queue a frame for analysis
        function queueForAnalysis(pngData, index) {
            analysisQueue.push({ pngData, index });
            processQueue();
        }

        ffmpeg.setLogger(() => {});
        addLog(`Pipelined extraction: ${totalFrames} frames with ${LITE_WORKER_COUNT} workers`);
        emit('set-caption', 'Extracting and analyzing frames...');

        // Extract frames one at a time, queue for analysis immediately
        for (let i = 0; i < totalFrames; i++) {
            const seekTime = i * timeStep;
            const outFile = `frame_${i}.png`;

            emit('set-caption', `Extracting frame ${i + 1}/${totalFrames}...`);

            try {
                const vfArgs = preCropRegion
                    ? ['-vf', `crop=${preCropRegion.width}:${preCropRegion.height}:${preCropRegion.x}:${preCropRegion.y}`]
                    : [];

                await ffmpeg.run(
                    '-ss', seekTime.toFixed(3),
                    '-i', videoFilename,
                    ...vfArgs,
                    '-vframes', '1',
                    '-y',
                    outFile
                );

                const pngData = ffmpeg.FS('readFile', outFile);
                ffmpeg.FS('unlink', outFile); // Free immediately

                // First frame: get dimensions and detect crop
                if (frameWidth === 0) {
                    const firstBlob = new Blob([pngData], { type: 'image/png' });
                    const firstBitmap = await createImageBitmap(firstBlob);
                    frameWidth = firstBitmap.width;
                    frameHeight = firstBitmap.height;
                    firstBitmap.close();

                    decodeCanvas.width = frameWidth;
                    decodeCanvas.height = frameHeight;
                    decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
                    header = { width: frameWidth, height: frameHeight, fourCC: 'RGBA', bpp: 32 };

                    addLog(`Frame dimensions: ${frameWidth}x${frameHeight}`);

                    // Detect crop from first 5 frames (skip if already pre-cropped)
                    const MIN_SIZE_FOR_CROP = 300;
                    if (!preCropRegion && frameWidth >= MIN_SIZE_FOR_CROP && frameHeight >= MIN_SIZE_FOR_CROP) {
                        emit('set-caption', 'Detecting crop region...');
                        // Extract 4 more frames for crop detection
                        const cropSampleData = [pngData];
                        for (let j = 1; j < 5 && j < totalFrames; j++) {
                            const sampleTime = j * timeStep * 5; // Spread samples
                            const sampleFile = `crop_sample_${j}.png`;
                            try {
                                await ffmpeg.run('-ss', sampleTime.toFixed(3), '-i', videoFilename, ...vfArgs, '-vframes', '1', '-y', sampleFile);
                                cropSampleData.push(ffmpeg.FS('readFile', sampleFile));
                                ffmpeg.FS('unlink', sampleFile);
                            } catch (_) {}
                        }
                        cropRegion = await detectCropRegionFromPngData(cropSampleData, frameWidth, frameHeight);
                        if (cropRegion) {
                            addLog(`Auto-crop: ${cropRegion.size}x${cropRegion.size}`);

                            // Calculate dynamic frame limit based on crop size and platform
                            const { detectPlatform, calculateMaxFrames } = useLiteMemoryLimits();
                            const platform = detectPlatform();
                            const dynamicMaxFrames = calculateMaxFrames(cropRegion.size, platform);
                            if (dynamicMaxFrames < totalFrames) {
                                addLog(`Limiting to ${dynamicMaxFrames} frames (${platform}, crop: ${cropRegion.size}px)`);
                                totalFrames = dynamicMaxFrames;
                            }
                        }
                    }
                }

                extractedCount++;
                queueForAnalysis(pngData, i);

            } catch (e) {
                extractedCount++;
                skippedFrames++;
                try { ffmpeg.FS('unlink', outFile); } catch (_) {}
            }
        }

        // Wait for all analysis to complete
        emit('set-caption', 'Finishing analysis...');
        await allAnalyzedPromise;

        addLog(`Complete. Kept ${bestFramesForStacking.length} best, skipped ${skippedFrames}, discarded ${discardedLowQuality} low-quality`);

        // Free video
        try { ffmpeg.FS('unlink', videoFilename); } catch (_) {}
        addLog('Video freed from memory');

        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: liteWorkers,
                noiseRobustAlignment,
                useWebGPU: false,
                drizzleScale,
                frameReReader: null
            });
            return;
        }

        emit('set-caption', 'Stacking frames...');
        addLog(`Stacking ${bestFramesForStacking.length} frames`);

        const stackResult = await stackFramesLocally(bestFramesForStacking, liteWorkers[0], drizzleScale, noiseRobustAlignment, false, null, surfaceMode);

        liteWorkers.forEach(w => w.terminate());

        if (stackResult) {
            emit('postProcessing', stackResult.blob, stackResult.float32Data, stackResult.width, stackResult.height);
        } else {
            addLog('Stacking failed');
            emit('upload-error', 'Stacking failed. Please try again.');
        }
    }

    /**
     * Detect crop region from PNG data buffers (not files)
     */
    async function detectCropRegionFromPngData(pngDataArray, width, height) {
        const decodeCanvas = document.createElement('canvas');
        decodeCanvas.width = width;
        decodeCanvas.height = height;
        const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

        let maxSize = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (const pngData of pngDataArray) {
            try {
                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, width, height);
                const bounds = detectBrightObject(imageData.data, width, height);

                if (bounds && bounds.width > 0 && bounds.height > 0) {
                    const size = Math.max(bounds.width, bounds.height);
                    if (size > maxSize) maxSize = size;
                    detectedSizes.push(size);
                    detectedCenters.push({
                        x: bounds.x + bounds.width / 2,
                        y: bounds.y + bounds.height / 2
                    });
                }
                decodeCtx.clearRect(0, 0, width, height);
            } catch (e) {}
        }

        if (detectedCenters.length === 0) return null;

        detectedCenters.sort((a, b) => a.x - b.x);
        detectedSizes.sort((a, b) => a - b);

        const medianX = detectedCenters[Math.floor(detectedCenters.length / 2)].x;
        detectedCenters.sort((a, b) => a.y - b.y);
        const medianY = detectedCenters[Math.floor(detectedCenters.length / 2)].y;

        const finalSize = Math.min(Math.ceil(maxSize * 1.2), Math.min(width, height));

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY } };
    }

    /**
     * Simple bright object detection for crop region
     */
    function detectBrightObject(pixels, width, height) {
        let minX = width, maxX = 0, minY = height, maxY = 0;
        let maxBrightness = 0;

        // Find max brightness
        for (let i = 0; i < pixels.length; i += 4) {
            const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
            if (brightness > maxBrightness) maxBrightness = brightness;
        }

        const threshold = maxBrightness * 0.3;

        // Find bounds of bright region
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
                if (brightness > threshold) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (maxX <= minX || maxY <= minY) return null;

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    return { readAviFile, processFFmpegFrames, processBatchedVideoFrames, checkAviFormat };
}
