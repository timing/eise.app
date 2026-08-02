// composables/useImageReader.js
// GPU-accelerated image reader with memory-efficient on-demand frame loading
// Images are decoded on-demand rather than keeping all in memory

import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { decodeTIFF } from '@/utils/tiffDecoder.js';

// Native image formats that browsers can decode directly
const NATIVE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

// Check if file is a TIFF
function isTiffFile(file) {
    const fileName = file.name?.toLowerCase() || '';
    return file.type === 'image/tiff' || fileName.endsWith('.tif') || fileName.endsWith('.tiff');
}

// Check if file requires FFmpeg conversion
function requiresFFmpeg(file) {
    return !NATIVE_FORMATS.includes(file.type) && !isTiffFile(file);
}

// Center-crop RGBA data to target dimensions. Source must be >= target.
function centerCropRgba(rgba, targetW, targetH) {
    if (rgba.width === targetW && rgba.height === targetH) return rgba;
    const srcW = rgba.width, srcH = rgba.height;
    const offX = Math.max(0, Math.floor((srcW - targetW) / 2));
    const offY = Math.max(0, Math.floor((srcH - targetH) / 2));
    const cropped = new Uint8ClampedArray(targetW * targetH * 4);
    for (let y = 0; y < targetH; y++) {
        const srcRowStart = ((y + offY) * srcW + offX) * 4;
        const dstRowStart = y * targetW * 4;
        cropped.set(rgba.data.subarray(srcRowStart, srcRowStart + targetW * 4), dstRowStart);
    }
    return { data: cropped, width: targetW, height: targetH };
}

