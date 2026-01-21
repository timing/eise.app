// composables/useImageReader.js
// GPU-accelerated image reader with two-pass memory optimization

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';

// Native image formats that browsers can decode directly
const NATIVE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

export function useImageReader() {
    const { addLog, emit } = useEventBus();
    const { stackFramesLocally } = useStacker();

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
            addLog('GPU worker initialized');
            return true;
        } catch (error) {
            console.error('GPU worker init failed:', error);
            gpuWorker.terminate();
            gpuWorker = null;
            return false;
        }
    }

    // Decode PNG/image data to RGBA using canvas
    async function decodeToRgba(pngData) {
        const blob = new Blob([pngData], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);

        return {
            data: imageData.data, // Uint8ClampedArray RGBA
            width: img.width,
            height: img.height
        };
    }

    // GPU batch analysis for RGBA images
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

    // GPU crop and analyze for RGBA images
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
        const img = new Image();
        const url = URL.createObjectURL(file);

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
    }

    // Detect crop region using GPU
    async function detectCropRegionGpu(rgbaFrames, frameWidth, frameHeight) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: rgbaFrames.length });

        // Sample every Nth frame
        const sampleInterval = Math.max(1, Math.floor(rgbaFrames.length / 50));
        const sampleFrames = [];
        const sampleIndices = [];
        for (let i = 0; i < rgbaFrames.length; i += sampleInterval) {
            sampleFrames.push({ data: rgbaFrames[i].data, index: i });
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleFrames.length} images for crop detection (GPU)...`);

        // Process in batches
        const BATCH_SIZE = 32;
        let maxSize = 0;
        let canCropCount = 0;
        const detectedCenters = [];
        const detectedSizes = [];

        for (let batchStart = 0; batchStart < sampleFrames.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, sampleFrames.length);
            const batch = sampleFrames.slice(batchStart, batchEnd);

            const results = await analyzeRgbaBatchGpu(batch, frameWidth, frameHeight);

            for (const result of results) {
                if (result.bounds) {
                    canCropCount++;
                    maxSize = Math.max(maxSize, result.bounds.size || Math.max(result.bounds.width, result.bounds.height));
                    detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
                    detectedSizes.push(result.bounds.size || Math.max(result.bounds.width, result.bounds.height));
                }
            }

            emit('update-loading', {
                progress: (batchEnd / sampleFrames.length) * 100,
                current: batchEnd,
                total: sampleFrames.length
            });
        }

        const cropThreshold = sampleFrames.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleFrames.length} images can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Add 10% margin and round to even
        let finalSize = Math.ceil(maxSize * 1.05 / 2) * 2;

        const maxAllowedSize = Math.min(frameWidth, frameHeight);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        if (detectedCenters.length === 0) {
            addLog(`Detected crop size: ${finalSize}x${finalSize}`);
            return { size: finalSize };
        }

        const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
        const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
        const medianX = sortedX[Math.floor(sortedX.length / 2)];
        const medianY = sortedY[Math.floor(sortedY.length / 2)];

        const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
        const medianSize = sortedSizes.length > 0 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0;

        addLog(`Detected crop size: ${finalSize}x${finalSize}, median object size: ${Math.round(medianSize)}`);

        return { size: finalSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
    }

    async function readImageFiles(files, ffmpeg, loadFFmpeg, manualThreshold = false, enableAutoCrop = false, stackPercentage = 30, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false) {
        // Initialize GPU worker
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog('GPU not available for image processing');
            emit('stop-loading');
            return;
        }

        emit('start-loading', 'Processing images');
        emit('update-loading', 0);

        addLog(`Processing ${files.length} images for stacking (GPU)...`);

        const frameCount = files.length;
        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        let bestFrameSoFar = null;
        let refCandidateSoFar = null;
        const allAnalyzedFrames = [];

        function rankFrame(frame) {
            if (manualThreshold) {
                allAnalyzedFrames.push(frame);
            }

            if (!bestFrameSoFar || frame.sharpness > bestFrameSoFar.sharpness) {
                bestFrameSoFar = frame;
            }

            // Track most circular for reference
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

        let ffmpegLoaded = false;
        let skippedFrames = 0;
        let cutOffFrames = 0;
        let oversizedFrames = 0;

        // First pass: convert all files to PNG, then decode to RGBA
        emit('set-caption', 'Loading images...');
        const pngDataArray = []; // Keep PNG data for frameReReader
        const rgbaFrames = [];
        let firstWidth = 0, firstHeight = 0;

        for (let i = 0; i < frameCount; i++) {
            const file = files[i];
            const isNative = NATIVE_FORMATS.includes(file.type);

            try {
                let pngData;
                if (isNative) {
                    pngData = await nativeImageToPngBuffer(file);
                } else {
                    if (!ffmpegLoaded) {
                        addLog(`Converting ${file.name} using FFmpeg...`);
                        await loadFFmpeg();
                        ffmpegLoaded = true;
                    }
                    pngData = await convertImageToPng(file, ffmpeg, loadFFmpeg);
                }
                pngDataArray.push(pngData);

                // Decode to RGBA for GPU
                const rgba = await decodeToRgba(pngData);
                rgbaFrames.push(rgba);

                if (i === 0) {
                    firstWidth = rgba.width;
                    firstHeight = rgba.height;
                }

                if (i % 10 === 0) {
                    emit('update-loading', { progress: (i / frameCount) * 30, current: i, total: frameCount });
                }
            } catch (error) {
                addLog(`Error loading ${file.name}: ${error.message}`);
                reportError(error, { component: 'useImageReader', action: 'loadImage' });
                pngDataArray.push(null);
                rgbaFrames.push(null);
            }
        }

        // Clean up FFmpeg
        if (ffmpegLoaded) {
            try { ffmpeg.exit(); } catch (e) {}
        }

        const validCount = rgbaFrames.filter(f => f !== null).length;
        addLog(`Loaded ${validCount}/${frameCount} images`);

        // Detect crop region using GPU
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (enableAutoCrop && firstWidth >= MIN_SIZE_FOR_CROP && firstHeight >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${firstWidth}x${firstHeight} qualifies for auto-crop`);
            const validRgba = rgbaFrames.filter(f => f !== null);
            cropRegion = await detectCropRegionGpu(validRgba, firstWidth, firstHeight);

            if (cropRegion) {
                addLog(`Will crop images to ${cropRegion.size}x${cropRegion.size}`);
            }
        }

        // Second pass: GPU analyze (two-pass mode - metadata only)
        emit('set-caption', cropRegion ? 'Cropping and analyzing images (GPU)' : 'Analyzing images (GPU)');

        const BATCH_SIZE = 32;
        const frameCenters = new Map(); // Store centers for frameReReader
        let completedFrames = 0;

        for (let batchStart = 0; batchStart < frameCount; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, frameCount);

            // Collect valid frames for this batch
            const batchFrames = [];
            const batchIndices = [];
            for (let i = batchStart; i < batchEnd; i++) {
                if (rgbaFrames[i]) {
                    batchFrames.push({ data: rgbaFrames[i].data, index: i });
                    batchIndices.push(i);
                }
            }

            if (batchFrames.length === 0) {
                completedFrames += (batchEnd - batchStart);
                continue;
            }

            try {
                if (cropRegion) {
                    // First get bounds to find centers
                    const boundsResults = await analyzeRgbaBatchGpu(batchFrames, firstWidth, firstHeight);

                    // Filter and prepare for crop
                    const framesToCrop = [];
                    const centers = [];
                    const cropIndices = [];

                    for (let j = 0; j < boundsResults.length; j++) {
                        const result = boundsResults[j];
                        const frameIdx = batchIndices[j];

                        if (!result.bounds) {
                            skippedFrames++;
                            completedFrames++;
                            continue;
                        }

                        // Check cut-off
                        const margin = Math.max(firstWidth, firstHeight) * 0.01;
                        if (result.bounds.x < margin || result.bounds.y < margin ||
                            result.bounds.x + result.bounds.width > firstWidth - margin ||
                            result.bounds.y + result.bounds.height > firstHeight - margin) {
                            cutOffFrames++;
                            completedFrames++;
                            continue;
                        }

                        // Check oversized
                        if (cropRegion.medianObjectSize) {
                            const size = Math.max(result.bounds.width, result.bounds.height);
                            if (size / cropRegion.medianObjectSize > 1.3) {
                                oversizedFrames++;
                                completedFrames++;
                                continue;
                            }
                        }

                        const center = { x: result.bounds.centroidX, y: result.bounds.centroidY };
                        framesToCrop.push(batchFrames[j]);
                        centers.push(center);
                        cropIndices.push(frameIdx);
                        frameCenters.set(frameIdx, center);
                    }

                    if (framesToCrop.length > 0) {
                        // GPU crop + analyze (metadataOnly=true for two-pass)
                        const cropResults = await cropAndAnalyzeRgbaGpu(
                            framesToCrop, firstWidth, firstHeight, cropRegion.size, centers, true
                        );

                        const prevBest = bestFrameSoFar;

                        for (let k = 0; k < cropResults.length; k++) {
                            const gpuResult = cropResults[k];
                            const frameIdx = cropIndices[k];
                            const center = centers[k];

                            const currentFrame = {
                                sharpness: gpuResult.sharpness,
                                width: cropRegion.size,
                                height: cropRegion.size,
                                index: frameIdx,
                                centerX: center.x,
                                centerY: center.y,
                                circularity: gpuResult.circularity || 0
                                // NO float32Buffer - will be re-read during stacking
                            };

                            rankFrame(currentFrame);

                            // Create preview blob if this became new best
                            if (bestFrameSoFar === currentFrame && prevBest !== currentFrame && gpuResult.uint8Buffer) {
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
                    }
                } else {
                    // No crop - analyze full frames
                    const results = await analyzeRgbaBatchGpu(batchFrames, firstWidth, firstHeight);

                    for (let j = 0; j < results.length; j++) {
                        const result = results[j];
                        const frameIdx = batchIndices[j];

                        const currentFrame = {
                            sharpness: result.sharpness || 0,
                            width: firstWidth,
                            height: firstHeight,
                            index: frameIdx,
                            centerX: firstWidth / 2,
                            centerY: firstHeight / 2,
                            circularity: result.circularity || 0
                        };

                        frameCenters.set(frameIdx, { x: firstWidth / 2, y: firstHeight / 2 });
                        rankFrame(currentFrame);
                        completedFrames++;
                    }
                }
            } catch (error) {
                addLog(`GPU batch error: ${error.message}`);
                completedFrames += batchFrames.length;
            }

            emit('update-loading', {
                progress: 30 + (completedFrames / frameCount) * 70,
                current: completedFrames,
                total: frameCount
            });

            if (bestFrameSoFar && completedFrames % 50 === 0) {
                emit('best-frame-updated', bestFrameSoFar);
            }
        }

        const skipMsgs = [];
        if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
        if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
        if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} no-bounds`);
        const skippedMsg = skipMsgs.length > 0 ? ` (${skipMsgs.join(', ')})` : '';
        addLog(`Analyzed ${frameCount} images. Valid: ${allAnalyzedFrames.length || bestFramesForStacking.length}${skippedMsg}`);

        // Create frameReReader for two-pass stacking
        const frameReReader = {
            fileType: 'image',
            pngDataArray,
            rgbaFrames,
            frameCenters,
            cropRegion,
            srcWidth: firstWidth,
            srcHeight: firstHeight,

            // Re-read a frame and return RGBA data for stacking
            async getFrame(frameIndex) {
                const rgba = this.rgbaFrames[frameIndex];
                if (!rgba) return null;

                const center = this.frameCenters.get(frameIndex);
                if (!center) return null;

                return {
                    data: rgba.data,
                    width: rgba.width,
                    height: rgba.height,
                    centerX: center.x,
                    centerY: center.y
                };
            }
        };

        // Manual threshold mode
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: null, // Not using CPU workers
                noiseRobustAlignment,
                useWebGPU: true,
                frameReReader
            });
            return;
        }

        // Automatic stacking
        const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, noiseRobustAlignment, true, frameReReader);

        // Cleanup
        gpuWorker.terminate();
        gpuWorker = null;
        gpuReady = false;

        if (stackResult && stackResult.blob) {
            addLog('GPU stacking complete');
            emit('stacked-image-ready', {
                blob: stackResult.blob,
                float32Data: stackResult.float32Data,
                width: stackResult.width,
                height: stackResult.height
            });
        } else {
            addLog('Stacking failed - no valid frames');
            emit('stop-loading');
        }
    }

    return { readImageFiles };
}
