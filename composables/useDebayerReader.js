/**
 * useDebayerReader.js - Unified processing for demosaicing formats
 *
 * Handles all file formats that need Bayer demosaicing:
 * - SER files (via useSerParser)
 * - Raw Bayer AVI files (via useAviParser)
 * - FITS files (future, via useFitsParser)
 *
 * Two-phase processing architecture:
 * - Phase 1 (Analysis): Fast analysis to find best frames
 * - Phase 2 (Stacking): High-quality VNG demosaic for stacking
 *
 * Memory-efficient: stores only metadata during analysis, re-reads frames for stacking.
 */

import { useEventBus } from '@/composables/eventBus';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useStacker } from '@/composables/useStacker';
import { reportError } from '@/composables/useSentryReporting';

// Import parser helpers for Bayer pattern conversion
import { getGpuBayerPattern as serGetGpuBayerPattern } from '@/composables/useSerParser';
import { opencvToGpuPattern } from '@/composables/useAviParser';

/**
 * Map OpenCV Bayer pattern names to GPU shader pattern indices
 */
function bayerChoiceToGpuPattern(bayerChoice) {
    const mapping = {
        'COLOR_BayerBG2RGB': 0,  // RGGB
        'COLOR_BayerBG2BGR': 0,
        'COLOR_BayerRG2RGB': 1,  // BGGR
        'COLOR_BayerRG2BGR': 1,
        'COLOR_BayerGB2RGB': 2,  // GRBG
        'COLOR_BayerGB2BGR': 2,
        'COLOR_BayerGR2RGB': 3,  // GBRG
        'COLOR_BayerGR2BGR': 3,
        'MONO': -1
    };
    return mapping[bayerChoice] ?? -1;
}

/**
 * Simple bilinear demosaic for preview (CPU fallback)
 */
function demosaicBayerToRgba(src, rgba, width, height, bayerChoice) {
    const pattern = bayerChoice.includes('BG') ? 'RGGB' :
                    bayerChoice.includes('RG') ? 'BGGR' :
                    bayerChoice.includes('GB') ? 'GRBG' :
                    bayerChoice.includes('GR') ? 'GBRG' : 'RGGB';

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const j = i * 4;
            const raw = src[i];
            const px = x % 2, py = y % 2;
            let r, g, b;

            const getPixel = (dx, dy) => {
                const nx = Math.max(0, Math.min(width - 1, x + dx));
                const ny = Math.max(0, Math.min(height - 1, y + dy));
                return src[ny * width + nx];
            };

            if (pattern === 'RGGB') {
                if (px === 0 && py === 0) { r = raw; g = (getPixel(1, 0) + getPixel(0, 1)) >> 1; b = getPixel(1, 1); }
                else if (px === 1 && py === 1) { r = getPixel(-1, -1); g = (getPixel(-1, 0) + getPixel(0, -1)) >> 1; b = raw; }
                else if (px === 1 && py === 0) { r = getPixel(-1, 0); g = raw; b = getPixel(0, 1); }
                else { r = getPixel(0, -1); g = raw; b = getPixel(1, 0); }
            } else if (pattern === 'BGGR') {
                if (px === 0 && py === 0) { b = raw; g = (getPixel(1, 0) + getPixel(0, 1)) >> 1; r = getPixel(1, 1); }
                else if (px === 1 && py === 1) { b = getPixel(-1, -1); g = (getPixel(-1, 0) + getPixel(0, -1)) >> 1; r = raw; }
                else if (px === 1 && py === 0) { b = getPixel(-1, 0); g = raw; r = getPixel(0, 1); }
                else { b = getPixel(0, -1); g = raw; r = getPixel(1, 0); }
            } else if (pattern === 'GBRG') {
                if (px === 0 && py === 0) { b = getPixel(1, 0); g = raw; r = getPixel(0, 1); }
                else if (px === 1 && py === 1) { b = getPixel(0, -1); g = raw; r = getPixel(-1, 0); }
                else if (px === 1 && py === 0) { b = raw; g = (getPixel(-1, 0) + getPixel(0, 1)) >> 1; r = getPixel(-1, 1); }
                else { b = getPixel(1, -1); g = (getPixel(1, 0) + getPixel(0, -1)) >> 1; r = raw; }
            } else { // GRBG
                if (px === 0 && py === 0) { r = getPixel(1, 0); g = raw; b = getPixel(0, 1); }
                else if (px === 1 && py === 1) { r = getPixel(0, -1); g = raw; b = getPixel(-1, 0); }
                else if (px === 1 && py === 0) { r = raw; g = (getPixel(-1, 0) + getPixel(0, 1)) >> 1; b = getPixel(-1, 1); }
                else { r = getPixel(1, -1); g = (getPixel(1, 0) + getPixel(0, -1)) >> 1; b = raw; }
            }

            rgba[j] = r;
            rgba[j + 1] = g;
            rgba[j + 2] = b;
            rgba[j + 3] = 255;
        }
    }
}

/**
 * Auto-stretch RGBA to use full 0-255 range
 */
function autoStretchRgba(rgba) {
    let min = 255, max = 0;
    for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = rgba[i + c];
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    if (max <= min) return;
    const scale = 255 / (max - min);
    for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            rgba[i + c] = Math.round((rgba[i + c] - min) * scale);
        }
    }
}

/**
 * Compute a pre-crop region from detected bounds with generous margin
 * Margin ensures planet won't be cut off by GPU detection
 * @param {Array} bounds - Array of detected bounds from GPU
 * @param {number} srcWidth - Original frame width
 * @param {number} srcHeight - Original frame height
 * @param {number} marginFactor - Margin multiplier (e.g., 2.0 = 2x planet size)
 * @returns {Object|null} - {x, y, width, height} or null if no valid bounds
 */
