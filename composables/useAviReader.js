// composables/useAviReader.js

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useLiteMemoryLimits } from '@/composables/useLiteMemoryLimits';
import { useWebGpuAnalyzeWorker } from '@/composables/useWebGpuAnalyzeWorker';

// Import from new parser module
import {
    isEasyAviFourCC,
    isMjpegFourCC,
    isUncompressedBGR,
    is8bitRawFormat,
    flipFrameVertically,
    parseAviFrameIndex,
    parseAviHeader,
    detectBayerFromStrd,
    calculateFrameDataSize,
    // Note: opencvToGpuPattern removed - Bayer processing moved to useDebayerReader
} from '@/composables/useAviParser';

// Note: renderAviFrameToBlob, yuvToRgba, demosaicBayerToRgba, autoStretchRgba
// removed - dead code or now handled by useDebayerReader

export function useAviReader() {
    const { addLog, emit, on } = useEventBus();
    const { stackFramesLocally } = useStacker();
    const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();
    const {
        initializeGpuWorker,
        terminateGpuWorker,
        analyzeRgbaBatchGpu,
        cropAndAnalyzeRgbaGpu,
        detectCropAnalyzeRgbaGpu,
        decodeImageToRgba
    } = useWebGpuAnalyzeWorker();

    const previewCanvas = document.createElement('canvas');

    // Limit workers to prevent OpenCV WASM memory exhaustion
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;
    const recyclingWorkers = new Set(); // Track which workers are currently being recycled
    let cancelled = false;
    let activeLiteWorkers = []; // Track lite workers for cancellation

    // GPU worker state (declared here so cancelProcessing can access them)
    let gpuWorker = null;
    let gpuReady = false;

    // Cancel processing and terminate all workers immediately
    function cancelProcessing() {
        cancelled = true;
        addLog('Cancelling processing...');

        // Terminate all CPU workers
        unifiedAnalyzeWorkers.forEach(worker => {
            try { worker.terminate(); } catch (e) { /* ignore */ }
        });
        unifiedAnalyzeWorkers.length = 0;

        // Terminate lite workers (used in processBatchedVideoFrames)
        activeLiteWorkers.forEach(worker => {
            try { worker.terminate(); } catch (e) { /* ignore */ }
        });
        activeLiteWorkers = [];

        // Terminate GPU worker if exists
        if (gpuWorker) {
            try { gpuWorker.terminate(); } catch (e) { /* ignore */ }
            gpuWorker = null;
            gpuReady = false;
        }

        workersReady = false;
        recyclingWorkers.clear();
        addLog('Processing cancelled, workers terminated');
    }

    // Listen for cancel event from UI
    on('cancel-processing', cancelProcessing);

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
                worker.onerror = (event) => {
                    clearTimeout(timeout);
                    reject(event.error || new Error(event.message || 'Worker initialization error'));
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
                worker.onerror = (event) => {
                    clearTimeout(timeout);
                    reject(event.error || new Error(event.message || 'Worker recycle error'));
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
            newWorker.onerror = (event) => {
                clearTimeout(timeout);
                reject(event.error || new Error(event.message || 'Worker recycle error'));
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

        // Use median size with margin
        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
        const maxAllowedSize = Math.min(aviHeader.width, aviHeader.height);

        // Skip cropping if desired size exceeds frame - let stacking alignment handle centering
        if (desiredSize >= maxAllowedSize) {
            addLog(`Skipping crop: desired ${desiredSize}px exceeds frame ${maxAllowedSize}px. Stacking alignment will handle centering.`);
            return null;
        }

        // Calculate median center position as fallback reference
        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${medianSize}, margin: ${cropMarginPercent}% (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: desiredSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
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
            // Use imported helper for frame size calculation
            let frameDataSize = calculateFrameDataSize(fourCC, width, height, bpp);
            if (frameDataSize === -1) {
                addLog(`FourCC '${fourCC}' is compressed/unsupported for direct rendering.`);
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
            const is8bitRaw = is8bitRawFormat(fourCC, bpp);
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


    async function readAviFile(file, maxFrames = -1, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, useWebGPU = false, preloadedBuffer = null, surfaceMode = false, preParsedHeader = null) {
        // Reset comparison export captures for new processing
        resetCaptures();
        cancelled = false; // Reset cancellation flag for new processing

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
            return await readMjpegAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, surfaceMode);
        }

        // Note: 8-bit raw Bayer (Y800, 8-bit DIB) is now handled by useDebayerReader
        // before reaching this function. See FileUploader.vue routing.

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
        const stackResult = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale, useWebGPU, null, surfaceMode);

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

    // Note: GPU worker functions moved to useWebGpuAnalyzeWorker.js
    // Note: Bayer-related GPU functions moved to useDebayerReader

    // Decode JPEG to RGBA - wrapper around shared decodeImageToRgba
    async function decodeJpegToRgba(jpegData, width, height) {
        return decodeImageToRgba(jpegData, 'image/jpeg');
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

        // Dynamic batch size based on frame dimensions to stay under GPU memory limit
        const frameBytes = width * height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 512 * 1024 * 1024; // 512MB
        const BATCH_SIZE = Math.max(4, Math.min(32, Math.floor(targetBatchMemory / frameBytes)));
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleIndices.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, sampleIndices.length);
            const batch = [];

            // Decode JPEG frames for this batch (parallel file reads)
            const batchIndices = [];
            for (let i = batchStart; i < batchEnd; i++) {
                batchIndices.push(i);
            }
            const jpegBuffers = await Promise.all(
                batchIndices.map(i => {
                    const frameIdx = sampleIndices[i];
                    const frame = frameIndex[frameIdx];
                    return file.slice(frame.offset, frame.offset + frame.size).arrayBuffer();
                })
            );
            // Decode JPEGs (these are CPU-bound, could also parallelize but may not help much)
            for (let j = 0; j < jpegBuffers.length; j++) {
                const frameIdx = sampleIndices[batchIndices[j]];
                try {
                    const rgba = await decodeJpegToRgba(new Uint8Array(jpegBuffers[j]), width, height);
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

        // Skip cropping if desired size exceeds frame - let stacking alignment handle centering
        if (desiredSize >= maxAllowedSize) {
            addLog(`Skipping crop: desired ${desiredSize}px exceeds frame ${maxAllowedSize}px. Stacking alignment will handle centering.`);
            return null;
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${Math.round(medianSize)}, margin: ${cropMarginPercent}%`);

        return { size: desiredSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Note: readRawBayerAviFile removed (~400 lines) - now handled by useDebayerReader.
    // This was the old 8-bit raw Bayer AVI processing path with color profile selector,
    // GPU-based demosaicing, crop detection, and two-pass stacking.
    // See useDebayerReader.js for the new unified implementation.

    // Process MJPEG AVI file with GPU acceleration
    async function readMjpegAviFile(file, aviHeader, maxFrames, manualThreshold, cropMarginPercent, stackPercentage, drizzleScale, surfaceMode = false) {
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
                useWebGPU: true,
                drizzleScale,
                frameReReader
            });
            return;
        }

        // Automatic stacking
        const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, true, frameReReader, surfaceMode);

        // Cleanup
        terminateGpuWorker();

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

    // Note: FFmpeg processing functions moved to useFFmpegReader.js
    return { readAviFile, checkAviFormat };
}
