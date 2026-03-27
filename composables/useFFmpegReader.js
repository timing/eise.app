// composables/useFFmpegReader.js
// Handles all FFmpeg-based video processing (mp4, mov, webm, unsupported AVI codecs)

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useLiteMemoryLimits } from '@/composables/useLiteMemoryLimits';
import { reportError } from '@/composables/useSentryReporting';
import { useWebGpuAnalyzeWorker } from '@/composables/useWebGpuAnalyzeWorker';

export function useFFmpegReader() {
    const { addLog, emit, on } = useEventBus();
    const { stackFramesLocally } = useStacker();
    const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();
    const {
        initializeGpuWorker,
        terminateGpuWorker,
        analyzeRgbaBatchGpu,
        detectCropAnalyzeRgbaGpu,
        decodeImageToRgba
    } = useWebGpuAnalyzeWorker();

    // Worker pool for CPU-based frame analysis
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    let unifiedAnalyzeWorkers = [];
    let workersReady = false;
    const recyclingWorkers = new Set();
    let cancelled = false;
    let activeLiteWorkers = []; // Track lite workers for cancellation

    // Cancel processing and terminate all workers
    function cancelProcessing() {
        cancelled = true;
        addLog('Cancelling FFmpeg processing...');

        // Terminate all CPU workers
        unifiedAnalyzeWorkers.forEach(worker => {
            try { worker.terminate(); } catch (e) { /* ignore */ }
        });
        unifiedAnalyzeWorkers = [];

        // Terminate lite workers
        activeLiteWorkers.forEach(worker => {
            try { worker.terminate(); } catch (e) { /* ignore */ }
        });
        activeLiteWorkers = [];

        // Terminate GPU worker
        terminateGpuWorker();

        workersReady = false;
        recyclingWorkers.clear();
        addLog('FFmpeg workers terminated');
    }

    // Listen for cancel event from UI
    on('cancel-processing', cancelProcessing);

    // Initialize analysis workers
    async function initializeWorkers() {
        if (workersReady) return;
        addLog("Initializing analysis workers...");

        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
        }

        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
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
            reportError(error, { component: 'useFFmpegReader', action: 'initializeWorkers' });
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    // Recycle a single worker (on heap corruption)
    async function recycleSingleWorker(workerIndex) {
        if (recyclingWorkers.has(workerIndex)) return;
        recyclingWorkers.add(workerIndex);

        try {
            const oldWorker = unifiedAnalyzeWorkers[workerIndex];
            if (oldWorker) oldWorker.terminate();

            const newWorker = new Worker(workerUrl('/unified_analyze_worker.js'));
            unifiedAnalyzeWorkers[workerIndex] = newWorker;

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Recycle timeout')), 30000);
                newWorker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        newWorker.onmessage = null;
                        resolve();
                    }
                };
                newWorker.postMessage({ type: 'init' });
            });
        } finally {
            recyclingWorkers.delete(workerIndex);
        }
    }

    // Detect WASM heap corruption from error messages
    function isHeapCorruptionError(error) {
        const msg = error?.message || String(error);
        const match = msg.match(/OpenCV error code:\s*(\d+)/);
        if (match) {
            const code = parseInt(match[1], 10);
            return code > 10000; // Valid codes are < 100, garbage values are huge
        }
        return false;
    }

    // Force immediate worker recycle due to heap corruption
    function forceWorkerRecycle(workerIndex) {
        if (recyclingWorkers.has(workerIndex)) return;
        console.warn(`Forcing immediate recycle of worker ${workerIndex} due to heap corruption`);
        recycleSingleWorker(workerIndex).catch(err => {
            console.error(`Failed to force recycle worker ${workerIndex}:`, err);
        });
    }

    // Process a single frame through a worker
    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                reject(new Error(`Worker timeout for frame ${data.index}`));
            }, 30000);

            const messageHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                if (e.data.error) {
                    reject(e.data.error);
                } else if (e.data.type === 'bounds') {
                    resolve({ type: 'bounds', bounds: e.data.bounds, index: e.data.index });
                } else if (e.data.skipped) {
                    resolve({ skipped: true, reason: e.data.reason, index: e.data.index });
                } else {
                    resolve({
                        sharpness: e.data.sharpness,
                        pngBlob: e.data.pngBlob,
                        uint8Buffer: e.data.uint8Buffer,
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

    /**
     * Simple bright object detection for crop region (CPU fallback)
     */
    function detectBrightObject(pixels, width, height) {
        let minX = width, maxX = 0, minY = height, maxY = 0;
        let maxBrightness = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
            if (brightness > maxBrightness) maxBrightness = brightness;
        }

        const threshold = maxBrightness * 0.3;

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

    /**
     * Detect crop region from PNG data buffers (for lite mode)
     */
    async function detectCropRegionFromPngData(pngDataArray, width, height, cropMarginPercent = 10) {
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

        const marginMultiplier = 1 + (cropMarginPercent / 100);
        const desiredSize = Math.ceil(maxSize * marginMultiplier);
        const maxAllowedSize = Math.min(width, height);

        // Skip cropping if desired size exceeds frame - let stacking alignment handle centering
        if (desiredSize >= maxAllowedSize) {
            return null;
        }

        return { size: desiredSize, referenceCenter: { x: medianX, y: medianY } };
    }

    /**
     * Detect crop region from PNG filenames in FFmpeg FS using GPU (for normal mode)
     */
    async function detectCropRegionFromPngs(ffmpeg, pngFilenames, header, cropMarginPercent = 10) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: pngFilenames.length });

        const frameCount = pngFilenames.length;
        // Sample up to 50 frames for crop detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50));
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection (GPU)...`);

        // Dynamic batch size based on frame dimensions to stay under GPU memory limit
        const frameBytes = header.width * header.height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 512 * 1024 * 1024; // 512MB
        const BATCH_SIZE = Math.max(4, Math.min(32, Math.floor(targetBatchMemory / frameBytes)));
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleIndices.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, sampleIndices.length);
            const batch = [];

            // Decode PNG frames for this batch
            for (let i = batchStart; i < batchEnd; i++) {
                const idx = sampleIndices[i];
                try {
                    const pngData = ffmpeg.FS('readFile', pngFilenames[idx]);
                    const rgba = await decodeImageToRgba(pngData);
                    batch.push({ data: rgba.data, index: idx });
                } catch (e) {
                    console.warn(`Failed to decode PNG frame ${idx}:`, e);
                }
            }

            if (batch.length === 0) continue;

            // GPU batch analysis
            const results = await analyzeRgbaBatchGpu(batch, header.width, header.height);

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
        const maxAllowedSize = Math.min(header.width, header.height);

        // Skip cropping if desired size exceeds frame - let stacking alignment handle centering
        if (desiredSize >= maxAllowedSize) {
            addLog(`Skipping crop: desired size ${desiredSize}px exceeds frame ${maxAllowedSize}px. Stacking alignment will handle centering.`);
            return null;
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${Math.round(medianSize)}, margin: ${cropMarginPercent}%`);
        addLog(`Median center: (${Math.round(medianX)}, ${Math.round(medianY)}), frame center: (${Math.round(header.width/2)}, ${Math.round(header.height/2)})`);

        // GPU detection is consistent - medianObjectSize can be used for oversized frame filtering
        return { size: desiredSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    /**
     * Process FFmpeg-extracted PNG frames using GPU (normal mode)
     * Called after FFmpeg has extracted all frames to PNG files
     */
    async function processFFmpegFrames(ffmpeg, pngFilenames, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, useWebGPU = false, surfaceMode = false) {
        resetCaptures();
        cancelled = false; // Reset cancellation flag

        // Initialize GPU worker
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog("GPU worker failed, falling back to CPU workers...");
            // Fall back to CPU path by initializing CPU workers
            await initializeWorkers();
            if (!workersReady) {
                addLog("Both GPU and CPU worker initialization failed.");
                emit('stop-loading');
                return;
            }
        }

        const useGpu = gpuOk;
        addLog(`Processing ${pngFilenames.length} FFmpeg-extracted frames (${useGpu ? 'GPU' : 'CPU'})`);
        emit('set-caption', 'Decoding frames...');

        // Decode first PNG to get dimensions
        const firstPngData = ffmpeg.FS('readFile', pngFilenames[0]);
        const firstRgba = await decodeImageToRgba(firstPngData);
        const width = firstRgba.width;
        const height = firstRgba.height;

        addLog(`Frame dimensions: ${width}x${height}`);

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

        if (useGpu && width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${width}x${height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionFromPngs(ffmpeg, pngFilenames, header, cropMarginPercent);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (!useGpu) {
            addLog(`GPU not available, skipping auto-crop`);
        } else {
            addLog(`Frame size ${width}x${height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null;
        let refCandidateSoFar = null;
        const allAnalyzedFrames = [];
        const frameCenters = new Map(); // For GPU stacking

        function rankFrame(frame) {
            if (frame.uint8Buffer && frame.width && frame.height) {
                capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frame.index, frameCount);
            }

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

        // Dynamic batch size based on frame size
        const frameBytes = width * height * 16; // Float32 RGBA = 16 bytes/pixel
        const targetBatchMemory = 512 * 1024 * 1024; // 512MB
        let effectiveBatchSize = Math.max(4, Math.min(128, Math.floor(targetBatchMemory / frameBytes)));

        // Helper to decode a batch of PNG frames
        async function decodeBatch(start, end) {
            const decodePromises = [];
            for (let i = start; i < end; i++) {
                const frameIdx = i;
                decodePromises.push(
                    (async () => {
                        try {
                            const pngData = ffmpeg.FS('readFile', pngFilenames[frameIdx]);
                            ffmpeg.FS('unlink', pngFilenames[frameIdx]); // Free memory as we go
                            const rgba = await decodeImageToRgba(pngData);
                            return { data: rgba.data, index: frameIdx, success: true };
                        } catch (e) {
                            console.warn(`Failed to decode PNG frame ${frameIdx}:`, e);
                            return { index: frameIdx, success: false };
                        }
                    })()
                );
            }
            return Promise.all(decodePromises);
        }

        // Pipeline: start decoding next batch while GPU processes current batch
        let nextDecodePromise = decodeBatch(0, Math.min(effectiveBatchSize, frameCount));
        let batchStart = 0;

        while (batchStart < frameCount) {
            // Wait for this batch's decode
            let decodeResults = await nextDecodePromise;
            if (decodeResults.length > effectiveBatchSize) {
                decodeResults = decodeResults.slice(0, effectiveBatchSize);
            }

            // Start decoding NEXT batch while processing this one on GPU
            const nextBatchStart = batchStart + decodeResults.length;
            if (nextBatchStart < frameCount) {
                const nextBatchEnd = Math.min(nextBatchStart + effectiveBatchSize, frameCount);
                nextDecodePromise = decodeBatch(nextBatchStart, nextBatchEnd);
            } else {
                nextDecodePromise = Promise.resolve([]);
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

            if (batchFrames.length === 0) {
                batchStart += decodeResults.length;
                continue;
            }

            try {
                if (cropRegion && useGpu) {
                    // Combined detect + crop + analyze in ONE GPU pass
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
                            uint8Buffer: gpuResult.uint8Buffer
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
                    // No crop or CPU fallback - analyze full frames
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
                            circularity: result.circularity || 0,
                            uint8Buffer: result.uint8Buffer
                        };

                        rankFrame(currentFrame);
                        completedFrames++;
                    }
                }
            } catch (error) {
                console.error(`GPU batch processing error:`, error);
                addLog(`GPU error: ${error.message}`);
                // Count all frames in batch as skipped
                skippedFrames += batchFrames.length;
                completedFrames += batchFrames.length;
            }

            batchStart += decodeResults.length;

            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
            if (completedFrames % 50 === 0 || batchStart >= frameCount) {
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
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} skipped`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, cutOff: cutOffFrames, total: frameCount, done: true });

        // Manual threshold: let user select frames
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: null, // GPU path doesn't use CPU workers
                useWebGPU: true,
                drizzleScale,
                frameReReader: null,
                frameCenters: cropRegion ? frameCenters : null
            });
            return;
        }

        // Check for no valid frames
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
                errorMsg = `No valid frames: ${cutOffFrames} cut-off, ${skippedFrames} skipped, ${oversizedFrames} oversized out of ${frameCount} total.`;
            }

            addLog(errorMsg);
            emit('upload-error', errorMsg);
            emit('stack-failed', { component: 'useFFmpegReader', reason: 'no valid frames', details: { cutOffFrames, skippedFrames, oversizedFrames, frameCount } });
            emit('show-error');
            terminateGpuWorker();
            return;
        }

        // Stack frames using WebGPU
        emit('set-caption', 'Stacking frames...');
        addLog(`Starting GPU stacking of ${bestFramesForStacking.length} frames`);

        // For GPU stacking, pass frameCenters if we did cropping
        const stackResult = await stackFramesLocally(
            bestFramesForStacking,
            null, // No CPU worker needed for GPU path
            drizzleScale,
            true, // Always use WebGPU since we're in GPU path
            cropRegion ? frameCenters : null,
            surfaceMode
        );

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
            emit('stack-failed', { component: 'useFFmpegReader', reason: 'stacking returned null' });
            emit('show-error');
        }

        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
    }

    /**
     * Process video frames in batched/streaming mode (lite mode)
     * Extracts frames one at a time to minimize memory usage
     */
    async function processBatchedVideoFrames(ffmpeg, videoFilename, totalFrames, videoDuration, options = {}) {
        const {
            preCropRegion = null,
            manualThreshold = false,
            stackPercentage = 30,
            drizzleScale = 1.0,
            surfaceMode = false,
            cropMarginPercent = 10
        } = options;

        resetCaptures();
        cancelled = false; // Reset cancellation flag

        // Lite mode: use only 2 workers to reduce memory pressure
        const LITE_WORKER_COUNT = 2;
        const liteWorkers = [];
        activeLiteWorkers = liteWorkers; // Track for cancellation

        addLog(`Initializing ${LITE_WORKER_COUNT} analysis workers (Lite mode)...`);
        for (let i = 0; i < LITE_WORKER_COUNT; i++) {
            liteWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
        }

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

        const analysisQueue = [];
        let analysisInFlight = 0;
        const MAX_IN_FLIGHT = LITE_WORKER_COUNT;

        let resolveAllAnalyzed;
        const allAnalyzedPromise = new Promise(r => resolveAllAnalyzed = r);

        const decodeCanvas = document.createElement('canvas');
        let decodeCtx = null;

        function rankFrame(frame, frameIndex) {
            frame.frameIndex = frameIndex;

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

                if (bestFramesForStacking.length >= bestFramesCapacity &&
                    result.sharpness < minSharpnessInBest) {
                    discardedLowQuality++;
                    return;
                }

                rankFrame({
                    sharpness: result.sharpness,
                    blob: result.pngBlob,
                    uint8Buffer: result.uint8Buffer,
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

                    if (analysisQueue.length > 0) {
                        processQueue();
                    } else if (extractedCount >= totalFrames && analysisInFlight === 0) {
                        resolveAllAnalyzed();
                    }
                });
            }
        }

        function queueForAnalysis(pngData, index) {
            analysisQueue.push({ pngData, index });
            processQueue();
        }

        ffmpeg.setLogger(() => {});
        addLog(`Pipelined extraction: ${totalFrames} frames with ${LITE_WORKER_COUNT} workers`);
        emit('set-caption', 'Extracting and analyzing frames...');

        // Extract frames one at a time
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
                ffmpeg.FS('unlink', outFile);

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

                    // Detect crop from first 5 frames
                    const MIN_SIZE_FOR_CROP = 300;
                    if (!preCropRegion && frameWidth >= MIN_SIZE_FOR_CROP && frameHeight >= MIN_SIZE_FOR_CROP) {
                        emit('set-caption', 'Detecting crop region...');
                        const cropSampleData = [pngData];
                        for (let j = 1; j < 5 && j < totalFrames; j++) {
                            const sampleTime = j * timeStep * 5;
                            const sampleFile = `crop_sample_${j}.png`;
                            try {
                                await ffmpeg.run('-ss', sampleTime.toFixed(3), '-i', videoFilename, ...vfArgs, '-vframes', '1', '-y', sampleFile);
                                cropSampleData.push(ffmpeg.FS('readFile', sampleFile));
                                ffmpeg.FS('unlink', sampleFile);
                            } catch (_) {}
                        }
                        cropRegion = await detectCropRegionFromPngData(cropSampleData, frameWidth, frameHeight, cropMarginPercent);
                        if (cropRegion) {
                            addLog(`Auto-crop: ${cropRegion.size}x${cropRegion.size}, margin: ${cropMarginPercent}%`);

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

        emit('set-caption', 'Finishing analysis...');
        await allAnalyzedPromise;

        addLog(`Complete. Kept ${bestFramesForStacking.length} best, skipped ${skippedFrames}, discarded ${discardedLowQuality} low-quality`);

        try { ffmpeg.FS('unlink', videoFilename); } catch (_) {}
        addLog('Video freed from memory');

        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: liteWorkers,
                useWebGPU: false,
                drizzleScale,
                frameReReader: null
            });
            return;
        }

        emit('set-caption', 'Stacking frames...');
        addLog(`Stacking ${bestFramesForStacking.length} frames`);

        const stackResult = await stackFramesLocally(bestFramesForStacking, liteWorkers[0], drizzleScale, false, null, surfaceMode);

        liteWorkers.forEach(w => w.terminate());

        if (stackResult) {
            emit('postProcessing', stackResult.blob, stackResult.float32Data, stackResult.width, stackResult.height);
        } else {
            addLog('Stacking failed');
            emit('upload-error', 'Stacking failed. Please try again.');
        }
    }

    return {
        processFFmpegFrames,
        processBatchedVideoFrames
    };
}