function computePreCropRegion(bounds, srcWidth, srcHeight, marginFactor = 1.5) {
    // Filter valid bounds (not cut-off, has size)
    const validBounds = bounds.filter(b => b && !b.cutOff && b.width > 0);
    if (validBounds.length === 0) return null;

    // Find the bounding box of all detected objects
    let minX = srcWidth, minY = srcHeight, maxX = 0, maxY = 0;
    let maxSize = 0;
    for (const b of validBounds) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
        maxSize = Math.max(maxSize, b.size || Math.max(b.width, b.height));
    }

    // Add margin based on detected object size
    const margin = Math.ceil(maxSize * marginFactor);
    const x = Math.max(0, minX - margin);
    const y = Math.max(0, minY - margin);
    const width = Math.min(srcWidth - x, maxX - minX + margin * 2);
    const height = Math.min(srcHeight - y, maxY - minY + margin * 2);

    return { x, y, width, height };
}

/**
 * Create a debayer reader instance for processing demosaic formats
 */
export function useDebayerReader() {
    const { addLog, emit } = useEventBus();
    const { workerUrl } = useWorkerUrl();
    const { stackFramesLocally } = useStacker();

    // File and parser
    let file = null;
    let parser = null;
    let metadata = null;

    // GPU worker
    let gpuWorker = null;
    let gpuWorkerReady = false;
    let gpuInitFailed = false;

    // Pre-crop worker (runs in parallel with GPU on separate CPU core)
    let preCropWorker = null;
    let preCropRequestId = 0;

    // Processing state
    let bayerChoice = 'MONO';
    let bayerPattern = -1;
    let scaleFactor = 1;

    /**
     * Initialize reader with file and parser
     */
    async function init(inputFile, inputParser, options = {}) {
        console.log('[useDebayerReader] init called - using NEW unified reader');

        file = inputFile;
        parser = inputParser;
        metadata = parser.getMetadata();
        scaleFactor = metadata.scaleFactor || 1;

        // Get initial Bayer pattern from metadata
        bayerChoice = metadata.bayerPattern?.opencv || 'MONO';
        bayerPattern = metadata.bayerPattern?.gpu ?? -1;

        addLog(`[DebayerReader] Initialized: ${metadata.width}x${metadata.height}, ${metadata.frameCount} frames`);
        addLog(`[DebayerReader] Bayer pattern: ${bayerChoice} (GPU index: ${bayerPattern})`);

        // Log detailed SER header info
        const colorNames = {
            0: 'MONO',
            8: 'RGGB',
            9: 'GRBG',
            10: 'GBRG',
            11: 'BGGR',
            100: 'RGB',
            101: 'BGR'
        };
        const colorName = colorNames[metadata.colorID] || `Unknown (${metadata.colorID})`;
        addLog(`─── SER File Details ───`);
        addLog(`Resolution: ${metadata.width} x ${metadata.height}`);
        addLog(`Frames: ${metadata.frameCount}`);
        addLog(`Bit depth: ${metadata.pixelDepth}-bit (${metadata.bytesPerPixel} bytes/pixel)`);
        addLog(`Color format: ${colorName} (colorID: ${metadata.colorID})`);
        addLog(`Endianness: ${metadata.littleEndian ? 'Little-endian' : 'Big-endian'}`);
        if (metadata.scaleFactor && metadata.scaleFactor > 1) {
            addLog(`16-bit scale factor: ${metadata.scaleFactor}x`);
        }
        if (metadata.observer) addLog(`Observer: ${metadata.observer}`);
        if (metadata.instrument) addLog(`Instrument: ${metadata.instrument}`);
        if (metadata.telescope) addLog(`Telescope: ${metadata.telescope}`);
        addLog(`────────────────────────`);

        return metadata;
    }

    /**
     * Initialize GPU worker
     */
    async function initGpuWorker() {
        if (gpuWorker && gpuWorkerReady) return true;
        if (gpuInitFailed) return false;

        gpuWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                addLog('[DebayerReader] WebGPU worker timeout');
                gpuWorker.terminate();
                gpuWorker = null;
                gpuInitFailed = true;
                resolve(false);
            }, 10000);

            gpuWorker.onmessage = (e) => {
                if (!e.data) return;
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    gpuWorkerReady = true;
                    addLog('[DebayerReader] WebGPU worker ready');
                    resolve(true);
                } else if (e.data.type === 'init-error') {
                    clearTimeout(timeout);
                    addLog(`[DebayerReader] WebGPU error: ${e.data.error}`);
                    gpuWorker.terminate();
                    gpuWorker = null;
                    gpuInitFailed = true;
                    resolve(false);
                }
            };

            gpuWorker.onerror = (err) => {
                clearTimeout(timeout);
                console.error('[DebayerReader] GPU worker error:', err);
                reportError(err, { component: 'useDebayerReader', action: 'initGpuWorker' });
                gpuWorker.terminate();
                gpuWorker = null;
                gpuInitFailed = true;
                resolve(false);
            };

            gpuWorker.postMessage({ type: 'init' });
        });
    }

    /**
     * Terminate GPU worker
     */
    function terminateGpuWorker() {
        if (gpuWorker) {
            gpuWorker.postMessage({ type: 'cleanup' });
            gpuWorker.terminate();
            gpuWorker = null;
            gpuWorkerReady = false;
        }
    }

    /**
     * Read a single frame from the file
     */
    async function readFrame(frameIndex) {
        let frameData;
        if (parser.readFrameScaled) {
            frameData = await parser.readFrameScaled(frameIndex);
        } else if (parser.readFrameFlipped) {
            frameData = await parser.readFrameFlipped(frameIndex);
        } else {
            frameData = await parser.readFrame(frameIndex);
        }

        // Convert to typed array
        // Handle different parser metadata formats (SER: bytesPerPixel/pixelDepth, AVI: bpp)
        const bytesPerPixel = metadata.bytesPerPixel || (metadata.bpp ? metadata.bpp / 8 : (metadata.pixelDepth > 8 ? 2 : 1));
        return bytesPerPixel === 2
            ? new Uint16Array(frameData instanceof ArrayBuffer ? frameData : frameData.buffer)
            : new Uint8Array(frameData instanceof ArrayBuffer ? frameData : frameData.buffer || frameData);
    }

    /**
     * Create frame re-reader object for two-pass stacking
     * This object provides the interface that useStacker expects
     * @param {Object} options - Options from analysis phase
     * @param {Object} options.cropRegion - Crop region { size } or null
     * @param {number} options.analysisStartTime - Start time for timing stats
     */
    function createFrameReReader(options = {}) {
        const { cropRegion = null, analysisStartTime = performance.now() } = options;

        // Build header object from metadata (compatible with what useStacker expects)
        const header = {
            width: metadata.width,
            height: metadata.height,
            pixelDepth: metadata.pixelDepth || metadata.bpp || 8,
            colorID: metadata.colorID,
        };

        return {
            fileType: 'ser',  // useStacker treats SER and raw Bayer AVI the same way
            header,
            bayerPattern,  // GPU pattern index from module state
            bayerChoice,   // OpenCV pattern name from module state
            cropRegion,
            analysisStartTime,

            /**
             * Re-read a single frame and return raw buffer with center coordinates
             * @param {Object|number} frame - Frame object with index/centerX/centerY, or just index
             * @returns {Promise<{frameBuffer: ArrayBuffer, centerX: number, centerY: number}>}
             */
            async getFrame(frame) {
                const frameIndex = frame.index ?? frame;
                const frameData = await readFrame(frameIndex);

                // Get center from frame object, or use image center as fallback
                const centerX = frame.centerX ?? metadata.width / 2;
                const centerY = frame.centerY ?? metadata.height / 2;

                return {
                    frameBuffer: frameData.buffer,
                    centerX,
                    centerY
                };
            },

            /**
             * Generate color preview blob on-demand (for QualitySelector)
             * @param {Object} frame - Frame object with index, centerX, centerY
             * @returns {Promise<Blob|null>} PNG blob or null on failure
             */
            async getPreviewBlob(frame) {
                try {
                    const frameData = await this.getFrame(frame);
                    if (!frameData) return null;

                    const { width, height } = metadata;
                    const is16bit = header.pixelDepth > 8;

                    // Handle 16-bit data: read as Uint16Array and scale to 8-bit for CPU demosaic
                    let src;
                    if (is16bit) {
                        const src16 = new Uint16Array(frameData.frameBuffer);
                        src = new Uint8Array(src16.length);
                        // Find max value for scaling (sample for speed)
                        let maxVal = 0;
                        const step = Math.max(1, Math.floor(src16.length / 5000));
                        for (let i = 0; i < src16.length; i += step) {
                            if (src16[i] > maxVal) maxVal = src16[i];
                        }
                        // Scale 16-bit to 8-bit with auto-stretch
                        const scale = maxVal > 0 ? 255 / maxVal : 1;
                        for (let i = 0; i < src16.length; i++) {
                            src[i] = Math.min(255, Math.round(src16[i] * scale));
                        }
                    } else {
                        src = new Uint8Array(frameData.frameBuffer);
                    }

                    const rgba = new Uint8ClampedArray(width * height * 4);

                    // Demosaic to color
                    demosaicBayerToRgba(src, rgba, width, height, bayerChoice);
                    autoStretchRgba(rgba);

                    // Create canvas and render
                    const canvas = new OffscreenCanvas(width, height);
                    const ctx = canvas.getContext('2d');
                    const imageData = new ImageData(rgba, width, height);
                    ctx.putImageData(imageData, 0, 0);

                    // If crop region, extract cropped portion
                    if (cropRegion && frame.centerX !== undefined && frame.centerY !== undefined) {
                        const cropSize = cropRegion.size;
                        const cropX = Math.max(0, Math.min(width - cropSize, Math.round(frame.centerX - cropSize / 2)));
                        const cropY = Math.max(0, Math.min(height - cropSize, Math.round(frame.centerY - cropSize / 2)));

                        const croppedCanvas = new OffscreenCanvas(cropSize, cropSize);
                        const croppedCtx = croppedCanvas.getContext('2d');
                        croppedCtx.drawImage(canvas, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);

                        return await croppedCanvas.convertToBlob({ type: 'image/png' });
                    }

                    return await canvas.convertToBlob({ type: 'image/png' });
                } catch (err) {
                    console.error('Preview creation failed:', err);
                    return null;
                }
            }
        };
    }

    /**
     * Analyze frames in batch using GPU
     * @param {boolean} grayOnly - If true, use fast grayscale-only demosaic (no RGBA output)
     */
    async function analyzeFrameBatchGpu(frames, threshold = 0.1, metadataOnly = false, grayOnly = false) {
        if (!gpuWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        const requestId = Date.now() + Math.random();

        return new Promise((resolve, reject) => {
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
                width: metadata.width,
                height: metadata.height,
                bayerPattern,
                threshold,
                requestId,
                metadataOnly,
                grayOnly,
            });
        });
    }

    /**
     * Demosaic a single frame to color for preview (with optional cropping)
     * Uses full color demosaic (not grayscale-only)
     * @param {TypedArray} frameData - Raw Bayer frame data
     * @param {number} frameIndex - Frame index
     * @param {Object} cropInfo - Optional crop info { size, centerX, centerY }
     */
    /**
     * Demosaic a single frame for preview, returning both color and grayscale blobs
     * @returns {Promise<{colorBlob: Blob, grayBlob: Blob}|null>}
     */
    async function demosaicFrameForPreview(frameData, frameIndex, cropInfo = null) {
        if (!gpuWorker || !gpuWorkerReady) {
            return null;
        }

        const requestId = Date.now() + Math.random();
        const frames = [{ data: frameData, index: frameIndex }];

        return new Promise((resolve) => {
            const handler = async (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);

                const resultType = cropInfo ? 'crop-analyze-result' : 'analyze-result';
                if (e.data.type === resultType && e.data.results?.[0]) {
                    const result = e.data.results[0];
                    const width = result.width || cropInfo?.size || metadata.width;
                    const height = result.height || cropInfo?.size || metadata.height;

                    // Create color blob from RGBA
                    let colorBlob = null;
                    const rgbaBuffer = result.uint8Buffer || result.float32Buffer;
                    if (rgbaBuffer) {
                        try {
                            let uint8Data;
                            if (result.float32Buffer) {
                                const floatView = new Float32Array(result.float32Buffer);
                                uint8Data = new Uint8ClampedArray(floatView.length);
                                for (let i = 0; i < floatView.length; i++) {
                                    uint8Data[i] = Math.round(floatView[i] * 255);
                                }
                            } else {
                                uint8Data = new Uint8ClampedArray(result.uint8Buffer);
                            }
                            const imageData = new ImageData(uint8Data, width, height);
                            const canvas = new OffscreenCanvas(width, height);
                            const ctx = canvas.getContext('2d');
                            ctx.putImageData(imageData, 0, 0);
                            colorBlob = await canvas.convertToBlob({ type: 'image/png' });
                        } catch (e) {
                            console.warn('[DebayerReader] Color blob creation failed:', e);
                        }
                    }

                    // Create grayscale blob from packedGrayBuffer (8-bit, same as used for analysis)
                    let grayBlob = null;
                    const grayBuffer = result.packedGrayBuffer || result.grayBuffer;
                    if (grayBuffer) {
                        try {
                            const grayView = new Uint8Array(grayBuffer);
                            // Convert 8-bit grayscale to RGBA
                            const grayRgba = new Uint8ClampedArray(width * height * 4);
                            for (let i = 0; i < grayView.length; i++) {
                                const v = grayView[i];
                                grayRgba[i * 4] = v;      // R
                                grayRgba[i * 4 + 1] = v;  // G
                                grayRgba[i * 4 + 2] = v;  // B
                                grayRgba[i * 4 + 3] = 255; // A
                            }
                            const imageData = new ImageData(grayRgba, width, height);
                            const canvas = new OffscreenCanvas(width, height);
                            const ctx = canvas.getContext('2d');
                            ctx.putImageData(imageData, 0, 0);
                            grayBlob = await canvas.convertToBlob({ type: 'image/png' });
                        } catch (e) {
                            console.warn('[DebayerReader] Grayscale blob creation failed:', e);
                        }
                    }

                    resolve({ colorBlob, grayBlob });
                } else {
                    resolve(null);
                }
            };

            gpuWorker.addEventListener('message', handler);

            if (cropInfo) {
                // Use crop-analyze for cropped preview
                gpuWorker.postMessage({
                    type: 'crop-analyze-batch',
                    frames,
                    srcWidth: metadata.width,
                    srcHeight: metadata.height,
                    cropSize: cropInfo.size,
                    centers: [{ x: cropInfo.centerX, y: cropInfo.centerY }],
                    bayerPattern,
                    threshold: 0.1,
                    requestId,
                    metadataOnly: false,
                    grayOnly: false,  // Full demosaic for preview (need both color and gray)
                });
            } else {
                // Full-frame demosaic
                gpuWorker.postMessage({
                    type: 'analyze-batch',
                    frames,
                    width: metadata.width,
                    height: metadata.height,
                    bayerPattern,
                    threshold: 0.1,
                    requestId,
                    metadataOnly: false,
                    grayOnly: false,  // Full demosaic for preview (need both color and gray)
                });
            }
        });
    }

    /**
     * Combined detect + crop + analyze in one GPU pass
     * @param {boolean} grayOnly - If true, skip RGBA output (faster for analysis phase)
     * @param {Array} nextBatchFrames - Optional frames for next batch (pipelined upload)
     * @param {Object} preCropOffset - Optional {x, y, width, height} if frames were pre-cropped
     */
    async function detectCropAnalyzeGpu(frames, cropSize, threshold = 0.1, metadataOnly = false, grayOnly = false, nextBatchFrames = null, preCropOffset = null) {
        if (!gpuWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        // If frames are pre-cropped, use the pre-cropped dimensions
        const srcWidth = preCropOffset ? preCropOffset.width : metadata.width;
        const srcHeight = preCropOffset ? preCropOffset.height : metadata.height;

        const requestId = Date.now() + Math.random();

        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.requestId !== requestId) return;
                gpuWorker.removeEventListener('message', handler);

                if (e.data.type === 'detect-crop-analyze-result') {
                    let results = e.data.results;
                    // Adjust coordinates back to original frame space if pre-cropped
                    if (preCropOffset) {
                        for (const r of results) {
                            if (r.bounds) {
                                r.bounds.x = (r.bounds.x || 0) + preCropOffset.x;
                                r.bounds.y = (r.bounds.y || 0) + preCropOffset.y;
                                r.bounds.centroidX = (r.bounds.centroidX || 0) + preCropOffset.x;
                                r.bounds.centroidY = (r.bounds.centroidY || 0) + preCropOffset.y;
                            }
                            r.centerX = (r.centerX || 0) + preCropOffset.x;
                            r.centerY = (r.centerY || 0) + preCropOffset.y;
                        }
                    }
                    resolve(results);
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
                metadataOnly,
                grayOnly,
                nextBatchFrames,
            });
        });
    }

    /**
     * Crop and analyze with known centers
     */
    async function cropAndAnalyzeGpu(frames, cropSize, centers, threshold = 0.1, metadataOnly = false, useVng = false) {
        if (!gpuWorker || !gpuWorkerReady) {
            throw new Error('GPU worker not initialized');
        }

        const requestId = Date.now() + Math.random();

        return new Promise((resolve, reject) => {
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
                srcWidth: metadata.width,
                srcHeight: metadata.height,
                cropSize,
                centers,
                bayerPattern,
                threshold,
                requestId,
                metadataOnly,
                useVng,
            });
        });
    }

    /**
     * Detect crop region by sampling frames
     */
    async function detectCropRegion(cropMarginPercent = 10) {
        const MIN_SIZE_FOR_CROP = 300;
        if (metadata.width < MIN_SIZE_FOR_CROP || metadata.height < MIN_SIZE_FOR_CROP) {
            addLog(`[DebayerReader] Frame size too small for auto-crop`);
            return null;
        }

        emit('set-caption', 'Detecting object position...');

        // Sample frames for detection
        const sampleCount = Math.min(20, metadata.frameCount);
        const step = Math.max(1, Math.floor(metadata.frameCount / sampleCount));
        const sampleIndices = [];
        for (let i = 0; i < metadata.frameCount && sampleIndices.length < sampleCount; i += step) {
            sampleIndices.push(i);
        }

        addLog(`[DebayerReader] Sampling ${sampleIndices.length} frames for crop detection`);

        // Read sample frames
        const frames = [];
        for (const idx of sampleIndices) {
            const data = await readFrame(idx);
            frames.push({ data, index: idx });
        }

        // Analyze for bounds
        const results = await analyzeFrameBatchGpu(frames, 0.1, true);

        // Calculate crop region from bounds
        const boundsResults = results.filter(r => r.bounds && r.bounds.width > 0);
        if (boundsResults.length < sampleCount * 0.5) {
            addLog(`[DebayerReader] Only ${boundsResults.length}/${sampleCount} frames have valid bounds, skipping auto-crop`);
            return null;
        }

        const sizes = boundsResults.map(r => Math.max(r.bounds.width, r.bounds.height)).sort((a, b) => a - b);
        const medianSize = sizes[Math.floor(sizes.length / 2)];
        const margin = 1 + (cropMarginPercent / 100);
        const cropSize = Math.ceil(medianSize * margin / 2) * 2;

        // Clamp to frame size
        const maxSize = Math.min(metadata.width, metadata.height);
        const finalSize = Math.min(cropSize, maxSize);

        addLog(`[DebayerReader] Detected crop size: ${finalSize}x${finalSize} (median object: ${medianSize})`);

        return {
            size: finalSize,
            medianSize,
        };
    }

    /**
     * Show color profile selector and wait for user choice
     */
    async function showColorProfileSelector(previewBuffer, previewWidth, previewHeight) {
        // Create header with preview dimensions (may be cropped)
        const previewHeader = {
            ...metadata,
            width: previewWidth || metadata.width,
            height: previewHeight || metadata.height,
        };

        return new Promise((resolve) => {
            emit('show-color-profile-selector', {
                header: previewHeader,
                frameBuffer: previewBuffer,
                autoDetectedProfile: bayerChoice,
                resolve: (selectedProfile) => {
                    bayerChoice = selectedProfile;
                    bayerPattern = bayerChoiceToGpuPattern(selectedProfile);
                    addLog(`[DebayerReader] User selected: ${bayerChoice} (GPU: ${bayerPattern})`);
                    resolve(selectedProfile);
                }
            });
        });
    }

    /**
     * Full processing pipeline
     */
    async function processFile(options = {}) {
        const {
            maxFrames = -1,
            manualThreshold = false,
            cropMarginPercent = 10,
            stackPercentage = 30,
            drizzleScale = 1.5,
            surfaceMode = false,
        } = options;

        console.log('[useDebayerReader] processFile called - full pipeline');

        emit('start-loading', 'Initializing...');
        emit('update-loading', 0);

        // Initialize GPU
        const gpuReady = await initGpuWorker();
        if (!gpuReady) {
            throw new Error('Could not initialize GPU worker');
        }

        const frameCount = maxFrames > 0 ? Math.min(maxFrames, metadata.frameCount) : metadata.frameCount;
        addLog(`[DebayerReader] Processing ${frameCount} frames`);

        // Read first frame for preview
        const firstFrameData = await readFrame(0);

        // Detect crop region for preview and crop the preview buffer
        let previewBuffer = firstFrameData.buffer || firstFrameData;
        let previewWidth = metadata.width;
        let previewHeight = metadata.height;
        const MIN_SIZE_FOR_CROP = 300;

        if (metadata.width >= MIN_SIZE_FOR_CROP && metadata.height >= MIN_SIZE_FOR_CROP) {
            emit('set-caption', 'Detecting object for preview...');
            const frames = [{ data: firstFrameData, index: 0 }];
            const results = await analyzeFrameBatchGpu(frames, 0.1, true);

            if (results?.[0]?.bounds?.width > 0) {
                const size = Math.max(results[0].bounds.width, results[0].bounds.height);
                const margin = 1 + (cropMarginPercent / 100);
                const cropSize = Math.min(
                    Math.ceil(size * margin / 2) * 2,
                    Math.min(metadata.width, metadata.height)
                );
                const centerX = results[0].bounds.centroidX;
                const centerY = results[0].bounds.centroidY;

                // Crop the preview buffer
                const bpp = metadata.bytesPerPixel || (metadata.bpp ? metadata.bpp / 8 : 1);
                const halfSize = Math.floor(cropSize / 2);
                let startX = Math.max(0, Math.min(metadata.width - cropSize, Math.round(centerX) - halfSize));
                let startY = Math.max(0, Math.min(metadata.height - cropSize, Math.round(centerY) - halfSize));
                // Align to even pixels for Bayer pattern
                startX = Math.floor(startX / 2) * 2;
                startY = Math.floor(startY / 2) * 2;

                const croppedBuffer = new ArrayBuffer(cropSize * cropSize * bpp);
                const srcView = bpp === 2 ? new Uint16Array(previewBuffer) : new Uint8Array(previewBuffer);
                const dstView = bpp === 2 ? new Uint16Array(croppedBuffer) : new Uint8Array(croppedBuffer);

                for (let y = 0; y < cropSize; y++) {
                    const srcOffset = (startY + y) * metadata.width + startX;
                    const dstOffset = y * cropSize;
                    dstView.set(srcView.subarray(srcOffset, srcOffset + cropSize), dstOffset);
                }

                previewBuffer = croppedBuffer;
                previewWidth = cropSize;
                previewHeight = cropSize;
                addLog(`[DebayerReader] Cropped preview to ${cropSize}x${cropSize} for color selector`);
            }
        }

        // Show color profile selector with cropped preview
        emit('set-caption', 'Select color profile');
        await showColorProfileSelector(previewBuffer, previewWidth, previewHeight);

        // Detect full crop region
        let cropRegion = null;
        if (metadata.width >= MIN_SIZE_FOR_CROP && metadata.height >= MIN_SIZE_FOR_CROP) {
            cropRegion = await detectCropRegion(cropMarginPercent);
        }

        // Analysis phase
        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
        const bestFramesForStacking = [];
        const allAnalyzedFrames = [];
        let bestFrameSoFar = null;
        let cutOffFrameCount = 0;  // Track frames skipped due to object touching edge

        // CPU pre-crop region - updated after each batch based on detected bounds
        // This reduces GPU upload size significantly after the first batch
        let preCropRegion = null;  // {x, y, width, height} or null for full frames

        // Timing stats for analysis phase
        const analysisStats = {
            frameLoadMs: [],
            gpuDemosaicMs: [],
            startTime: performance.now()
        };

        // Dynamic batch size based on frame dimensions
        // grayOnly mode uses ~4 bytes/pixel (grayscale float32) vs 16 bytes/pixel (RGBA float32)
        // So we can fit ~4x more frames per batch in grayOnly mode
        const bytesPerPixel = 4; // grayscale float32 for analysis
        const frameBytes = metadata.width * metadata.height * bytesPerPixel;
        const targetBatchMemory = 512 * 1024 * 1024; // 512MB target
        const maxBatchSize = Math.max(1, Math.min(256, Math.floor(targetBatchMemory / frameBytes)));
        const BATCH_SIZE = maxBatchSize;
        addLog(`[DebayerReader] Using batch size ${BATCH_SIZE} for ${metadata.width}x${metadata.height} frames (grayOnly analysis)`);

        let completedFrames = 0;

        // Helper to load a batch in parallel
        async function loadBatch(start, end) {
            const indices = [];
            for (let i = start; i < end && i < frameCount; i++) {
                indices.push(i);
            }
            const frameDataArray = await Promise.all(indices.map(i => readFrame(i)));
            // Debug: log first frame data type for 16-bit detection
            if (start === 0 && frameDataArray.length > 0) {
                const first = frameDataArray[0];
                console.log(`[DebayerReader] loadBatch first frame: type=${first.constructor?.name}, length=${first.length}, is16bit=${first instanceof Uint16Array}, metadata.pixelDepth=${metadata.pixelDepth}`);
            }
            return frameDataArray.map((data, idx) => ({ data, index: indices[idx] }));
        }

        // Async pre-crop using worker (runs in parallel with GPU on separate CPU core)
        function preCropAsync(frames, region) {
            if (!region || !frames || frames.length === 0) {
                return Promise.resolve({ frames, offset: null });
            }

            // Initialize worker on first use
            if (!preCropWorker) {
                preCropWorker = new Worker(workerUrl('/precrop_worker.js'));
            }

            const requestId = ++preCropRequestId;
            return new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data.requestId !== requestId) return;
                    preCropWorker.removeEventListener('message', handler);
                    resolve({ frames: e.data.frames, offset: e.data.offset });
                };
                preCropWorker.addEventListener('message', handler);

                // Transfer frame buffers to worker for zero-copy
                const transferList = frames.map(f => f.data.buffer);
                preCropWorker.postMessage({
                    frames,
                    srcWidth: metadata.width,
                    srcHeight: metadata.height,
                    region,
                    requestId
                }, transferList);
            });
        }

        // Pipeline: load first batch
        let nextBatchPromise = loadBatch(0, BATCH_SIZE);

        // Process in batches with pipelining (both file load AND GPU upload)
        // Load two batches ahead to enable GPU upload pipelining
        let currentFrames = await nextBatchPromise;
        let nextFramesPromise = frameCount > BATCH_SIZE ? loadBatch(BATCH_SIZE, BATCH_SIZE * 2) : null;

        // Pre-crop state for async parallel processing
        let pendingPreCrop = null;  // Promise for pre-crop started in previous iteration

        // GPU pipelining: keep track of in-flight GPU calls to overlap (up to 3 concurrent)
        const MAX_GPU_CONCURRENT = 2;
        const pendingGpuBatches = [];  // Array of { promise, info } for in-flight batches

        // Helper to process results from a completed GPU batch
        function processGpuResults(results, info) {
            const { batchStart: resultBatchStart, frames: resultFrames, preCropOffset: resultPreCropOffset } = info;

            completedFrames += results.length;

            // DEBUG: Log first few frames to check for duplicate sharpness values
            if (resultBatchStart === 0 && results.length > 0) {
                const debugSharpness = results.slice(0, Math.min(5, results.length))
                    .map(r => `#${r.index}:${r.sharpness.toFixed(2)}`).join(', ');
                console.log(`[DebayerReader DEBUG] First batch sharpness: ${debugSharpness}`);
            }

            for (const result of results) {
                // Skip cut-off frames (object touching edge of frame)
                // But NOT in surface mode - lunar/solar surfaces are intentionally zoomed in
                if (result.cutOff && !surfaceMode) {
                    cutOffFrameCount++;
                    continue;
                }

                const frameWidth = result.width || cropRegion?.size || metadata.width;
                const frameHeight = result.height || cropRegion?.size || metadata.height;

                const frame = {
                    index: result.index,
                    sharpness: result.sharpness,
                    tenengrad: result.tenengrad,
                    laplacian: result.laplacian,
                    circularity: result.circularity || 0,
                    centerX: result.bounds?.centroidX || metadata.width / 2,
                    centerY: result.bounds?.centroidY || metadata.height / 2,
                    width: frameWidth,
                    height: frameHeight,
                    blob: null,  // Will be populated on-demand for best frame
                };

                // Track all frames for manual threshold
                if (manualThreshold) {
                    allAnalyzedFrames.push(frame);
                }

                // Streaming best-frame ranking
                if (bestFramesForStacking.length < bestFramesCapacity) {
                    bestFramesForStacking.push(frame);
                } else {
                    const minIdx = bestFramesForStacking.reduce((minI, f, i, arr) =>
                        f.sharpness < arr[minI].sharpness ? i : minI, 0);
                    if (frame.sharpness > bestFramesForStacking[minIdx].sharpness) {
                        bestFramesForStacking[minIdx] = frame;
                    }
                }

                // Track best frame for preview - do COLOR demosaic just for this frame
                if (!bestFrameSoFar || frame.sharpness > bestFrameSoFar.sharpness) {
                    bestFrameSoFar = frame;

                    // Do separate color demosaic for preview (async, non-blocking)
                    // When pre-crop is active, frames have smaller data or detached buffers, so re-read from disk
                    // This is rare (only for best frame updates) so disk read is acceptable
                    let frameDataPromise;
                    if (resultPreCropOffset) {
                        frameDataPromise = readFrame(result.index);
                    } else {
                        const existingData = resultFrames.find(f => f.index === result.index)?.data;
                        frameDataPromise = existingData ? Promise.resolve(existingData) : readFrame(result.index);
                    }

                    frameDataPromise.then(frameData => {
                        if (!frameData) return;
                        // Use crop info if available (centered on detected planet)
                        const cropInfo = cropRegion ? {
                            size: cropRegion.size,
                            centerX: frame.centerX,
                            centerY: frame.centerY
                        } : null;

                        demosaicFrameForPreview(frameData, result.index, cropInfo).then(blobs => {
                            if (blobs && bestFrameSoFar.index === result.index) {
                                // Store both color and grayscale blobs for side-by-side preview
                                bestFrameSoFar.blob = blobs.colorBlob;
                                bestFrameSoFar.grayBlob = blobs.grayBlob;
                                emit('best-frame-updated', bestFrameSoFar);
                            }
                        });
                    });
                }
            }

            // Update CPU pre-crop region based on detected bounds from this batch
            // This tracks the planet as it drifts across frames
            // Skip in surface mode (whole frame is target, pre-crop makes no sense)
            if (cropRegion && !surfaceMode && results.length > 0) {
                const batchBounds = results.map(r => r.bounds).filter(b => b && !b.cutOff);
                const newRegion = computePreCropRegion(batchBounds, metadata.width, metadata.height, 1.5);
                if (newRegion) {
                    // Only enable pre-crop if it provides meaningful reduction (>10%)
                    const reduction = ((metadata.width * metadata.height) - (newRegion.width * newRegion.height)) / (metadata.width * metadata.height) * 100;
                    if (reduction > 10) {
                        // Only update if region changed significantly (avoid jitter)
                        if (!preCropRegion ||
                            Math.abs(newRegion.x - preCropRegion.x) > 10 ||
                            Math.abs(newRegion.y - preCropRegion.y) > 10) {
                            preCropRegion = newRegion;
                            if (resultBatchStart === 0) {
                                addLog(`[DebayerReader] CPU pre-crop enabled: ${newRegion.width}x${newRegion.height} (${reduction.toFixed(0)}% upload reduction)`);
                            }
                        }
                    }
                }
            }

            const processedSoFar = resultBatchStart + resultFrames.length;
            emit('update-loading', {
                progress: (processedSoFar / frameCount) * 100,
                current: processedSoFar,
                total: frameCount
            });
        }

        for (let batchStart = 0; batchStart < frameCount; batchStart += BATCH_SIZE) {
            const t0Load = performance.now();
            let frames = currentFrames;
            analysisStats.frameLoadMs.push(performance.now() - t0Load);

            if (!frames || frames.length === 0) break;

            // Get next batch frames for GPU pipelining (already loading)
            const nextStart = batchStart + BATCH_SIZE;
            const hasNextBatch = nextStart < frameCount;
            let nextBatchFrames = null;

            if (hasNextBatch && nextFramesPromise) {
                // Wait for next batch (should be ready or nearly ready)
                // Include this in frame loading time since it's I/O
                const t0NextLoad = performance.now();
                nextBatchFrames = await nextFramesPromise;
                analysisStats.frameLoadMs.push(performance.now() - t0NextLoad);

                // Start loading the batch after that
                const nextNextStart = nextStart + BATCH_SIZE;
                if (nextNextStart < frameCount) {
                    nextFramesPromise = loadBatch(nextNextStart, nextNextStart + BATCH_SIZE);
                } else {
                    nextFramesPromise = null;
                }
            }

            // Apply pre-crop if we have a pending result from previous iteration
            // Pre-crop runs in separate worker, parallel with GPU
            let preCropOffset = null;
            if (pendingPreCrop) {
                const preCropped = await pendingPreCrop;
                frames = preCropped.frames;
                preCropOffset = preCropped.offset;
                pendingPreCrop = null;
            }

            // Start pre-cropping next batch async (runs on separate CPU core while GPU works)
            // Skip in surface mode (whole frame is target)
            if (preCropRegion && cropRegion && !surfaceMode && nextBatchFrames) {
                pendingPreCrop = preCropAsync(nextBatchFrames, preCropRegion);
            }

            // Fire GPU call for current batch (don't await yet - overlap with other batches)
            const t0Demosaic = performance.now();
            // Use higher threshold for 16-bit data (stretched background can hit 0.1)
            const boundsThreshold = metadata.pixelDepth > 8 ? 0.15 : 0.1;
            let gpuPromise;
            if (cropRegion) {
                gpuPromise = detectCropAnalyzeGpu(frames, cropRegion.size, boundsThreshold, !manualThreshold, true, null, preCropOffset);
            } else {
                gpuPromise = analyzeFrameBatchGpu(frames, boundsThreshold, !manualThreshold, true);
            }
            const gpuInfo = { batchStart, frames, preCropOffset, t0Demosaic };

            // Add current batch to pending queue
            pendingGpuBatches.push({ promise: gpuPromise, info: gpuInfo });

            // If we have MAX_GPU_CONCURRENT batches in flight, wait for the oldest to complete
            // This keeps (MAX_GPU_CONCURRENT - 1) batches in the queue after processing
            if (pendingGpuBatches.length >= MAX_GPU_CONCURRENT) {
                const oldest = pendingGpuBatches.shift();
                const prevResults = await oldest.promise;
                analysisStats.gpuDemosaicMs.push(performance.now() - oldest.info.t0Demosaic);
                processGpuResults(prevResults, oldest.info);
            }

            // Move next batch to current for next iteration (original frames, will be pre-cropped next iteration)
            currentFrames = nextBatchFrames;
        }

        // Drain remaining pending batches (no more batches to overlap with)
        for (const pending of pendingGpuBatches) {
            const results = await pending.promise;
            analysisStats.gpuDemosaicMs.push(performance.now() - pending.info.t0Demosaic);
            processGpuResults(results, pending.info);
        }

        // Log analysis phase performance summary
        const analysisElapsed = performance.now() - analysisStats.startTime;
        const avgLoad = analysisStats.frameLoadMs.length ? (analysisStats.frameLoadMs.reduce((a, b) => a + b, 0) / analysisStats.frameLoadMs.length).toFixed(1) : '0';
        const avgDemosaic = analysisStats.gpuDemosaicMs.length ? (analysisStats.gpuDemosaicMs.reduce((a, b) => a + b, 0) / analysisStats.gpuDemosaicMs.length).toFixed(1) : '0';
        const totalLoad = analysisStats.frameLoadMs.reduce((a, b) => a + b, 0);
        const totalDemosaic = analysisStats.gpuDemosaicMs.reduce((a, b) => a + b, 0);
        const pctLoad = analysisElapsed > 0 ? ((totalLoad / analysisElapsed) * 100).toFixed(0) : '0';
        const pctDemosaic = analysisElapsed > 0 ? ((totalDemosaic / analysisElapsed) * 100).toFixed(0) : '0';

        addLog(`─── Analysis Performance Summary ───`);
        addLog(`Total time: ${(analysisElapsed / 1000).toFixed(1)}s for ${completedFrames} frames`);
        addLog(`Frame loading (disk): ${avgLoad}ms avg, ${(totalLoad / 1000).toFixed(1)}s total (${pctLoad}%)`);
        addLog(`GPU analysis: ${avgDemosaic}ms avg, ${(totalDemosaic / 1000).toFixed(1)}s total (${pctDemosaic}%)`);
        addLog(`────────────────────────────────────`);

        addLog(`[DebayerReader] Analysis complete. Best ${bestFramesForStacking.length} frames selected.`);
        if (cutOffFrameCount > 0) {
            addLog(`[DebayerReader] ${cutOffFrameCount} frames skipped (object cut off at edge)`);
        }

        // DEBUG: Check for duplicate sharpness values
        if (manualThreshold && allAnalyzedFrames.length > 0) {
            const sharpnessMap = new Map();
            for (const f of allAnalyzedFrames) {
                const key = f.sharpness.toFixed(2);
                if (!sharpnessMap.has(key)) sharpnessMap.set(key, []);
                sharpnessMap.get(key).push(f.index);
            }
            const duplicates = [...sharpnessMap.entries()].filter(([k, v]) => v.length > 1);
            if (duplicates.length > 0) {
                console.warn(`[DebayerReader DEBUG] Found ${duplicates.length} duplicate sharpness values:`);
                duplicates.slice(0, 5).forEach(([sharpness, indices]) => {
                    console.warn(`  Sharpness ${sharpness}: frames ${indices.join(', ')}`);
                });
            }
        }

        // Create frameReReader with analysis results
        const frameReReader = createFrameReReader({
            cropRegion,
            analysisStartTime: analysisStats.startTime
        });

        // Manual threshold handling - emit to app.vue and return
        if (manualThreshold && allAnalyzedFrames.length > 0) {
            // Add width/height to frames for QualitySelector display
            const previewSize = cropRegion?.size || metadata.width;
            const framesWithSize = allAnalyzedFrames.map(f => ({
                ...f,
                width: previewSize,
                height: previewSize
            }));
            const allFramesSorted = [...framesWithSize].sort((a, b) => b.sharpness - a.sharpness);
            addLog(`Ready for manual threshold selection with ${allFramesSorted.length} frames`);
            emit('quality-selection-ready', {
                frames: allFramesSorted,
                workers: [], // GPU mode creates its own workers
                useWebGPU: true,
                drizzleScale,
                frameReReader,
                surfaceMode
            });
            return; // app.vue handles quality selection and stacking
        }

        // Check for no valid frames before attempting to stack
        if (bestFramesForStacking.length === 0) {
            let errorMsg = 'No valid frames could be processed for stacking.';

            if (cutOffFrameCount > 0 && cutOffFrameCount >= completedFrames * 0.9) {
                // Most or all frames were cut-off
                errorMsg = `All ${cutOffFrameCount} frames were rejected because the object touches the frame edge. Please select "Surface" mode for close-up Moon/Sun images, or use a wider field of view.`;
            }

            addLog(`[DebayerReader] ${errorMsg}`);
            emit('upload-error', errorMsg);
            emit('stack-failed', { component: 'useDebayerReader', reason: 'no valid frames', details: { cutOffFrameCount, completedFrames } });
            emit('stop-loading');
            terminateGpuWorker();
            return;
        }

        // Stacking phase (automatic threshold mode)
        emit('set-caption', 'Stacking frames...');
        addLog(`[DebayerReader] Starting stacking of ${bestFramesForStacking.length} frames`);

        emit('stacking-started', {
            referenceFrame: bestFramesForStacking[0],
            totalFrames: bestFramesForStacking.length
        });

        // Use stackFramesLocally from useStacker
        const stackResult = await stackFramesLocally(
            bestFramesForStacking,
            null, // reference frame (auto)
            drizzleScale,
            true, // useWebGPU
            frameReReader,
            surfaceMode
        );

        if (stackResult?.blob) {
            addLog('[DebayerReader] Stacking complete');
            emit('stacked-image-ready', {
                blob: stackResult.blob,
                float32Data: stackResult.float32Data,
                width: stackResult.width,
                height: stackResult.height
            });
        } else {
            addLog('[DebayerReader] Stacking failed - no valid result');
            emit('stack-failed', { reason: 'no valid frames' });
            emit('stop-loading');
        }

        // Cleanup
        terminateGpuWorker();
    }

    /**
     * Cleanup resources
     */
    function cleanup() {
        terminateGpuWorker();
        file = null;
        parser = null;
        metadata = null;
    }

    return {
        init,
        processFile,
        cleanup,
        // Expose internals for testing/debugging
        getMetadata: () => metadata,
        initGpuWorker,
        terminateGpuWorker,
        readFrame,
        createFrameReReader,
        analyzeFrameBatchGpu,
        detectCropAnalyzeGpu,
        cropAndAnalyzeGpu,
        detectCropRegion,
        showColorProfileSelector,
    };
}

export default useDebayerReader;
