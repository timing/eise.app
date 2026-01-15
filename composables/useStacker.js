import { useEventBus } from '@/composables/eventBus';

export function useStacker() {
    const { addLog, emit } = useEventBus();

    /**
     * Convert RGBA buffer to grayscale
     */
    function rgbaToGrayscale(rgbaBuffer, width, height) {
        const gray = new Uint8Array(width * height);
        const rgba = new Uint8ClampedArray(rgbaBuffer);
        for (let i = 0; i < width * height; i++) {
            gray[i] = Math.round(
                0.299 * rgba[i * 4] +
                0.587 * rgba[i * 4 + 1] +
                0.114 * rgba[i * 4 + 2]
            );
        }
        return gray;
    }

    /**
     * Calculate mean brightness of non-black pixels (for normalization)
     */
    function calcMeanBrightness(rgbaBuffer, width, height) {
        const data = new Uint8Array(rgbaBuffer);
        const blackCutoff = 10;
        let sum = 0;
        let count = 0;
        const step = 8;

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
        return count > 0 ? sum / count : 1;
    }

    /**
     * Stack frames using a web worker for local alignment
     * @param frames - Array of frame objects with rgbaBuffer, width, height, sharpness
     * @param existingWorker - Optional: reuse an existing initialized worker
     * @param drizzleScale - Output scale factor (1.0 = normal, 1.5 = drizzle)
     */
    async function stackFramesLocally(frames, existingWorker = null, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false) {
        emit('set-caption', 'Preparing for stacking...');
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        // Filter frames that have valid rgbaBuffer and sharpness
        const validFrames = frames.filter(f => f.rgbaBuffer && f.width && f.height && f.sharpness > 0);

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
        const frameData = [];
        for (let i = 0; i < validFrames.length; i++) {
            const f = validFrames[i];
            let buffer = f.rgbaBuffer;
            if (buffer && !(buffer instanceof ArrayBuffer)) {
                if (buffer.buffer instanceof ArrayBuffer) {
                    buffer = buffer.buffer;
                } else {
                    console.warn(`Frame ${i}: rgbaBuffer is not an ArrayBuffer, skipping`);
                    continue;
                }
            }
            if (!buffer || buffer.byteLength === 0) {
                console.warn(`Frame ${i}: rgbaBuffer is empty or detached, skipping`);
                continue;
            }
            frameData.push({
                rgbaBuffer: buffer,
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
        if (frameData.length <= 500) {
            const aviFrameData = frameData.map(f => ({
                rgbaBuffer: f.rgbaBuffer instanceof ArrayBuffer ? f.rgbaBuffer.slice(0) : null,
                width: f.width,
                height: f.height
            })).filter(f => f.rgbaBuffer !== null);
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
            const refFrameData = {
                rgbaBuffer: refFrame.rgbaBuffer.slice(0),
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

                // Convert batch frames to grayscale
                const frameGrayDatas = batchIndices.map(f =>
                    rgbaToGrayscale(frameData[f].rgbaBuffer, width, height)
                );

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

            // Calculate reference brightness (refFrame already defined above)
            const refBrightness = calcMeanBrightness(frameData[refIndex].rgbaBuffer, width, height);

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
                    batchFrames.push({
                        rgbaBuffer: frameData[i].rgbaBuffer,
                        sharpness: frameData[i].sharpness
                    });
                    batchShifts.push(frameShifts[i]);
                    batchWeights.push(frameData[i].sharpness / totalSharpness * frameCount);
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
                emit('set-caption', `GPU stacking frame ${stackedCount}/${frameCount}...`);
                emit('update-loading', { progress, current: Math.round(progress), total: 100 });
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
            return result.blob;

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
                        const { blob, width, height } = e.data;
                        addLog(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);
                        emit('set-caption', 'Stacking complete');
                        worker.removeEventListener('message', messageHandler);
                        worker.terminate();
                        resolve(blob);
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
                const transferables = [...new Set(
                    frameData.map(f => f.rgbaBuffer).filter(b => b instanceof ArrayBuffer && b.byteLength > 0)
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
