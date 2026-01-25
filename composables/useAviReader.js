// composables/useAviReader.js

import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';
import { useComparisonExport } from '@/composables/useComparisonExport';

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
 * Parse MJPEG frame index from movi list - builds array of {offset, size} for each frame
 * MJPEG frames have variable sizes, so we need to read chunk headers
 */
async function parseMjpegFrameIndex(file, moviListOffset, moviListSize, maxFrames = -1) {
    const frameIndex = [];
    const chunkHeaderSize = 8; // 4 bytes FourCC + 4 bytes size
    const fileSize = file.size;

    // For large AVI files with AVIX extension, scan entire file instead of just first movi chunk
    // This handles OpenDML/AVI 2.0 files that split data across multiple RIFF chunks
    const scanWholeFile = fileSize > moviListOffset + moviListSize + 1024;

    let position = moviListOffset;
    const scanEnd = scanWholeFile ? fileSize : moviListOffset + moviListSize;

    console.log(`MJPEG parser: scanning from ${position} to ${scanEnd} (fileSize=${fileSize}, scanWholeFile=${scanWholeFile})`);

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

        // Log progress every 1000 frames
        if (frameIndex.length % 1000 === 0 && frameIndex.length > 0) {
            console.log(`MJPEG parser: found ${frameIndex.length} frames so far...`);
        }
    }

    console.log(`MJPEG parser: finished, found ${frameIndex.length} frames`);
    return frameIndex;
}