// Fast dimension probe for a File (no full RGBA decode for native formats)
async function probeImageFileDimensions(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Image failed to decode'));
            img.src = url;
        });
        return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function useImageReader() {
    const { addLog, emit } = useEventBus();
    const { stackFramesLocally } = useStacker();
    const { workerUrl } = useWorkerUrl();

    let gpuWorker = null;
    let gpuReady = false;

    async function initializeGpuWorker() {
        if (gpuReady) return true;

        gpuWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' });

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('GPU worker timeout')), 30000);
                gpuWorker.onmessage = (e) => {
                    if (!e.data) {
                        clearTimeout(timeout);
                        reject(new Error('GPU worker crashed - try reloading the page'));
                        return;
                    }
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
            addLog(`GPU worker init failed: ${error.message}, falling back to CPU`);
            reportError(error, { component: 'useImageReader', action: 'initializeGpuWorker' });
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
            img.onerror = () => reject(new Error('Image failed to decode - file may be corrupted or unsupported'));
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

    // Decode a File directly to RGBA (for native formats)
    async function decodeFileToRgba(file) {
        const url = URL.createObjectURL(file);
        const img = new Image();

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Image failed to decode'));
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);

        return {
            data: imageData.data,
            width: img.width,
            height: img.height
        };
    }

    // Decode a TIFF file to RGBA
    async function decodeTiffToRgba(file) {
        const buffer = await file.arrayBuffer();
        const decoded = await decodeTIFF(buffer);

        const pixelCount = decoded.width * decoded.height;
        const uint8Data = new Uint8ClampedArray(pixelCount * 4);
        const float32 = decoded.float32Data;

        for (let j = 0; j < pixelCount; j++) {
            uint8Data[j * 4] = Math.round(Math.min(1, Math.max(0, float32[j * 4])) * 255);
            uint8Data[j * 4 + 1] = Math.round(Math.min(1, Math.max(0, float32[j * 4 + 1])) * 255);
            uint8Data[j * 4 + 2] = Math.round(Math.min(1, Math.max(0, float32[j * 4 + 2])) * 255);
            uint8Data[j * 4 + 3] = Math.round(Math.min(1, Math.max(0, float32[j * 4 + 3])) * 255);
        }

        return { data: uint8Data, width: decoded.width, height: decoded.height };
    }

    // GPU batch analysis for RGBA images
    async function analyzeRgbaBatchGpu(frames, width, height) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (e) => {
                if (!e.data) {
                    gpuWorker.removeEventListener('message', handler);
                    reject(new Error('GPU worker crashed - try reloading the page'));
                    return;
                }
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
                if (!e.data) {
                    gpuWorker.removeEventListener('message', handler);
                    reject(new Error('GPU worker crashed - try reloading the page'));
                    return;
                }
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

        // Check if output file exists before reading
        let data;
        try {
            data = ffmpeg.FS('readFile', outputName);
        } catch (readError) {
            // Cleanup input file before throwing
            try { ffmpeg.FS('unlink', inputName); } catch (e) {}
            throw new Error(`Failed to convert image "${file.name}": FFmpeg did not produce output. The file may be corrupted or in an unsupported format.`);
        }

        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);

        return data;
    }

    async function readImageFiles(files, ffmpeg, loadFFmpeg, manualThreshold = false, cropMarginPercent = 10, stackPercentage = 30, drizzleScale = 1.5, useWebGPU = false, surfaceMode = false) {
        // Initialize GPU worker
        const gpuOk = await initializeGpuWorker();
        if (!gpuOk) {
            addLog('GPU not available for image processing');
            emit('stop-loading');
            return;
        }

        emit('start-loading', 'Processing images');
        emit('update-loading', 0);

        addLog(`Processing ${files.length} images for stacking...`);

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

        // Memory-efficient approach: don't keep all decoded images in memory
        // - Native formats (PNG, JPEG, etc.): re-read from File on demand
        // - TIFF: re-read from File on demand
        // - FFmpeg-required formats: keep in memory (conversion is expensive, and rare)
        const rgbaCache = new Map(); // index -> RGBA for FFmpeg-converted files only
        const failedIndices = new Set(); // indices that failed to load
        let firstWidth = 0, firstHeight = 0;

        // Convert FFmpeg files upfront (expensive, need to cache)
        for (let i = 0; i < frameCount; i++) {
            const file = files[i];
            if (requiresFFmpeg(file)) {
                try {
                    if (!ffmpegLoaded) {
                        addLog(`Converting ${file.name} using FFmpeg...`);
                        await loadFFmpeg();
                        ffmpegLoaded = true;
                    }
                    const pngData = await convertImageToPng(file, ffmpeg, loadFFmpeg);
                    const rgba = await decodeToRgba(pngData);
                    rgbaCache.set(i, rgba);
                } catch (error) {
                    addLog(`Error converting ${file.name}: ${error.message}`);
                    failedIndices.add(i);
                }
            }
        }

        // Clean up FFmpeg
        if (ffmpegLoaded) {
            try { ffmpeg.exit(); } catch (e) {}
        }

        addLog(`${frameCount} images to process`);

        // Helper to load a single frame on-demand, center-cropped to firstWidth x firstHeight
        async function loadFrameRgba(index) {
            if (failedIndices.has(index)) return null;
            let rgba;
            // FFmpeg files are cached in memory
            if (rgbaCache.has(index)) {
                rgba = rgbaCache.get(index);
            } else {
                // Native/TIFF files are re-read from File
                const file = files[index];
                if (isTiffFile(file)) {
                    rgba = await decodeTiffToRgba(file);
                } else {
                    rgba = await decodeFileToRgba(file);
                }
            }
            if (firstWidth && firstHeight && (rgba.width !== firstWidth || rgba.height !== firstHeight)) {
                rgba = centerCropRgba(rgba, firstWidth, firstHeight);
            }
            return rgba;
        }

        // Load a batch of frames in parallel
        async function loadBatchParallel(indices) {
            const loadPromises = indices.map(async (idx) => {
                try {
                    const rgba = await loadFrameRgba(idx);
                    return rgba ? { data: rgba.data, index: idx, width: rgba.width, height: rgba.height } : null;
                } catch (e) {
                    return null;
                }
            });
            const results = await Promise.all(loadPromises);
            return results.filter(r => r !== null);
        }

        // Probe dimensions of every file so we can center-crop mismatched frames
        // to a common size. Some capture pipelines produce frames that differ by
        // a few pixels; without this, later frames get uploaded to GPU buffers
        // sized for firstFrame's dimensions, causing offset artifacts.
        const probeResults = await Promise.all(files.map(async (file, i) => {
            if (failedIndices.has(i)) return null;
            try {
                if (rgbaCache.has(i)) {
                    const cached = rgbaCache.get(i);
                    return { width: cached.width, height: cached.height };
                }
                if (isTiffFile(file)) {
                    const rgba = await decodeTiffToRgba(file);
                    return { width: rgba.width, height: rgba.height };
                }
                return await probeImageFileDimensions(file);
            } catch (e) {
                failedIndices.add(i);
                return null;
            }
        }));

        const knownDims = probeResults.filter(d => d);
        if (knownDims.length === 0) {
            emit('upload-error', 'Failed to load any images');
            emit('stop-loading');
            return;
        }

        firstWidth = Math.min(...knownDims.map(d => d.width));
        firstHeight = Math.min(...knownDims.map(d => d.height));

        const sizeCounts = new Map();
        for (const d of knownDims) {
            const k = `${d.width}×${d.height}`;
            sizeCounts.set(k, (sizeCounts.get(k) || 0) + 1);
        }
        if (sizeCounts.size > 1) {
            const summary = [...sizeCounts.entries()]
                .map(([sz, n]) => `${n}×${sz}`)
                .join(', ');
            addLog(`Image dimensions vary (${summary}). Center-cropping all frames to ${firstWidth}×${firstHeight}.`);
        }

        // Detect crop region using GPU (loading frames on-demand)
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (firstWidth >= MIN_SIZE_FOR_CROP && firstHeight >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${firstWidth}x${firstHeight} qualifies for auto-crop`);

            // Sample frames for crop detection
            emit('set-caption', 'Detecting planet position...');
            const sampleInterval = Math.max(1, Math.floor(frameCount / 50));
            const sampleIndices = [];
            for (let i = 0; i < frameCount; i += sampleInterval) {
                sampleIndices.push(i);
            }

            addLog(`Sampling ${sampleIndices.length} images for crop detection...`);

            // Dynamic batch size based on frame dimensions to stay under GPU memory limit
            const frameBytes = firstWidth * firstHeight * 16; // Float32 RGBA = 16 bytes/pixel
            const targetBatchMemory = 512 * 1024 * 1024; // 512MB
            const BATCH_SIZE = Math.max(4, Math.min(32, Math.floor(targetBatchMemory / frameBytes)));
            let canCropCount = 0;
            const detectedCenters = [];
            const detectedSizes = [];

            // Prefetch first batch
            let nextBatchPromise = loadBatchParallel(sampleIndices.slice(0, BATCH_SIZE));

            for (let batchStart = 0; batchStart < sampleIndices.length; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, sampleIndices.length);

                // Wait for current batch (already loading or prefetched)
                const batchFrames = await nextBatchPromise;

                // Start loading next batch while GPU processes current
                const nextStart = batchEnd;
                if (nextStart < sampleIndices.length) {
                    const nextEnd = Math.min(nextStart + BATCH_SIZE, sampleIndices.length);
                    nextBatchPromise = loadBatchParallel(sampleIndices.slice(nextStart, nextEnd));
                }

                if (batchFrames.length > 0) {
                    const results = await analyzeRgbaBatchGpu(batchFrames, firstWidth, firstHeight);

                    for (const result of results) {
                        if (result.bounds) {
                            canCropCount++;
                            detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
                            detectedSizes.push(result.bounds.size || Math.max(result.bounds.width, result.bounds.height));
                        }
                    }
                }

                emit('update-loading', {
                    progress: 10 + (batchEnd / sampleIndices.length) * 20,
                    current: batchEnd,
                    total: sampleIndices.length
                });
            }

            const cropThreshold = sampleIndices.length * 0.5;
            if (canCropCount >= cropThreshold && detectedSizes.length > 0) {
                const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
                const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];
                const marginMultiplier = 1 + (cropMarginPercent / 100);
                const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
                const maxAllowedSize = Math.min(firstWidth, firstHeight);

                // Calculate median center position
                const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
                const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
                const medianX = sortedX.length > 0 ? sortedX[Math.floor(sortedX.length / 2)] : firstWidth / 2;
                const medianY = sortedY.length > 0 ? sortedY[Math.floor(sortedY.length / 2)] : firstHeight / 2;

                // Handle cropSize >= frameSize differently based on mode:
                // - Surface mode (lunar/solar): Use full frame with per-frame centering to prevent smearing
                // - Normal mode (Jupiter + moon): Skip cropping to preserve multiple spread objects
                if (desiredSize >= maxAllowedSize) {
                    if (surfaceMode) {
                        cropRegion = {
                            size: maxAllowedSize,
                            referenceCenter: { x: medianX, y: medianY },
                            medianObjectSize: medianSize
                        };
                        addLog(`Surface mode: using full frame ${maxAllowedSize}x${maxAllowedSize} with per-frame centering`);
                    } else {
                        addLog(`Skipping crop: desired ${desiredSize}px exceeds frame ${maxAllowedSize}px. Stacking alignment will handle centering.`);
                    }
                } else if (detectedCenters.length > 0) {
                    cropRegion = {
                        size: desiredSize,
                        referenceCenter: { x: medianX, y: medianY },
                        medianObjectSize: medianSize
                    };
                    addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${Math.round(medianSize)}, margin: ${cropMarginPercent}%`);
                } else {
                    cropRegion = { size: desiredSize, medianObjectSize: medianSize };
                    addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${Math.round(medianSize)}, margin: ${cropMarginPercent}%`);
                }
            } else {
                addLog(`Only ${canCropCount}/${sampleIndices.length} images can be cropped. Skipping auto-crop.`);
            }
        }

        // Second pass: GPU analyze (loading frames on-demand)
        emit('set-caption', cropRegion ? 'Cropping and analyzing images' : 'Analyzing images');

        // Dynamic batch size based on frame dimensions to stay under GPU memory limit
        const analyzeFrameBytes = firstWidth * firstHeight * 16; // Float32 RGBA
        const analyzeTargetMemory = 512 * 1024 * 1024; // 512MB
        const ANALYZE_BATCH_SIZE = Math.max(4, Math.min(32, Math.floor(analyzeTargetMemory / analyzeFrameBytes)));
        const frameCenters = new Map(); // Store centers for frameReReader
        let completedFrames = 0;

        // Generate all valid indices upfront (excludes failed FFmpeg conversions)
        const allIndices = [];
        for (let i = 0; i < frameCount; i++) {
            if (!failedIndices.has(i)) allIndices.push(i);
        }

        // Prefetch first batch (position-based slicing on allIndices)
        let nextBatchPromise = loadBatchParallel(allIndices.slice(0, ANALYZE_BATCH_SIZE));

        for (let pos = 0; pos < allIndices.length; pos += ANALYZE_BATCH_SIZE) {
            const posEnd = Math.min(pos + ANALYZE_BATCH_SIZE, allIndices.length);

            // Wait for current batch (already loading or prefetched)
            const batchFrames = await nextBatchPromise;
            const batchIndices = batchFrames.map(f => f.index);

            // Start loading next batch while GPU processes current
            if (posEnd < allIndices.length) {
                const nextPosEnd = Math.min(posEnd + ANALYZE_BATCH_SIZE, allIndices.length);
                nextBatchPromise = loadBatchParallel(allIndices.slice(posEnd, nextPosEnd));
            }

            if (batchFrames.length === 0) {
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

                        // Check cut-off - skip for Sun/Moon
                        if (!surfaceMode) {
                            const margin = Math.max(firstWidth, firstHeight) * 0.01;
                            if (result.bounds.x < margin || result.bounds.y < margin ||
                                result.bounds.x + result.bounds.width > firstWidth - margin ||
                                result.bounds.y + result.bounds.height > firstHeight - margin) {
                                cutOffFrames++;
                                completedFrames++;
                                continue;
                            }
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

        // Create frameReReader for two-pass stacking (re-reads files on demand)
        const frameReReader = {
            fileType: 'image',
            files,
            rgbaCache,
            frameCenters,
            cropRegion,
            srcWidth: firstWidth,
            srcHeight: firstHeight,

            // Re-read a frame and return RGBA data for stacking
            async getFrame(frameIndex) {
                const center = this.frameCenters.get(frameIndex);
                if (!center) return null;

                try {
                    let rgba;
                    if (this.rgbaCache.has(frameIndex)) {
                        // FFmpeg files are kept in memory
                        rgba = this.rgbaCache.get(frameIndex);
                    } else {
                        // Native/TIFF files are re-read from File
                        const file = this.files[frameIndex];
                        if (!file) return null;
                        if (isTiffFile(file)) {
                            rgba = await decodeTiffToRgba(file);
                        } else {
                            rgba = await decodeFileToRgba(file);
                        }
                    }

                    if (rgba.width !== this.srcWidth || rgba.height !== this.srcHeight) {
                        rgba = centerCropRgba(rgba, this.srcWidth, this.srcHeight);
                    }

                    return {
                        data: rgba.data,
                        width: rgba.width,
                        height: rgba.height,
                        centerX: center.x,
                        centerY: center.y
                    };
                } catch (e) {
                    console.warn(`Failed to re-read frame ${frameIndex}:`, e);
                    return null;
                }
            }
        };

        // Manual threshold mode
        if (manualThreshold) {
            const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: null, // Not using CPU workers
                useWebGPU: true,
                drizzleScale,
                frameReReader
            });
            return;
        }

        // Automatic stacking
        const stackResult = await stackFramesLocally(bestFramesForStacking, null, drizzleScale, true, frameReReader, surfaceMode);

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
            emit('stack-failed', { component: 'useImageReader', reason: 'no valid frames' });
            emit('stop-loading');
        }
    }

    return { readImageFiles };
}
