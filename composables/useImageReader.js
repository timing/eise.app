// composables/useImageReader.js

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';

// Native image formats that browsers can decode directly
const NATIVE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

export function useImageReader() {
    const { addLog, emit } = useEventBus();
    const { stackFramesLocally } = useStacker();

    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;

    async function initializeWorkers() {
        if (workersReady) return;
        addLog("Initializing analysis workers...");

        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js'));
        }

        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Worker ${i} initialization timed out.`)), 30000);
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

        try {
            await Promise.all(workerPromises);
            workersReady = true;
            addLog("Analysis workers ready.");
        } catch (error) {
            console.error("Worker initialization failed:", error);
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const messageHandler = (e) => {
                worker.removeEventListener('message', messageHandler);
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
                        index: e.data.index,
                        rgbaBuffer: e.data.rgbaBuffer,
                        width: e.data.width,
                        height: e.data.height,
                        circularity: e.data.circularity || 0
                    });
                }
            };
            const errorHandler = (e) => {
                worker.removeEventListener('error', errorHandler);
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            worker.postMessage(data, transferables);
        });
    }

    // Detect bounds for a sample of images to determine crop region
    async function detectCropRegion(pngDataArray, frameWidth, frameHeight) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: pngDataArray.length });

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(pngDataArray.length / 50));
        const sampleIndices = [];
        for (let i = 0; i < pngDataArray.length; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} images for crop detection...`);

        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = []; // Collect sizes to calculate median for outlier detection
        const boundsPromises = [];

        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];
            const pngData = pngDataArray[i];
            const workerIndex = idx % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const dataToWorker = {
                type: 'detect-bounds-png',
                pngData: pngData.slice(0),
                index: idx
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.pngData.buffer])
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
                    console.error(`Error detecting bounds for sample ${idx}:`, error);
                });

            boundsPromises.push(promise);
        }

        await Promise.all(boundsPromises);

        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} images can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Add 10% margin and round up to even number
        let finalSize = Math.ceil(maxSize * 1.05 / 2) * 2;

        // Limit to frame dimensions
        const maxAllowedSize = Math.min(frameWidth, frameHeight);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        // Calculate median center as fallback reference
        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${sampleIndices.length} images croppable)`);
            return { size: finalSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        // Calculate median size for outlier detection (reject doubled/smeared frames)
        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0;

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${medianSize} (${canCropCount}/${sampleIndices.length} images croppable)`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    // Convert an image file to PNG ArrayBuffer using FFmpeg
    async function convertImageToPng(file, ffmpeg, loadFFmpeg) {
        await loadFFmpeg();

        const { fetchFile } = await import('@ffmpeg/ffmpeg');

        const inputName = `input_${Date.now()}_${file.name}`;
        const outputName = `output_${Date.now()}.png`;

        ffmpeg.FS('writeFile', inputName, await fetchFile(file));
        await ffmpeg.run('-i', inputName, outputName);

        const data = ffmpeg.FS('readFile', outputName);

        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);

        return data;
    }

    // Convert a native format image to PNG ArrayBuffer
    async function nativeImageToPngBuffer(file) {
        // Create an image element to decode the image
        const img = new Image();
        const url = URL.createObjectURL(file);

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        URL.revokeObjectURL(url);

        // Draw to canvas and export as PNG
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Get PNG blob and convert to ArrayBuffer
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function readImageFiles(files, ffmpeg, loadFFmpeg, manualThreshold = false, enableAutoCrop = false, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping image processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        emit('start-loading', 'Processing images');
        emit('update-loading', 0);

        addLog(`Processing ${files.length} images for stacking...`);

        const frameCount = files.length;
        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null; // Best frame found so far (for preview)
        const allAnalyzedFrames = []; // For manual threshold selection

        function rankFrame(frame) {
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

        const workerPromises = [];
        let completedFrames = 0;
        let ffmpegLoaded = false;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;

        // First pass: convert all files to PNG data
        const pngDataArray = [];
        let firstWidth = 0, firstHeight = 0;

        for (let i = 0; i < frameCount; i++) {
            const file = files[i];
            const isNative = NATIVE_FORMATS.includes(file.type);

            let pngData;
            try {
                if (isNative) {
                    pngData = await nativeImageToPngBuffer(file);
                } else {
                    addLog(`Converting ${file.name} using FFmpeg...`);
                    if (!ffmpegLoaded) {
                        await loadFFmpeg();
                        ffmpegLoaded = true;
                    }
                    pngData = await convertImageToPng(file, ffmpeg, loadFFmpeg);
                }
                pngDataArray.push(pngData);

                // Get dimensions from first image for crop detection
                if (i === 0 && enableAutoCrop) {
                    const img = new Image();
                    const blob = new Blob([pngData], { type: 'image/png' });
                    const url = URL.createObjectURL(blob);
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = url;
                    });
                    URL.revokeObjectURL(url);
                    firstWidth = img.width;
                    firstHeight = img.height;
                }
            } catch (error) {
                addLog(`Error processing ${file.name}: ${error.message}`);
                pngDataArray.push(null); // Placeholder for failed conversions
            }
        }

        // Determine crop region if auto-crop is enabled
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (enableAutoCrop && firstWidth >= MIN_SIZE_FOR_CROP && firstHeight >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${firstWidth}x${firstHeight} qualifies for auto-crop`);
            const validPngData = pngDataArray.filter(d => d !== null);
            cropRegion = await detectCropRegion(validPngData, firstWidth, firstHeight);

            if (cropRegion) {
                addLog(`Will crop images to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop && firstWidth > 0) {
            addLog(`Frame size ${firstWidth}x${firstHeight} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing images' : 'Analyzing images');

        // Second pass: analyze (and optionally crop) all images
        for (let i = 0; i < frameCount; i++) {
            const pngData = pngDataArray[i];
            if (!pngData) {
                completedFrames++;
                continue; // Skip failed conversions
            }

            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const dataToWorker = cropRegion ? {
                type: 'analyze-cropped-png',
                pngData: pngData.slice(0),
                cropRegion: cropRegion,
                index: i,
                includeRgba: true
            } : {
                type: 'ffmpeg', // Use ffmpeg type since it's PNG data
                analyze: pngData.slice(0),
                index: i,
                includeRgba: true // Request RGBA data for client-side stacking
            };

            const transferables = cropRegion ? [dataToWorker.pngData.buffer] : [dataToWorker.analyze.buffer];

            const promise = processFrameWithWorker(worker, dataToWorker, transferables)
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
                        rgbaBuffer: result.rgbaBuffer,
                        width: result.width,
                        height: result.height
                    };
                    rankFrame(currentFrame);

                    completedFrames++;

                    if (i % 5 === 0 || i === frameCount - 1) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });

                        if (bestFrameSoFar) {
                            emit('best-frame-updated', bestFrameSoFar);
                        }
                    }
                })
                .catch(error => {
                    addLog(`Error analyzing image ${i}: ${error}`);
                    console.error(`Error analyzing image ${i}:`, error);
                    completedFrames++;
                });

            workerPromises.push(promise);
        }

        await Promise.all(workerPromises);

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} crop-failed`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Finished analyzing ${frameCount} images. Kept ${bestFramesForStacking.length} best images.${skippedMsg}`);

        // Clean up FFmpeg if it was used
        if (ffmpegLoaded) {
            try {
                ffmpeg.exit();
            } catch (e) {}
        }

        // Manual threshold: let user select frames
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: unifiedAnalyzeWorkers,
                noiseRobustAlignment,
                useWebGPU
            });
            return; // Don't terminate workers yet - they'll be used for stacking
        }

        // Stack frames locally using the first worker (already initialized with OpenCV)
        const stackingWorker = unifiedAnalyzeWorkers[0];
        const stackedBlob = await stackFramesLocally(bestFramesForStacking, stackingWorker, drizzleScale, noiseRobustAlignment, useWebGPU);

        // Terminate workers after stacking
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());
        unifiedAnalyzeWorkers.length = 0;
        workersReady = false;

        if (stackedBlob) {
            addLog('Client-side stacking complete');
            emit('stacked-image-ready', { blob: stackedBlob });
        } else {
            addLog('Client-side stacking failed - no valid frames');
            emit('stop-loading');
        }
    }

    return { readImageFiles };
}
