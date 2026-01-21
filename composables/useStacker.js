import { useEventBus } from '@/composables/eventBus';
import { useComparisonExport } from '@/composables/useComparisonExport';

export function useStacker() {
    const { addLog, emit } = useEventBus();
    const { captureUnstackedImage } = useComparisonExport();

    /**
     * Convert Float32 buffer to Uint8 buffer (for GPU workers that expect Uint8)
     */
    function float32ToUint8(float32Buffer, width, height) {
        const float32Data = new Float32Array(float32Buffer);
        const uint8Data = new Uint8Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            uint8Data[i] = Math.round(float32Data[i] * 255);
        }
        return uint8Data.buffer;
    }

    /**
     * Convert RGBA buffer to grayscale (supports both Float32 and Uint8 input)
     */
    function rgbaToGrayscale(buffer, width, height, isFloat32 = false) {
        const gray = new Uint8Array(width * height);
        if (isFloat32) {
            const rgba = new Float32Array(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    (0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]) * 255
                );
            }
        } else {
            const rgba = new Uint8ClampedArray(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]
                );
            }
        }
        return gray;
    }

    /**
     * Calculate mean brightness of non-black pixels (for normalization)
     * Supports both Float32 (0.0-1.0) and Uint8 (0-255) input
     */
    function calcMeanBrightness(buffer, width, height, isFloat32 = false) {
        let sum = 0;
        let count = 0;
        const step = 8;

        if (isFloat32) {
            const data = new Float32Array(buffer);
            const blackCutoff = 10 / 255; // ~0.04 in float range
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        } else {
            const data = new Uint8Array(buffer);
            const blackCutoff = 10;
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        }
        return count > 0 ? sum / count : (isFloat32 ? 1.0/255 : 1);
    }

    /**
     * Pipelined two-pass GPU stacking
     * Loads frames from file and stacks them concurrently for better performance
     * Instead of: load ALL → then stack ALL
     * Does: load batch → align → stack, while loading next batch
     *
     * Supports both SER files (raw Bayer) and image files (RGBA)
     */
    async function stackWithGpuPipelined(frameMetadata, frameReReader, drizzleScale, addLog, emit) {
        const frameCount = frameMetadata.length;

        // Detect frameReReader type and extract parameters
        const isSerFile = frameReReader.fileType === 'ser' || frameReReader.header;
        const isImageFile = frameReReader.fileType === 'image' || frameReReader.rgbaFrames;

        let cropSize, srcWidth, srcHeight, bayerPattern;

        if (isSerFile) {
            const { header, bayerChoice, cropRegion } = frameReReader;
            cropSize = cropRegion?.size || header.width;
            srcWidth = header.width;
            srcHeight = header.height;

            // Map bayer choice to GPU pattern
            const bayerMap = {
                'COLOR_BayerBG2RGB': 0, 'COLOR_BayerGB2RGB': 1,
                'COLOR_BayerRG2RGB': 2, 'COLOR_BayerGR2RGB': 3,
                'COLOR_BayerBG2RGB_VNG': 0, 'COLOR_BayerGB2RGB_VNG': 1,
                'COLOR_BayerRG2RGB_VNG': 2, 'COLOR_BayerGR2RGB_VNG': 3,
                'MONO': -1
            };
            bayerPattern = bayerMap[bayerChoice] ?? -1;
        } else if (isImageFile) {
            cropSize = frameReReader.cropRegion?.size || frameReReader.srcWidth;
            srcWidth = frameReReader.srcWidth;
            srcHeight = frameReReader.srcHeight;
            bayerPattern = -1; // RGBA input, no demosaic
        } else {
            throw new Error('Unknown frameReReader type');
        }

        addLog(`Pipelined GPU stacking: ${frameCount} frames, ${cropSize}x${cropSize}`);
        emit('set-caption', 'Initializing GPU workers...');

        // Initialize all workers in parallel
        const gpuAnalyzeWorker = new Worker('/webgpu_analyze_worker.js');
        const cvWorker = new Worker('/unified_analyze_worker.js');
        const gpuStackWorker = new Worker('/webgpu_worker.js');

        try {
            // Init all workers in parallel
            await Promise.all([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU analyze worker timeout')), 30000);
                    gpuAnalyzeWorker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuAnalyzeWorker.postMessage({ type: 'init' });
                }),
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('CV worker timeout')), 30000);
                    cvWorker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
                    };
                    cvWorker.postMessage({ type: 'init' });
                }),
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU stack worker timeout')), 10000);
                    gpuStackWorker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuStackWorker.postMessage({ type: 'init' });
                })
            ]);
            addLog('All workers initialized');

            // Helper to load a batch of frames (SER from file, images from memory)
            async function loadRawBatch(batchFrames) {
                const frames = [];
                const centers = [];

                if (isSerFile) {
                    const { file, frameSize, header } = frameReReader;
                    for (const frame of batchFrames) {
                        const offset = 178 + (frame.index * frameSize);
                        const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                        const data = header.pixelDepth > 8
                            ? new Uint16Array(frameBuffer)
                            : new Uint8Array(frameBuffer);
                        frames.push({ data, index: frame.index });
                        centers.push({ x: frame.centerX, y: frame.centerY });
                    }
                } else if (isImageFile) {
                    for (const frame of batchFrames) {
                        const rgba = frameReReader.rgbaFrames[frame.index];
                        if (rgba) {
                            frames.push({ data: rgba.data, index: frame.index });
                            centers.push({ x: frame.centerX, y: frame.centerY });
                        }
                    }
                }

                return { frames, centers };
            }

            // Helper to process batch via GPU analyze worker
            async function processGpuBatch(frames, centers) {
                return new Promise((resolve, reject) => {
                    const requestId = Date.now() + Math.random();
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
                        threshold: 0.1,
                        requestId,
                        metadataOnly: false // Get float32 data for stacking
                    });
                });
            }

            // Step 1: Find and load reference frame
            emit('set-caption', 'Loading reference frame...');
            const sortedBySharpness = [...frameMetadata].sort((a, b) => b.sharpness - a.sharpness);
            const topCount = Math.max(1, Math.ceil(sortedBySharpness.length * 0.01));
            const topFrames = sortedBySharpness.slice(0, topCount);
            const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

            let refFrameMeta;
            if (avgCircularity > 0.7) {
                refFrameMeta = topFrames.reduce((best, f) =>
                    (f.circularity || 0) > (best.circularity || 0) ? f : best
                );
            } else {
                refFrameMeta = sortedBySharpness[0];
            }

            // Load reference frame
            const { frames: refFrames, centers: refCenters } = await loadRawBatch([refFrameMeta]);
            const refResults = await processGpuBatch(refFrames, refCenters);
            const refFrame = {
                ...refFrameMeta,
                float32Buffer: refResults[0].float32Buffer,
                width: cropSize,
                height: cropSize
            };
            emit('stacking-started', { referenceFrame: refFrame });
            addLog(`Reference frame loaded: index ${refFrame.index}`);

            // Step 2: Prepare alignment points
            emit('set-caption', 'Preparing alignment points...');
            const refFrameData = {
                float32Buffer: refFrame.float32Buffer.slice(0),
                width: cropSize,
                height: cropSize,
                sharpness: refFrame.sharpness
            };

            const alignmentData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Alignment preparation timeout')), 60000);
                cvWorker.onmessage = (e) => {
                    if (e.data.type === 'alignment-prepared') {
                        clearTimeout(timeout);
                        resolve(e.data);
                    } else if (e.data.type === 'prepare-error') {
                        clearTimeout(timeout);
                        reject(new Error(e.data.error));
                    }
                };
                cvWorker.postMessage({ type: 'prepare-alignment', refFrame: refFrameData, refIndex: 0 });
            });

            const { alignmentPoints, refGrayData, patchSize, searchRadius } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs`);

            // Calculate reference brightness for normalization
            const refBrightness = calcMeanBrightness(refFrame.float32Buffer, cropSize, cropSize, true) * 255;

            // Step 3: Initialize GPU stacker
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuStackWorker.removeEventListener('message', handler);
                        resolve();
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({
                    type: 'init-stacking',
                    width: cropSize,
                    height: cropSize,
                    drizzleScale,
                    alignmentPoints,
                    patchSize,
                    refBrightness
                });
            });
            addLog('GPU stacker initialized');

            // Step 4: Process frames in pipelined batches
            emit('set-caption', 'Stacking...');
            const BATCH_SIZE = 32;
            const totalSharpness = frameMetadata.reduce((sum, f) => sum + f.sharpness, 0);
            let processedCount = 0;

            // Pre-load first batch
            let batchStart = 0;
            let nextBatchPromise = null;

            while (batchStart < frameCount) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, frameCount);
                const batchFrames = frameMetadata.slice(batchStart, batchEnd);

                // Get current batch (pre-loaded or load now)
                let rawBatch;
                if (nextBatchPromise) {
                    rawBatch = await nextBatchPromise;
                } else {
                    rawBatch = await loadRawBatch(batchFrames);
                }

                // Start loading next batch while processing current
                const nextStart = batchEnd;
                if (nextStart < frameCount) {
                    const nextEnd = Math.min(nextStart + BATCH_SIZE, frameCount);
                    const nextFrames = frameMetadata.slice(nextStart, nextEnd);
                    nextBatchPromise = loadRawBatch(nextFrames);
                } else {
                    nextBatchPromise = null;
                }

                // Process current batch via GPU (demosaic + crop)
                const gpuResults = await processGpuBatch(rawBatch.frames, rawBatch.centers);

                // Calculate shifts for batch via GPU template matching
                const frameGrayDatas = gpuResults.map(r =>
                    rgbaToGrayscale(r.float32Buffer, cropSize, cropSize, true)
                );

                const batchShifts = await new Promise((resolve, reject) => {
                    const requestId = batchStart;
                    const handler = (e) => {
                        if (e.data.requestId !== requestId) return;
                        gpuStackWorker.removeEventListener('message', handler);
                        if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                        else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                    };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'match-templates-batch',
                        requestId,
                        refGrayData,
                        frameGrayDatas,
                        width: cropSize,
                        height: cropSize,
                        alignmentPoints,
                        patchSize,
                        searchRadius
                    });
                });

                // Send batch to GPU stacker
                const batchForStacker = gpuResults.map((r, i) => ({
                    rgbaBuffer: float32ToUint8(r.float32Buffer, cropSize, cropSize),
                    sharpness: batchFrames[i].sharpness
                }));
                const batchWeights = batchFrames.map(f => f.sharpness / totalSharpness * frameCount);

                await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'stack-batch-done') {
                            gpuStackWorker.removeEventListener('message', handler);
                            resolve();
                        } else if (e.data.type === 'stack-frame-error') {
                            gpuStackWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'stack-frame-batch',
                        frames: batchForStacker,
                        shifts: batchShifts,
                        frameWeights: batchWeights
                    });
                });

                processedCount += batchFrames.length;
                const progress = (processedCount / frameCount) * 90;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: processedCount, total: frameCount });

                batchStart = batchEnd;
            }

            // Step 5: Finalize stacking
            emit('set-caption', 'Finalizing...');
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuStackWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({ type: 'finalize-stacking' });
            });

            // Cleanup
            gpuStackWorker.postMessage({ type: 'cleanup' });
            gpuAnalyzeWorker.terminate();
            cvWorker.terminate();
            gpuStackWorker.terminate();

            addLog(`Stacking complete: ${result.width}x${result.height}`);
            emit('set-caption', 'Stacking complete');

            captureUnstackedImage(result.blob);

            return {
                blob: result.blob,
                float32Data: result.float32Buffer ? new Float32Array(result.float32Buffer) : null,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            gpuAnalyzeWorker.terminate();
            cvWorker.terminate();
            gpuStackWorker.terminate();
            addLog(`Pipelined stacking error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Stack frames using a web worker for local alignment
     * @param frames - Array of frame objects with float32Buffer (or rgbaBuffer for legacy), width, height, sharpness
     *                 For two-pass mode: frames may have only metadata (sharpness, centerX, centerY) with no buffer
     * @param existingWorker - Optional: reuse an existing initialized worker
     * @param drizzleScale - Output scale factor (1.0 = normal, 1.5 = drizzle)
     * @param noiseRobustAlignment - Enable noise-robust alignment
     * @param useWebGPU - Use WebGPU for stacking
     * @param frameReReader - Optional: two-pass mode - re-read frames on demand instead of using pre-loaded buffers
     */
    async function stackFramesLocally(frames, existingWorker = null, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false, frameReReader = null) {
        emit('set-caption', 'Preparing for stacking...');
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        // TWO-PASS MODE: If frameReReader is provided and frames don't have buffers,
        // use pipelined stacking (load + stack concurrently)
        const hasTwoPassFrames = frames.length > 0 && !frames[0].float32Buffer && !frames[0].rgbaBuffer && frameReReader;

        if (hasTwoPassFrames && useWebGPU) {
            // Use pipelined approach: load batch → align → stack, while loading next batch
            return await stackWithGpuPipelined(frames, frameReReader, drizzleScale, addLog, emit);
        }

        // Filter frames that have valid buffer (float32Buffer preferred, rgbaBuffer for legacy) and sharpness
        // DEBUG: Log filtering stats
        const noBuffer = frames.filter(f => !f.float32Buffer && !f.rgbaBuffer).length;
        const noWidth = frames.filter(f => !f.width).length;
        const noHeight = frames.filter(f => !f.height).length;
        const noSharpness = frames.filter(f => !f.sharpness || f.sharpness <= 0).length;
        addLog(`Stacker input: ${frames.length} frames, filtering: noBuffer=${noBuffer}, noWidth=${noWidth}, noHeight=${noHeight}, noSharpness=${noSharpness}`);

        const validFrames = frames.filter(f => (f.float32Buffer || f.rgbaBuffer) && f.width && f.height && f.sharpness > 0);
        addLog(`Stacker: ${validFrames.length} valid frames after filtering`);

        if (validFrames.length === 0) {
            addLog('No valid frames with RGBA data for stacking');
            return null;
        }

        // Select reference frame: for round planets, pick most circular from top 1% sharpest
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);

        // Take top 1% of frames (minimum 1)
        const topCount = Math.max(1, Math.ceil(sortedFrames.length * 0.01));
        const topFrames = sortedFrames.slice(0, topCount);

        // Calculate average circularity to detect planet type
        const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

        let referenceFrame;
        if (avgCircularity > 0.7) {
            // Round planet (Jupiter, Mars, etc.) - pick most circular from top frames
            referenceFrame = topFrames.reduce((best, f) =>
                (f.circularity || 0) > (best.circularity || 0) ? f : best
            );
            addLog(`Round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting most circular reference frame`);
        } else {
            // Non-round (Saturn) or unclear - stick with sharpest
            referenceFrame = sortedFrames[0];
            addLog(`Non-round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting sharpest reference frame`);
        }
        emit('stacking-started', { referenceFrame });

        const drizzleStr = drizzleScale > 1 ? ` with ${drizzleScale}x drizzle` : '';
        addLog(`Sending ${validFrames.length} frames to stacking worker${drizzleStr}${useWebGPU ? ' (WebGPU)' : ''}`);

        // Prepare frame data - only include cloneable/transferable properties
        // Use float32Buffer (16-bit path) if available, otherwise fall back to rgbaBuffer (8-bit legacy)
        const frameData = [];
        for (let i = 0; i < validFrames.length; i++) {
            const f = validFrames[i];
            const isFloat32 = !!f.float32Buffer;
            let buffer = f.float32Buffer || f.rgbaBuffer;
            if (buffer && !(buffer instanceof ArrayBuffer)) {
                if (buffer.buffer instanceof ArrayBuffer) {
                    buffer = buffer.buffer;
                } else {
                    console.warn(`Frame ${i}: buffer is not an ArrayBuffer, skipping`);
                    continue;
                }
            }
            if (!buffer || buffer.byteLength === 0) {
                console.warn(`Frame ${i}: buffer is empty or detached, skipping`);
                continue;
            }
            frameData.push({
                float32Buffer: isFloat32 ? buffer : null,
                rgbaBuffer: isFloat32 ? null : buffer,
                isFloat32,
                width: f.width,
                height: f.height,
                sharpness: f.sharpness,
                subPixelOffset: { x: f.subPixelOffset?.x || 0, y: f.subPixelOffset?.y || 0 }
            });
        }

        if (frameData.length === 0) {
            addLog('Error: No valid frame buffers for stacking');
            return null;
        }
        addLog(`Prepared ${frameData.length} frames for stacking`);

        // Emit frame data for AVI export BEFORE transfer
        // AVI export needs Uint8 data, so convert Float32 if needed
        if (frameData.length <= 500) {
            const aviFrameData = frameData.map(f => {
                let rgbaBuffer = null;
                if (f.isFloat32 && f.float32Buffer) {
                    // Convert Float32 to Uint8 for AVI export
                    rgbaBuffer = float32ToUint8(f.float32Buffer, f.width, f.height);
                } else if (f.rgbaBuffer instanceof ArrayBuffer) {
                    rgbaBuffer = f.rgbaBuffer.slice(0);
                }
                return { rgbaBuffer, width: f.width, height: f.height };
            }).filter(f => f.rgbaBuffer !== null);
            emit('cropped-avi-ready', {
                frames: aviFrameData,
                width: frameData[0].width,
                height: frameData[0].height,
                frameCount: aviFrameData.length
            });
            addLog(`AVI export data ready: ${aviFrameData.length} frames`);
        } else {
            addLog(`Skipping AVI export for ${frameData.length} frames (memory optimization)`);
        }

        // WebGPU path: orchestrate GPU worker directly from main thread
        if (useWebGPU) {
            return await stackWithWebGPU(frameData, drizzleScale, addLog, emit);
        }

        // CPU path: send everything to unified_analyze_worker
        return await stackWithCPU(frameData, drizzleScale, noiseRobustAlignment, addLog, emit);
    }

    /**
     * Stack using WebGPU for template matching (main thread orchestrates)
     */
    async function stackWithWebGPU(frameData, drizzleScale, addLog, emit) {
        const { width, height } = frameData[0];

        // Step 1: Initialize OpenCV worker and prepare alignment data
        addLog('Initializing workers...');
        emit('set-caption', 'Initializing workers...');

        const cvWorker = new Worker('/unified_analyze_worker.js');
        const gpuWorker = new Worker('/webgpu_worker.js');

        try {
            // Init OpenCV worker
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('OpenCV worker timeout')), 30000);
                cvWorker.onmessage = (e) => {
                    if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                    else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
                };
                cvWorker.postMessage({ type: 'init' });
            });
            addLog('OpenCV worker ready');

            // Init WebGPU worker
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebGPU worker timeout')), 10000);
                gpuWorker.onmessage = (e) => {
                    if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                    else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                };
                gpuWorker.postMessage({ type: 'init' });
            });
            addLog('WebGPU worker ready');

            // Step 2: Get alignment points and reference grayscale from OpenCV worker
            emit('set-caption', 'Preparing alignment points...');

            // Find reference frame (highest sharpness) - only send this one frame
            const refIndex = frameData.reduce((bestIdx, f, idx, arr) =>
                f.sharpness > arr[bestIdx].sharpness ? idx : bestIdx, 0);
            const refFrame = frameData[refIndex];

            // Only clone the reference frame buffer for alignment preparation
            // Worker expects float32Buffer and converts internally
            let refBuffer;
            if (refFrame.isFloat32 && refFrame.float32Buffer) {
                refBuffer = refFrame.float32Buffer.slice(0);
            } else if (refFrame.rgbaBuffer) {
                // Convert Uint8 to Float32 for the worker
                const uint8Data = new Uint8Array(refFrame.rgbaBuffer);
                const float32Data = new Float32Array(uint8Data.length);
                for (let i = 0; i < uint8Data.length; i++) {
                    float32Data[i] = uint8Data[i] / 255.0;
                }
                refBuffer = float32Data.buffer;
            } else {
                throw new Error('Reference frame has no valid buffer');
            }
            const refFrameData = {
                float32Buffer: refBuffer,
                width: refFrame.width,
                height: refFrame.height,
                sharpness: refFrame.sharpness
            };

            const alignmentData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Alignment preparation timeout')), 60000);
                cvWorker.onmessage = (e) => {
                    if (e.data.type === 'alignment-prepared') {
                        clearTimeout(timeout);
                        resolve(e.data);
                    } else if (e.data.type === 'prepare-error') {
                        clearTimeout(timeout);
                        reject(new Error(e.data.error));
                    }
                };
                cvWorker.postMessage({ type: 'prepare-alignment', refFrame: refFrameData, refIndex });
            });

            const { alignmentPoints, refGrayData, patchSize, searchRadius } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs, reference frame ${refIndex}`);

            // Step 3: Run template matching on GPU in batches
            emit('set-caption', 'GPU template matching...');
            const frameCount = frameData.length;
            const frameShifts = new Array(frameCount);

            // Calculate batch size based on frame size and memory limits
            // Each frame needs width*height*4 bytes for grayscale float data
            const frameBytes = width * height * 4;
            const maxBatchMemory = 256 * 1024 * 1024; // 256MB for frame data
            const batchSize = Math.min(64, Math.max(8, Math.floor(maxBatchMemory / frameBytes)));
            addLog(`Using batch size ${batchSize} for GPU template matching`);

            // Pre-fill reference frame with zero shifts
            frameShifts[refIndex] = alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));

            // Build list of frames to process (excluding reference)
            const framesToProcess = [];
            for (let f = 0; f < frameCount; f++) {
                if (f !== refIndex) {
                    framesToProcess.push(f);
                }
            }

            // Process in batches
            let processedCount = 0;
            for (let batchStart = 0; batchStart < framesToProcess.length; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, framesToProcess.length);
                const batchIndices = framesToProcess.slice(batchStart, batchEnd);

                // Convert batch frames to grayscale (handle both Float32 and Uint8)
                const frameGrayDatas = batchIndices.map(f => {
                    const frame = frameData[f];
                    const buffer = frame.isFloat32 ? frame.float32Buffer : frame.rgbaBuffer;
                    return rgbaToGrayscale(buffer, width, height, frame.isFloat32);
                });

                // Send batch to GPU
                const batchShifts = await new Promise((resolve, reject) => {
                    const requestId = batchStart;
                    const handler = (e) => {
                        if (e.data.requestId !== requestId) return;
                        gpuWorker.removeEventListener('message', handler);
                        if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                        else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'match-templates-batch',
                        requestId,
                        refGrayData,
                        frameGrayDatas,
                        width,
                        height,
                        alignmentPoints,
                        patchSize,
                        searchRadius
                    });
                });

                // Store results at correct indices
                for (let i = 0; i < batchIndices.length; i++) {
                    frameShifts[batchIndices[i]] = batchShifts[i];
                }

                processedCount += batchIndices.length;
                const progress = 5 + (processedCount / framesToProcess.length) * 45;
                emit('set-caption', `Aligning frames ${processedCount}/${framesToProcess.length} (GPU batch)...`);
                emit('update-loading', { progress, current: Math.round(progress), total: 100 });
            }

            addLog('GPU batch alignment complete');

            // Step 4: GPU Stacking - stream frames in batches to avoid memory issues
            emit('set-caption', 'GPU stacking...');
            addLog('Starting GPU stacking');

            // Calculate total sharpness for weighting
            const totalSharpness = frameData.reduce((sum, f) => sum + f.sharpness, 0);

            // Calculate reference brightness (refFrame already defined above, handle Float32)
            // GPU worker's calcMeanBrightness uses Uint8 (0-255 range), so we need to match that
            const refFrameForBrightness = frameData[refIndex];
            const refBrightnessBuffer = refFrameForBrightness.isFloat32 ? refFrameForBrightness.float32Buffer : refFrameForBrightness.rgbaBuffer;
            let refBrightness = calcMeanBrightness(refBrightnessBuffer, width, height, refFrameForBrightness.isFloat32);
            // Convert to 0-255 range if calculated from Float32 data (0-1 range)
            if (refFrameForBrightness.isFloat32) {
                refBrightness *= 255;
            }

            // Initialize stacking
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({
                    type: 'init-stacking',
                    width, height, drizzleScale, alignmentPoints, patchSize, refBrightness
                });
            });

            // Stream frames in batches
            const stackBatchSize = 20;
            let stackedCount = 0;

            for (let batchStart = 0; batchStart < frameCount; batchStart += stackBatchSize) {
                const batchEnd = Math.min(batchStart + stackBatchSize, frameCount);

                const batchFrames = [];
                const batchShifts = [];
                const batchWeights = [];

                for (let i = batchStart; i < batchEnd; i++) {
                    const frame = frameData[i];
                    // GPU worker expects Uint8 rgbaBuffer, convert Float32 if needed
                    let rgbaBuffer;
                    if (frame.isFloat32 && frame.float32Buffer) {
                        rgbaBuffer = float32ToUint8(frame.float32Buffer, frame.width, frame.height);
                    } else {
                        rgbaBuffer = frame.rgbaBuffer;
                    }
                    batchFrames.push({
                        rgbaBuffer,
                        sharpness: frame.sharpness
                    });
                    batchShifts.push(frameShifts[i]);
                    batchWeights.push(frame.sharpness / totalSharpness * frameCount);
                }

                await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'stack-batch-done') {
                            gpuWorker.removeEventListener('message', handler);
                            resolve();
                        } else if (e.data.type === 'stack-frame-error') {
                            gpuWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'stack-frame-batch',
                        frames: batchFrames,
                        shifts: batchShifts,
                        frameWeights: batchWeights
                    });
                });

                stackedCount = batchEnd;
                const progress = 50 + (stackedCount / frameCount) * 40;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: stackedCount, total: frameCount });
            }

            addLog('GPU stacking complete, finalizing...');

            // Finalize and get result
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({ type: 'finalize-stacking' });
            });

            // Cleanup and terminate
            gpuWorker.postMessage({ type: 'cleanup' });
            gpuWorker.terminate();
            cvWorker.terminate();

            addLog(`Stacked image: ${result.width}x${result.height}, ${(result.blob.size / 1024).toFixed(1)} KB`);
            emit('set-caption', 'Stacking complete');

            // Capture unstacked image for comparison export
            captureUnstackedImage(result.blob);

            // Reconstruct Float32Array from transferred buffer
            const float32Data = result.float32Buffer ? new Float32Array(result.float32Buffer) : null;

            // Return full object with blob and float32Data for 16-bit post-processing
            return {
                blob: result.blob,
                float32Data,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            cvWorker.terminate();
            gpuWorker.terminate();
            throw error;
        }
    }

    /**
     * Stack using CPU (OpenCV) for template matching
     */
    async function stackWithCPU(frameData, drizzleScale, noiseRobustAlignment, addLog, emit) {
        return new Promise((resolve, reject) => {
            addLog('Creating fresh worker for stacking...');
            const worker = new Worker('/unified_analyze_worker.js');

            const initHandler = (e) => {
                if (e.data.type === 'ready') {
                    addLog('Fresh stacking worker ready');
                    worker.removeEventListener('message', initHandler);
                    proceedWithStacking();
                } else if (e.data.type === 'error') {
                    addLog(`Fresh worker init error: ${e.data.message}`);
                    worker.removeEventListener('message', initHandler);
                    reject(new Error('Failed to initialize stacking worker'));
                }
            };
            worker.addEventListener('message', initHandler);
            worker.postMessage({ type: 'init' });

            function proceedWithStacking() {
                let lastLoggedStage = '';
                const messageHandler = (e) => {
                    const { type } = e.data;

                    if (type === 'stack-progress') {
                        emit('set-caption', e.data.stage);
                        emit('update-loading', {
                            progress: e.data.progress,
                            current: Math.round(e.data.progress),
                            total: 100
                        });
                        const stage = e.data.stage;
                        const stagePrefix = stage.replace(/\d+\/\d+/, '').trim();
                        if (stagePrefix !== lastLoggedStage) {
                            lastLoggedStage = stagePrefix;
                            addLog(stage);
                        }
                    }

                    if (type === 'stack-complete') {
                        const { blob, width, height, float32Buffer } = e.data;
                        addLog(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);
                        emit('set-caption', 'Stacking complete');

                        // Capture unstacked image for comparison export
                        captureUnstackedImage(blob);

                        // Reconstruct Float32Array from transferred buffer
                        const float32Data = float32Buffer ? new Float32Array(float32Buffer) : null;

                        worker.removeEventListener('message', messageHandler);
                        worker.terminate();
                        // Return object with blob and float32Data for 16-bit post-processing
                        resolve({ blob, float32Data, width, height });
                    }

                    if (type === 'stack-error') {
                        addLog(`Stacking error: ${e.data.error}`);
                        emit('set-caption', 'Stacking failed');
                        worker.removeEventListener('message', messageHandler);
                        worker.terminate();
                        reject(new Error(e.data.error));
                    }
                };

                worker.addEventListener('message', messageHandler);

                // Use Set to deduplicate - same buffer may be referenced by multiple frames
                // Include both float32Buffer and rgbaBuffer for hybrid mode
                const transferables = [...new Set(
                    frameData.flatMap(f => [f.float32Buffer, f.rgbaBuffer]).filter(b => b instanceof ArrayBuffer && b.byteLength > 0)
                )];
                worker.postMessage({
                    type: 'stack-frames',
                    frames: frameData,
                    drizzleScale: drizzleScale,
                    noiseRobustAlignment: noiseRobustAlignment
                }, transferables);
            }
        });
    }

    return { stackFramesLocally };
}