// Convert raw AVI frame data to RGBA for canvas display - no OpenCV needed
// Supports DIB (BGR24), Y800 (grayscale/Bayer), YUY2/UYVY
async function renderAviFrameToBlob(canvas, frameDataBuffer, aviHeader, fourCC, bayerChoice) {
    const { width, height } = aviHeader;
    const src = new Uint8Array(frameDataBuffer);
    const rgba = new Uint8ClampedArray(width * height * 4);

    // Null fourCC from FFmpeg rawvideo is also uncompressed BGR
    const isUncompressedBGR = fourCC === 'DIB ' || fourCC === 'RGB ' || fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00' || !fourCC;
    if (isUncompressedBGR) {
        // BGR24 → RGBA (swap B and R)
        for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
            rgba[j] = src[i + 2];     // R ← B
            rgba[j + 1] = src[i + 1]; // G
            rgba[j + 2] = src[i];     // B ← R
            rgba[j + 3] = 255;        // A
        }
    } else if (fourCC === 'Y800') {
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
    // Determine pattern: bayerChoice is like 'COLOR_BayerBG2RGB'
    // BG = Blue at (0,0), Green at (0,1) and (1,0), Red at (1,1)
    // RG = Red at (0,0), etc.
    const pattern = bayerChoice.includes('BG') ? 'BGGR' :
                    bayerChoice.includes('GB') ? 'GBRG' :
                    bayerChoice.includes('RG') ? 'RGGB' :
                    bayerChoice.includes('GR') ? 'GRBG' : 'RGGB';

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
    const { uploadFrames } = useUploader();
    const { stackFramesLocally } = useStacker();
    const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();

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
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js'));
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
        const newWorker = new Worker('/unified_analyze_worker.js');
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
                        float32Buffer: e.data.float32Buffer,
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
    async function detectCropRegion(file, aviHeader, frameCount, cropMarginPercent = 10) {
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
            const frameOffset = aviHeader.moviListOffset + i * (frameChunkHeaderSize + frameDataLength + (frameDataLength % 2));
            const frameDataStart = frameOffset + frameChunkHeaderSize;

            if (frameDataStart + frameDataLength > file.size) break;

            await acquireSlot();

            let frameBuffer;
            try {
                frameBuffer = await file.slice(frameDataStart, frameDataStart + frameDataLength).arrayBuffer();
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
    async function parseFullAviHeader(buffer) {
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

                                        if (streamChunkId === 'strh' && streamOffset + 12 <= fileEnd && safeReadFourCC(view, streamOffset + 8) === 'vids') {
                                            videoStreamFound = true;
                                            strhData = { offset: streamOffset + 8, size: streamChunkSize };
                                            addLog("        - Found video 'strh' chunk.");
                                        } else if (streamChunkId === 'strf' && videoStreamFound && !strfData) {
                                            strfData = { offset: streamOffset + 8, size: streamChunkSize };
                                            addLog("        - Found video 'strf' chunk.");
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
            const height = Math.abs(safeGetInt32(view, strfData.offset + 8, true));
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
            }

            let bayerChoice = "MONO";
            if (fourCC === 'Y800' && (width % 2 === 0 && height % 2 === 0)) {
                // Default to RGGB = BG (OpenCV's inverted naming)
                bayerChoice = 'COLOR_BayerBG2RGB';
            }

            const result = { width, height, frameCount, fourCC, frameDataSize, bpp, bayerChoice, moviListOffset, moviListSize };
            addLog(`Final parsed header: ${JSON.stringify(result)}`);
            return result;

        } catch (e) {
            addLog(`[ERROR] in parseFullAviHeader: ${e.message}`);
            console.error("Error parsing full AVI header:", e);
            reportError(e, { component: 'useAviReader', action: 'parseFullAviHeader' });
            return null;
        }
    }


    async function readAviFile(file, maxFrames = -1, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false, preloadedBuffer = null, surfaceMode = false) {
        // Reset comparison export captures for new processing
        resetCaptures();

        emit('start-loading', 'Parsing AVI header...');
        emit('update-loading', 0);

        // Use preloaded buffer if provided, otherwise read from file
        let headerBuffer;
        if (preloadedBuffer) {
            const headerProbeSize = Math.min(preloadedBuffer.byteLength, 1024 * 1024 * 5);
            headerBuffer = preloadedBuffer.buffer.slice(0, headerProbeSize);
        } else {
            const headerProbeSize = Math.min(file.size, 1024 * 1024 * 5);
            headerBuffer = await file.slice(0, headerProbeSize).arrayBuffer();
        }
        const aviHeader = await parseFullAviHeader(headerBuffer);

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

        const frameCount = (maxFrames === -1) ? aviHeader.frameCount : Math.min(aviHeader.frameCount, maxFrames);

        // Determine if we should auto-crop (only for frames larger than minimum)
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (aviHeader.width >= MIN_SIZE_FOR_CROP && aviHeader.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${aviHeader.width}x${aviHeader.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegion(file, aviHeader, frameCount);

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
            // Convert Float32 to Uint8 for video export
            if (frame.float32Buffer && frame.width && frame.height) {
                const float32Data = new Float32Array(frame.float32Buffer);
                const uint8Data = new Uint8ClampedArray(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    uint8Data[i] = Math.round(float32Data[i] * 255);
                }
                capturePostCropFrame(uint8Data.buffer, frame.width, frame.height, frame.index, frameCount);
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

        // Loop through frames from moviListOffset
        let currentMoviOffset = aviHeader.moviListOffset;
        const frameChunkHeaderSize = 8;
        const frameDataLength = aviHeader.frameDataSize;

        for (let i = 0; i < frameCount; i++) {
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors. Check console for details.`);
                break;
            }

            const frameOffset = currentMoviOffset;
            const frameDataStart = frameOffset + frameChunkHeaderSize;

            if (frameDataStart + frameDataLength > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            // Wait for a slot before reading the frame (limits memory usage)
            await acquireSlot();

            let frameBuffer;
            try {
                frameBuffer = await file.slice(frameDataStart, frameDataStart + frameDataLength).arrayBuffer();
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
                        float32Buffer: result.float32Buffer,
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

            currentMoviOffset += frameChunkHeaderSize + frameDataLength;
            if (frameDataLength % 2 !== 0) currentMoviOffset++;
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
                frameReReader: null // AVI frames already have float32Buffer loaded
            });
            return; // Don't terminate workers yet - they'll be used for stacking
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
            addLog('Client-side stacking failed - no valid frames');
            emit('stack-failed', { component: 'useAviReader', reason: 'no valid frames' });
            emit('stop-loading');
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
            // Convert Float32 to Uint8 for video export
            if (frame.float32Buffer && frame.width && frame.height) {
                const float32Data = new Float32Array(frame.float32Buffer);
                const uint8Data = new Uint8ClampedArray(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    uint8Data[i] = Math.round(float32Data[i] * 255);
                }
                capturePostCropFrame(uint8Data.buffer, frame.width, frame.height, frameIndex, frameCount);
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
                            float32Buffer: result.float32Buffer,
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
                frameReReader: null // AVI frames already have float32Buffer loaded
            });
            return; // Don't terminate workers yet - they'll be used for stacking
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
            addLog('Client-side stacking failed - no valid frames');
            emit('stack-failed', { component: 'useAviReader', reason: 'no valid frames (FFmpeg)' });
            emit('stop-loading');
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

        gpuWorker = new Worker('/webgpu_analyze_worker.js');

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
            addLog('GPU worker initialized for MJPEG');
            return true;
        } catch (error) {
            console.error('GPU worker init failed:', error);
            reportError(error, { component: 'useAviReader', action: 'initializeGpuWorker' });
            gpuWorker.terminate();
            gpuWorker = null;
            return false;
        }
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

    // Process MJPEG AVI file with GPU acceleration
    async function readMjpegAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, noiseRobustAlignment, surfaceMode = false) {
        resetCaptures();

        // Initialize GPU worker
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog('GPU not available for MJPEG processing, falling back to FFmpeg');
            return 'fallback';
        }

        // Parse MJPEG frame index
        emit('set-caption', 'Parsing MJPEG frame index...');
        const frameIndex = await parseMjpegFrameIndex(file, aviHeader.moviListOffset, aviHeader.moviListSize, maxFrames);

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

        // Dynamic batch size based on frame dimensions to avoid memory issues
        const frameBytes = width * height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 256 * 1024 * 1024; // 256MB
        const BATCH_SIZE = Math.max(4, Math.min(64, Math.floor(targetBatchMemory / frameBytes)));

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
        let nextDecodePromise = decodeBatch(0, Math.min(BATCH_SIZE, frameCount));

        for (let batchStart = 0; batchStart < frameCount; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, frameCount);

            // Wait for this batch's decode (started in previous iteration or before loop)
            const decodeResults = await nextDecodePromise;

            // Immediately start decoding NEXT batch while we process this one on GPU
            const nextBatchStart = batchStart + BATCH_SIZE;
            if (nextBatchStart < frameCount) {
                const nextBatchEnd = Math.min(nextBatchStart + BATCH_SIZE, frameCount);
                nextDecodePromise = decodeBatch(nextBatchStart, nextBatchEnd);
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
            frameIndex,
            frameCenters,
            cropRegion,
            srcWidth: width,
            srcHeight: height,

            async getFrame(frameIdx) {
                const frame = this.frameIndex[frameIdx];
                if (!frame) return null;

                const center = this.frameCenters.get(frameIdx);
                if (!center) return null;

                try {
                    const jpegData = await this.file.slice(frame.offset, frame.offset + frame.size).arrayBuffer();
                    const rgba = await decodeJpegToRgba(new Uint8Array(jpegData), this.srcWidth, this.srcHeight);

                    return {
                        data: rgba.data,
                        width: rgba.width,
                        height: rgba.height,
                        centerX: center.x,
                        centerY: center.y
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
    async function checkAviFormat(headerBuffer) {
        const aviHeader = await parseFullAviHeader(headerBuffer);

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
            frameCount: aviHeader.frameCount
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
            liteWorkers.push(new Worker('/unified_analyze_worker.js'));
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

            if (frame.float32Buffer && frame.width && frame.height) {
                const float32Data = new Float32Array(frame.float32Buffer);
                const uint8Data = new Uint8ClampedArray(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    uint8Data[i] = Math.round(float32Data[i] * 255);
                }
                capturePostCropFrame(uint8Data.buffer, frame.width, frame.height, frameIndex, totalFrames);
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
                    float32Buffer: result.float32Buffer,
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
