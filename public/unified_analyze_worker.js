// public/unified_analyze_worker.js
console.log('unified_analyze_worker.js loaded (v36 - WebGPU via main thread)');

// Use _cv to avoid conflicts with global 'cv' from opencv-bindings
let _cv = null;
let isCvReady = false;
const messageQueue = [];
let loggedDemosaicMethod = false; // Log demosaic method once per worker

/**
 * Safari-safe wrapper for OffscreenCanvas.convertToBlob()
 * Safari's encoder can fail under memory pressure - retry once on failure
 */
async function safeConvertToBlob(canvas, options = { type: 'image/png' }) {
    try {
        return await canvas.convertToBlob(options);
    } catch (e) {
        // Safari sometimes fails on first try - retry once after a brief delay
        console.warn('convertToBlob failed, retrying:', e.message || e);
        await new Promise(r => setTimeout(r, 100));
        return await canvas.convertToBlob(options);
    }
}

/**
 * Calculate bytes per pixel for AVI formats, accounting for 8-bit DIB (grayscale)
 */
function getAviBytesPerPixel(header) {
    let fourCC = header.fourCC;
    const bpp = header.bpp;
    // Null fourCC from FFmpeg rawvideo is uncompressed BGR like DIB
    if (fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00') {
        fourCC = 'DIB ';
    }
    // DIB/RGB with bpp=8 is 8-bit grayscale, not 24-bit BGR
    if ((fourCC === 'DIB ' || fourCC === 'RGB ') && bpp === 8) {
        return 1;
    }
    return { 'DIB ': 3, 'RGB ': 3, 'Y800': 1, 'YUY2': 2, 'UYVY': 2, 'RGBA': 4 }[fourCC] || 3;
}

// Load OpenCV
self.importScripts('https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js');

// Wait for OpenCV WASM and then call callback
function waitForOpenCV(onReady, onError) {
    // Check if already ready
    if (self.cv && typeof self.cv.Mat === 'function') {
        onReady(self.cv);
        return;
    }

    // Poll for cv.Mat to become available
    let attempts = 0;
    const maxAttempts = 200; // 20 seconds max
    const checkInterval = setInterval(() => {
        attempts++;
        if (self.cv && typeof self.cv.Mat === 'function') {
            clearInterval(checkInterval);
            onReady(self.cv);
        } else if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            onError(new Error('OpenCV WASM initialization timeout'));
        }
    }, 100);
}

self.addEventListener('message', (e) => {
    if (e.data.type === 'init') {
        waitForOpenCV(
            (cv) => {
                _cv = cv;
                isCvReady = true;

                self.postMessage({ type: 'ready' });

                // Process any queued messages
                while (messageQueue.length > 0) {
                    handleMessage(messageQueue.shift());
                }
            },
            (error) => {
                console.error('Worker: OpenCV init failed:', error);
                self.postMessage({ type: 'error', message: error.message });
            }
        );
    } else {
        if (!isCvReady || !_cv) {
            messageQueue.push(e);
        } else {
            handleMessage(e);
        }
    }
});


async function handleMessage(e) {
    const { type, index } = e.data;

    try {
        // Ensure _cv is defined here before using it
        if (!_cv) {
             throw new Error("OpenCV (_cv) is not initialized in worker.");
        }

        // Frame stacking with local alignment (CPU path)
        if (type === 'stack-frames') {
            const { frames, drizzleScale = 1.0, noiseRobustAlignment = false, surfaceMode = false } = e.data;
            try {
                const result = await stackFramesLocally(frames, drizzleScale, noiseRobustAlignment, surfaceMode);
                // Transfer float32Data buffer for zero-copy
                const transferables = result.float32Data ? [result.float32Data.buffer] : [];
                self.postMessage({
                    type: 'stack-complete',
                    blob: result.blob,
                    width: result.width,
                    height: result.height,
                    float32Buffer: result.float32Data ? result.float32Data.buffer : null
                }, transferables);
            } catch (stackError) {
                console.error('Stacking error:', stackError);
                self.postMessage({ type: 'stack-error', error: stackError.message || String(stackError) });
            }
            return;
        }

        // Prepare alignment data for external GPU processing
        if (type === 'prepare-alignment') {
            const { refFrame, refIndex, surfaceMode = false } = e.data;
            try {
                const result = await prepareAlignmentData(refFrame, surfaceMode);
                self.postMessage({
                    type: 'alignment-prepared',
                    alignmentPoints: result.alignmentPoints,
                    refGrayData: result.refGrayData,
                    refIndex: refIndex,
                    patchSize: result.patchSize,
                    searchRadius: result.searchRadius,
                    width: result.width,
                    height: result.height
                }, [result.refGrayData.buffer]);
            } catch (err) {
                self.postMessage({ type: 'prepare-error', error: err.message });
            }
            return;
        }

        // Stack with pre-computed shifts (for external GPU alignment)
        if (type === 'stack-with-shifts') {
            const { frames, frameShifts, alignmentPoints, refIndex, drizzleScale = 1.0, patchSize = 64 } = e.data;
            try {
                const result = await stackWithPrecomputedShifts(frames, frameShifts, alignmentPoints, refIndex, drizzleScale, patchSize);
                // Transfer float32Data buffer for zero-copy
                const transferables = result.float32Data ? [result.float32Data.buffer] : [];
                self.postMessage({
                    type: 'stack-complete',
                    blob: result.blob,
                    width: result.width,
                    height: result.height,
                    float32Buffer: result.float32Data ? result.float32Data.buffer : null
                }, transferables);
            } catch (stackError) {
                console.error('Stacking error:', stackError);
                self.postMessage({ type: 'stack-error', error: stackError.message || String(stackError) });
            }
            return;
        }

        // Bounding box detection for first pass (crop detection)
        if (type === 'detect-bounds') {
            const { frameBuffer, header, bayerChoice } = e.data;
            const bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            self.postMessage({ type: 'bounds', bounds, index });
            return;
        }

        // Bounding box detection from PNG data (for image files)
        if (type === 'detect-bounds-png') {
            const { pngData } = e.data;
            const bounds = await detectObjectBoundsFromPng(pngData);
            self.postMessage({ type: 'bounds', bounds, index });
            return;
        }

        // =====================================================
        // TWO-PASS MEMORY OPTIMIZATION HANDLERS
        // =====================================================

        // Pass 1: Metadata-only analysis - returns sharpness/bounds without storing float32Buffer
        // This dramatically reduces memory usage during analysis phase
        if (type === 'analyze-metadata-only') {
            const { frameBuffer, header, bayerChoice, cropRegion } = e.data;

            try {
                // Validate buffer size
                let expectedSize;
                if (header.fileId && header.fileId.startsWith('LUCAM-REC')) {
                    expectedSize = header.width * header.height * (header.pixelDepth > 8 ? 2 : 1);
                } else {
                    const bytesPerPixel = getAviBytesPerPixel(header);
                    expectedSize = header.width * header.height * bytesPerPixel;
                }
                if (frameBuffer.byteLength !== expectedSize) {
                    self.postMessage({ type: 'metadata', skipped: true, reason: 'buffer-mismatch', index });
                    return;
                }

                // Step 1: Detect bounds for this frame
                let bounds;
                try {
                    bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
                } catch (boundsError) {
                    bounds = { canCrop: false, reason: 'detection-error' };
                }

                // Check for cut-off frames (skip this check for Sun/Moon targets)
                if (bounds.reason === 'cut-off' && !e.data.surfaceMode) {
                    self.postMessage({ type: 'metadata', skipped: true, reason: 'cut-off', is_cut_off: true, index });
                    return;
                }

                // Check for oversized frames
                if (bounds.canCrop && bounds.size && cropRegion && cropRegion.medianObjectSize) {
                    const sizeRatio = bounds.size / cropRegion.medianObjectSize;
                    if (sizeRatio > 1.1) {
                        self.postMessage({ type: 'metadata', skipped: true, reason: 'oversized', is_oversized: true, index });
                        return;
                    }
                }

                // Calculate crop parameters for this frame
                let subPixelOffset = { x: 0, y: 0 };
                let centerX = bounds.canCrop ? bounds.centerX : (cropRegion?.referenceCenter?.x || header.width / 2);
                let centerY = bounds.canCrop ? bounds.centerY : (cropRegion?.referenceCenter?.y || header.height / 2);

                if (cropRegion && cropRegion.size) {
                    const halfSize = cropRegion.size / 2;
                    let idealCropX = Math.floor(centerX - halfSize);
                    let idealCropY = Math.floor(centerY - halfSize);
                    idealCropX = idealCropX & ~1; // Even alignment for Bayer
                    idealCropY = idealCropY & ~1;

                    const cropCenterX = idealCropX + cropRegion.size / 2;
                    const cropCenterY = idealCropY + cropRegion.size / 2;
                    subPixelOffset = {
                        x: centerX - cropCenterX,
                        y: centerY - cropCenterY
                    };
                }

                // Step 2: Calculate sharpness using 8-bit conversion (lightweight)
                // We demosaic a small portion or use grayscale for sharpness calculation
                const sharpness = await calculateSharpnessLightweight(frameBuffer, header, bayerChoice, cropRegion, bounds);

                // Return metadata only - no float32Buffer, no pngBlob
                self.postMessage({
                    type: 'metadata',
                    index,
                    sharpness,
                    circularity: bounds.circularity || 0,
                    centerX,
                    centerY,
                    subPixelOffset,
                    is_cut_off: false,
                    is_oversized: false
                });
            } catch (error) {
                const errorMsg = typeof error === 'number'
                    ? `OpenCV error code: ${error}`
                    : (error.message || String(error));
                console.error(`analyze-metadata-only error for frame ${index}:`, errorMsg);
                self.postMessage({ type: 'metadata', skipped: true, reason: 'error', error: errorMsg, index });
            }
            return;
        }

        // Pass 2: Process frame for stacking - full demosaic + crop to float32Buffer
        // Called on-demand during stacking for selected frames only
        if (type === 'process-for-stacking') {
            const { frameBuffer, header, bayerChoice, cropRegion, centerX, centerY } = e.data;

            try {
                // Validate buffer size
                let expectedSize;
                if (header.fileId && header.fileId.startsWith('LUCAM-REC')) {
                    expectedSize = header.width * header.height * (header.pixelDepth > 8 ? 2 : 1);
                } else {
                    const bytesPerPixel = getAviBytesPerPixel(header);
                    expectedSize = header.width * header.height * bytesPerPixel;
                }
                if (frameBuffer.byteLength !== expectedSize) {
                    self.postMessage({ type: 'stacking-frame', skipped: true, reason: 'buffer-mismatch', index });
                    return;
                }

                // Calculate crop region with the provided center
                let actualCropRegion = null;
                let subPixelOffset = { x: 0, y: 0 };

                if (cropRegion && cropRegion.size && centerX !== undefined && centerY !== undefined) {
                    const halfSize = cropRegion.size / 2;
                    let idealCropX = Math.floor(centerX - halfSize);
                    let idealCropY = Math.floor(centerY - halfSize);
                    idealCropX = idealCropX & ~1;
                    idealCropY = idealCropY & ~1;

                    const padLeft = Math.max(0, -idealCropX);
                    const padTop = Math.max(0, -idealCropY);
                    const padRight = Math.max(0, (idealCropX + cropRegion.size) - header.width);
                    const padBottom = Math.max(0, (idealCropY + cropRegion.size) - header.height);

                    const cropCenterX = idealCropX + cropRegion.size / 2;
                    const cropCenterY = idealCropY + cropRegion.size / 2;
                    subPixelOffset = {
                        x: centerX - cropCenterX,
                        y: centerY - cropCenterY
                    };

                    actualCropRegion = {
                        x: idealCropX,
                        y: idealCropY,
                        size: cropRegion.size,
                        padding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom },
                        subPixelOffset
                    };
                }

                // Full processing: demosaic + crop + convert to float32
                const result = await processRawFrameWithOpenCV(
                    frameBuffer, header, bayerChoice, actualCropRegion, index,
                    true,  // includeRgba = true
                    true   // skipAnalysis = true (we already have sharpness)
                );

                if (result.skipped) {
                    self.postMessage({ type: 'stacking-frame', skipped: true, reason: result.reason, index });
                    return;
                }

                self.postMessage({
                    type: 'stacking-frame',
                    float32Buffer: result.float32Buffer,
                    width: result.width,
                    height: result.height,
                    subPixelOffset,
                    index
                }, [result.float32Buffer]);
            } catch (error) {
                const errorMsg = typeof error === 'number'
                    ? `OpenCV error code: ${error}`
                    : (error.message || String(error));
                console.error(`process-for-stacking error for frame ${index}:`, errorMsg);
                self.postMessage({ type: 'stacking-frame', skipped: true, reason: 'error', error: errorMsg, index });
            }
            return;
        }

        // Analyze PNG with cropping (for image files)
        if (type === 'analyze-cropped-png') {
            const { pngData, cropRegion, includeRgba, surfaceMode } = e.data;
            const result = await analyzeAndCropPng(pngData, cropRegion, index, includeRgba, surfaceMode);
            if (result.skipped) {
                self.postMessage({ skipped: true, reason: result.reason, index });
                return;
            }
            const response = {
                sharpness: result.sharpness,
                pngBlob: result.pngBlob,
                index,
                circularity: result.circularity || 0
            };
            if (includeRgba && result.float32Buffer) {
                response.float32Buffer = result.float32Buffer;
                response.width = result.width;
                response.height = result.height;
                self.postMessage(response, [result.float32Buffer]);
            } else {
                self.postMessage(response);
            }
            return;
        }

        // Crop-only mode: detect + crop, return RGBA for GPU analysis (skip sharpness/PNG)
        if (type === 'crop-only') {
            const { frameBuffer, header, bayerChoice, cropRegion, capturePreCrop } = e.data;

            // Validate buffer size (same check as analyze-cropped)
            let expectedSize;
            if (header.fileId && header.fileId.startsWith('LUCAM-REC')) {
                expectedSize = header.width * header.height * (header.pixelDepth > 8 ? 2 : 1);
            } else {
                const bytesPerPixel = getAviBytesPerPixel(header);
                expectedSize = header.width * header.height * bytesPerPixel;
            }
            if (frameBuffer.byteLength !== expectedSize) {
                console.error(`crop-only: Buffer size mismatch: got ${frameBuffer.byteLength}, expected ${expectedSize}`);
                self.postMessage({ skipped: true, reason: 'buffer-mismatch', index });
                return;
            }

            // Check if object is cut-off (partially outside frame)
            let bounds;
            try {
                bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            } catch (boundsError) {
                bounds = { canCrop: false, reason: 'detection-error' };
            }

            // Skip frames where the object is cut-off (unless surfaceMode for Sun/Moon)
            if (bounds.reason === 'cut-off' && !e.data.surfaceMode) {
                self.postMessage({ skipped: true, reason: 'cut-off', index });
                return;
            }

            // Skip oversized objects
            if (bounds.canCrop && bounds.size && cropRegion && cropRegion.medianObjectSize) {
                const sizeRatio = bounds.size / cropRegion.medianObjectSize;
                if (sizeRatio > 1.1) {
                    self.postMessage({ skipped: true, reason: 'oversized', index });
                    return;
                }
            }

            let actualCropRegion = null;
            if (cropRegion && cropRegion.size) {
                let centerX, centerY;
                if (bounds.canCrop && bounds.centerX !== undefined) {
                    centerX = bounds.centerX;
                    centerY = bounds.centerY;
                } else if (cropRegion.referenceCenter) {
                    centerX = cropRegion.referenceCenter.x;
                    centerY = cropRegion.referenceCenter.y;
                } else {
                    self.postMessage({ skipped: true, reason: bounds.reason || 'no-center', index });
                    return;
                }

                const halfSize = cropRegion.size / 2;
                let idealCropX = Math.floor(centerX - halfSize);
                let idealCropY = Math.floor(centerY - halfSize);
                idealCropX = idealCropX & ~1;
                idealCropY = idealCropY & ~1;

                const padLeft = Math.max(0, -idealCropX);
                const padTop = Math.max(0, -idealCropY);
                const padRight = Math.max(0, (idealCropX + cropRegion.size) - header.width);
                const padBottom = Math.max(0, (idealCropY + cropRegion.size) - header.height);

                const cropCenterX = idealCropX + cropRegion.size / 2;
                const cropCenterY = idealCropY + cropRegion.size / 2;
                const subPixelOffsetX = centerX - cropCenterX;
                const subPixelOffsetY = centerY - cropCenterY;

                actualCropRegion = {
                    x: idealCropX,
                    y: idealCropY,
                    size: cropRegion.size,
                    padding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom },
                    subPixelOffset: { x: subPixelOffsetX, y: subPixelOffsetY }
                };
            }

            if (cropRegion && !actualCropRegion) {
                self.postMessage({ skipped: true, reason: 'crop-failed', index });
                return;
            }

            // Process with skipAnalysis=true (no sharpness/PNG, just RGBA)
            // Pass capturePreCrop to get full frame RGBA before cropping
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, actualCropRegion, index, false, true, capturePreCrop);

            const response = {
                float32Buffer: result.float32Buffer,
                width: result.width,
                height: result.height,
                subPixelOffset: actualCropRegion?.subPixelOffset || { x: 0, y: 0 },
                index
            };

            // Include pre-crop RGBA if captured (for comparison video)
            const transferables = [result.float32Buffer];
            if (result.preCropRgbaBuffer) {
                response.preCropRgbaBuffer = result.preCropRgbaBuffer;
                response.preCropWidth = result.preCropWidth;
                response.preCropHeight = result.preCropHeight;
                transferables.push(result.preCropRgbaBuffer);
            }

            self.postMessage(response, transferables);
            return;
        }

        // Analyze with optional cropping - uses fixed reference center for stable positioning
        if (type === 'analyze-cropped') {
            const { frameBuffer, header, bayerChoice, cropRegion, capturePreCrop } = e.data;

            // Calculate expected size based on file type
            let expectedSize;
            if (header.fileId && header.fileId.startsWith('LUCAM-REC')) {
                // SER file: single channel
                expectedSize = header.width * header.height * (header.pixelDepth > 8 ? 2 : 1);
            } else {
                // AVI file (or RGBA from decoded PNG): use fourCC to determine channels
                const bytesPerPixel = getAviBytesPerPixel(header);
                expectedSize = header.width * header.height * bytesPerPixel;
            }
            if (frameBuffer.byteLength !== expectedSize) {
                throw new Error(`Buffer size mismatch in analyze-cropped: got ${frameBuffer.byteLength}, expected ${expectedSize}`);
            }

            // Check if object is cut-off (partially outside frame)
            let bounds;
            try {
                bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            } catch (boundsError) {
                bounds = { canCrop: false, reason: 'detection-error' };
            }

            // Skip frames where the object is cut-off (unless surfaceMode for Sun/Moon)
            if (bounds.reason === 'cut-off' && !e.data.surfaceMode) {
                self.postMessage({ skipped: true, reason: 'cut-off', index });
                return;
            }

            // Skip frames where detected object is too large (doubled/smeared due to bad seeing or tracking)
            // These frames often score high on sharpness but degrade the stack
            if (bounds.canCrop && bounds.size && cropRegion && cropRegion.medianObjectSize) {
                const sizeRatio = bounds.size / cropRegion.medianObjectSize;
                if (sizeRatio > 1.1) {
                    if (index < 10 || index % 100 === 0) {
                        console.log(`Frame ${index}: skipping oversized object (${bounds.size} vs median ${cropRegion.medianObjectSize}, ratio ${sizeRatio.toFixed(2)})`);
                    }
                    self.postMessage({ skipped: true, reason: 'oversized', index });
                    return;
                }
            }

            let actualCropRegion = null;
            if (cropRegion && cropRegion.size) {
                // Use per-frame detection for centering - keeps planet centered in every frame
                // The cropRegion.size is pre-calculated to be large enough for planet movement
                let centerX, centerY;
                if (bounds.canCrop && bounds.centerX !== undefined) {
                    // Use actual detected center for this frame
                    centerX = bounds.centerX;
                    centerY = bounds.centerY;
                } else if (cropRegion.referenceCenter) {
                    // Fall back to reference center if detection failed
                    centerX = cropRegion.referenceCenter.x;
                    centerY = cropRegion.referenceCenter.y;
                } else {
                    // Can't determine center - skip frame
                    self.postMessage({ skipped: true, reason: bounds.reason || 'no-center', index });
                    return;
                }

                // Debug: log first few frames' crop positioning (moved after subPixelOffset calculation)

                const halfSize = cropRegion.size / 2;

                let idealCropX = Math.floor(centerX - halfSize);
                let idealCropY = Math.floor(centerY - halfSize);

                // Ensure even pixel alignment for Bayer pattern preservation
                idealCropX = idealCropX & ~1; // Round down to even
                idealCropY = idealCropY & ~1;

                // Calculate padding needed on each side (negative values mean no padding needed)
                const padLeft = Math.max(0, -idealCropX);
                const padTop = Math.max(0, -idealCropY);
                const padRight = Math.max(0, (idealCropX + cropRegion.size) - header.width);
                const padBottom = Math.max(0, (idealCropY + cropRegion.size) - header.height);

                // Calculate sub-pixel offset: how much the detected center differs from crop center
                // This is used for global alignment during stacking
                const cropCenterX = idealCropX + cropRegion.size / 2;
                const cropCenterY = idealCropY + cropRegion.size / 2;
                const subPixelOffsetX = centerX - cropCenterX;
                const subPixelOffsetY = centerY - cropCenterY;

                // Log if padding is needed (object near edge)
                const needsPadding = padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0;
                if (needsPadding && index < 3) {
                    console.log(`Frame ${index}: crop needs padding L=${padLeft} T=${padTop} R=${padRight} B=${padBottom}`);
                }

                actualCropRegion = {
                    x: idealCropX,
                    y: idealCropY,
                    size: cropRegion.size,
                    padding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom },
                    subPixelOffset: { x: subPixelOffsetX, y: subPixelOffsetY }
                };
            }

            // If we're in crop mode but couldn't create crop region, skip the frame
            if (cropRegion && !actualCropRegion) {
                self.postMessage({ skipped: true, reason: 'crop-failed', index });
                return;
            }

            const includeRgba = true;
            const shouldCapturePreCrop = capturePreCrop && actualCropRegion; // Only makes sense if cropping
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, actualCropRegion, index, includeRgba, false, shouldCapturePreCrop);

            // Check for skipped frame (e.g., bayer artifact)
            if (result.skipped) {
                self.postMessage({ skipped: true, reason: result.reason, index });
                return;
            }

            const response = {
                sharpness: result.sharpness,
                pngBlob: result.pngBlob,
                croppedBuffer: result.croppedBuffer,
                subPixelOffset: result.subPixelOffset || { x: 0, y: 0 },
                index,
                circularity: bounds.circularity || 0
            };

            // Only include float32 data when client-side stacking is enabled
            if (includeRgba && result.float32Buffer) {
                response.float32Buffer = result.float32Buffer;
                response.width = result.width;
                response.height = result.height;
            }

            // Include pre-crop RGBA if captured (for comparison video)
            if (result.preCropRgbaBuffer) {
                response.preCropRgbaBuffer = result.preCropRgbaBuffer;
                response.preCropWidth = result.preCropWidth;
                response.preCropHeight = result.preCropHeight;
            }

            // Transfer buffers for zero-copy
            const transferables = [];
            if (response.float32Buffer) transferables.push(response.float32Buffer);
            if (response.preCropRgbaBuffer) transferables.push(response.preCropRgbaBuffer);

            if (transferables.length > 0) {
                self.postMessage(response, transferables);
            } else {
                self.postMessage(response);
            }
            return;
        }

        let sharpness, pngBlob, circularity = 0;

        if (type === 'ffmpeg') {
            const { analyze, includeRgba } = e.data;
            // opencv-bindings doesn't have imdecode, so decode PNG using browser APIs
            const blob = new Blob([analyze.buffer], { type: 'image/png' });
            const imageBitmap = await createImageBitmap(blob);

            // Draw to OffscreenCanvas to get pixel data
            const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imageBitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);

            // Create OpenCV Mat from RGBA data
            let imgMat = _cv.matFromImageData(imageData);
            let grayMat = new _cv.Mat();
            _cv.cvtColor(imgMat, grayMat, _cv.COLOR_RGBA2GRAY);
            sharpness = calculateSharpnessFromMat(grayMat, index);

            imgMat.delete();
            grayMat.delete();
            imageBitmap.close();

            // Check for Bayer artifact detection (-1 signals skip)
            if (sharpness < 0) {
                self.postMessage({ skipped: true, reason: 'bayer-artifact', index });
                return;
            }

            pngBlob = blob; // Reuse the blob we created

            // Return with float32Buffer if client-side stacking is enabled
            if (includeRgba) {
                // Convert 8-bit RGBA to Float32 (0.0-1.0 range)
                const uint8Data = imageData.data;
                const float32Data = new Float32Array(uint8Data.length);
                const scale = 1.0 / 255.0;
                for (let i = 0; i < uint8Data.length; i++) {
                    float32Data[i] = uint8Data[i] * scale;
                }
                const float32Buffer = float32Data.buffer;
                self.postMessage({
                    sharpness, pngBlob, index,
                    float32Buffer: float32Buffer,
                    width: imageData.width,
                    height: imageData.height
                }, [float32Buffer]);
                return;
            }
        } else if (type === 'ser' || type === 'avi') {
            const header = type === 'ser' ? e.data.header : e.data.aviHeader;
            const { frameBuffer, bayerChoice } = e.data;

            // Check for cut-off even in non-crop mode (unless surfaceMode for Sun/Moon)
            const bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            if ((bounds.reason === 'cut-off' || bounds.reason === 'touches-edge') && !e.data.surfaceMode) {
                self.postMessage({ skipped: true, reason: 'cut-off', index });
                return;
            }

            const includeRgba = true;
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, null, index, includeRgba);

            // Check for skipped frame (e.g., bayer artifact)
            if (result.skipped) {
                self.postMessage({ skipped: true, reason: result.reason, index });
                return;
            }

            sharpness = result.sharpness;
            pngBlob = result.pngBlob;

            // Include circularity for reference frame selection (1.0 = perfect circle)
            circularity = bounds.circularity || 0;

            // Return with float32Buffer if client-side stacking is enabled
            if (includeRgba && result.float32Buffer) {
                self.postMessage({
                    sharpness, pngBlob, index, circularity,
                    float32Buffer: result.float32Buffer,
                    width: result.width,
                    height: result.height
                }, [result.float32Buffer]);
                return;
            }

        } else {
            throw new Error('Unknown analysis type');
        }

        self.postMessage({ sharpness, pngBlob, index, circularity });

    } catch (error) {
        // OpenCV WASM can throw raw numbers as error codes
        const errorMsg = typeof error === 'number'
            ? `OpenCV error code: ${error}`
            : (error.message || String(error));
        // Only log first few errors per worker to avoid console flooding
        if (!self.errorCount) self.errorCount = 0;
        if (self.errorCount < 3) {
            const header = e.data.header || e.data.aviHeader;
            console.error(`Error in worker for index ${index}:`, errorMsg);
            console.error(`  Buffer: ${e.data.frameBuffer?.byteLength || 'N/A'} bytes, Dimensions: ${header?.width}x${header?.height}`);
            if (error.stack) console.error('Stack:', error.stack);
            self.errorCount++;
        }
        // Include more context for debugging
        const debugInfo = `${errorMsg} (type: ${e.data.type}, size: ${e.data.frameBuffer?.byteLength || 'N/A'})`;
        self.postMessage({ error: debugInfo, index: index });
    }
}

async function processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, cropRegion = null, frameIndex = undefined, includeRgba = false, skipAnalysis = false, capturePreCrop = false) {
    const { width, height, pixelDepth, fourCC, bpp } = header;
    let rawMat, grayMat, rgbaMat;
    let croppedBuffer = null;
    let preCropRgbaBuffer = null;
    let preCropWidth = 0;
    let preCropHeight = 0;

    try {
        // Log every 100th frame to track progress without flooding console
        if (frameIndex !== undefined && frameIndex % 100 === 0) {
            const cropInfo = cropRegion ? `${cropRegion.size}x${cropRegion.size}` : 'full';
            console.log(`Processing frame ${frameIndex}: ${width}x${height} -> ${cropInfo}`);
        }

        // --- Step 1: DEMOSAIC full frame first, then CROP (fixes moiré from crop-then-demosaic) ---
        if (header.fileId && header.fileId.startsWith('LUCAM-REC')) { // SER file
            const serDataType = pixelDepth > 8 ? _cv.CV_16UC1 : _cv.CV_8UC1;
            const serData = pixelDepth > 8 ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);
            const expectedSize = width * height;
            if (serData.length !== expectedSize) {
                throw new Error(`Buffer size mismatch: got ${serData.length}, expected ${expectedSize} (${width}x${height}, ${pixelDepth}-bit)`);
            }
            rawMat = _cv.matFromArray(height, width, serDataType, serData);

            // Extract cropped raw buffer for SER export BEFORE we process further
            // Note: We do a manual ROI crop here to NOT delete rawMat (we need it for demosaicing)
            if (cropRegion) {
                let croppedRaw = null;
                try {
                    // Manual crop using ROI + clone (doesn't delete source like applyCropWithPadding does)
                    const { x, y, size, padding } = cropRegion;
                    if (!padding || (padding.left === 0 && padding.top === 0 && padding.right === 0 && padding.bottom === 0)) {
                        // Simple ROI crop
                        const rect = new _cv.Rect(x, y, size, size);
                        croppedRaw = rawMat.roi(rect).clone();
                    } else {
                        // Need padding - calculate valid region and use copyMakeBorder
                        const validX = Math.max(0, x);
                        const validY = Math.max(0, y);
                        const validRight = Math.min(width, x + size);
                        const validBottom = Math.min(height, y + size);
                        const validWidth = validRight - validX;
                        const validHeight = validBottom - validY;
                        const validRect = new _cv.Rect(validX, validY, validWidth, validHeight);
                        const validPortion = rawMat.roi(validRect).clone();
                        croppedRaw = new _cv.Mat();
                        _cv.copyMakeBorder(validPortion, croppedRaw, padding.top, padding.bottom, padding.left, padding.right, _cv.BORDER_REPLICATE);
                        validPortion.delete();
                    }

                    const croppedWidth = croppedRaw.cols;
                    const croppedHeight = croppedRaw.rows;
                    const bytesPerPixel = pixelDepth > 8 ? 2 : 1;
                    croppedBuffer = new ArrayBuffer(croppedWidth * croppedHeight * bytesPerPixel);
                    if (pixelDepth > 8) {
                        new Uint16Array(croppedBuffer).set(new Uint16Array(croppedRaw.data.buffer, croppedRaw.data.byteOffset, croppedWidth * croppedHeight));
                    } else {
                        new Uint8Array(croppedBuffer).set(new Uint8Array(croppedRaw.data.buffer, croppedRaw.data.byteOffset, croppedWidth * croppedHeight));
                    }
                } finally {
                    if (croppedRaw) croppedRaw.delete();
                }
            }

            // Demosaic FULL frame at native bit depth
            rgbaMat = new _cv.Mat();
            if (bayerChoice && bayerChoice !== "MONO") {
                const vngChoice = bayerChoice + '_VNG';
                const demosaicMethod = _cv[vngChoice] !== undefined ? vngChoice : bayerChoice;

                if (!loggedDemosaicMethod) {
                    console.log(`Using demosaicing method: ${demosaicMethod} at ${pixelDepth}-bit (debayer-then-crop)`);
                    loggedDemosaicMethod = true;
                }

                if (_cv[demosaicMethod] === undefined) {
                    throw new Error(`Invalid Bayer pattern: ${bayerChoice} not found in OpenCV.`);
                }

                let demosaiced = null;
                let demosaiced8 = null;
                let rgbFull = null;
                try {
                    demosaiced = new _cv.Mat();
                    _cv.demosaicing(rawMat, demosaiced, _cv[demosaicMethod]);

                    // Validate demosaic output - should be 3 channels (RGB)
                    if (demosaiced.channels() !== 3) {
                        throw new Error(`Demosaic produced ${demosaiced.channels()} channels instead of 3 - heap likely corrupted`);
                    }
                    if (demosaiced.rows !== height || demosaiced.cols !== width) {
                        throw new Error(`Demosaic produced wrong dimensions ${demosaiced.cols}x${demosaiced.rows} instead of ${width}x${height}`);
                    }

                    // Convert to 8-bit RGB after demosaicing (needed for OpenCV operations)
                    // TODO: For true 16-bit preservation, extract float32 before this conversion
                    if (pixelDepth > 8) {
                        demosaiced8 = new _cv.Mat();
                        demosaiced.convertTo(demosaiced8, _cv.CV_8UC3, 1/256);
                        rgbFull = demosaiced8;
                        demosaiced8 = null; // Don't delete, we're using it
                    } else {
                        rgbFull = demosaiced;
                        demosaiced = null; // Don't delete, we're using it
                    }

                    // Capture pre-crop RGBA before cropping (for comparison video)
                    if (capturePreCrop && cropRegion) {
                        const preCropRgba = new _cv.Mat();
                        _cv.cvtColor(rgbFull, preCropRgba, _cv.COLOR_RGB2RGBA);
                        preCropWidth = preCropRgba.cols;
                        preCropHeight = preCropRgba.rows;
                        preCropRgbaBuffer = new ArrayBuffer(preCropWidth * preCropHeight * 4);
                        new Uint8Array(preCropRgbaBuffer).set(new Uint8Array(preCropRgba.data.buffer, preCropRgba.data.byteOffset, preCropWidth * preCropHeight * 4));
                        preCropRgba.delete();
                    }

                    // Now crop the demosaiced frame, then convert to RGBA
                    if (cropRegion) {
                        // Note: applyCropWithPadding deletes rgbFull internally
                        const croppedRgb = applyCropWithPadding(rgbFull, cropRegion, width, height);
                        rgbFull = null; // Already deleted by applyCropWithPadding
                        _cv.cvtColor(croppedRgb, rgbaMat, _cv.COLOR_RGB2RGBA);
                        croppedRgb.delete();
                    } else {
                        _cv.cvtColor(rgbFull, rgbaMat, _cv.COLOR_RGB2RGBA);
                    }
                } finally {
                    if (demosaiced8) demosaiced8.delete();
                    if (demosaiced) demosaiced.delete();
                    if (rgbFull) rgbFull.delete();
                }
            } else {
                // Mono - convert to 8-bit first, then crop, then to RGBA
                grayMat = new _cv.Mat();
                if (pixelDepth > 8) {
                    rawMat.convertTo(grayMat, _cv.CV_8U, 1/256);
                } else {
                    rawMat.copyTo(grayMat);
                }

                // Capture pre-crop RGBA before cropping (for comparison video)
                if (capturePreCrop && cropRegion) {
                    const preCropRgba = new _cv.Mat();
                    _cv.cvtColor(grayMat, preCropRgba, _cv.COLOR_GRAY2RGBA);
                    preCropWidth = preCropRgba.cols;
                    preCropHeight = preCropRgba.rows;
                    preCropRgbaBuffer = new ArrayBuffer(preCropWidth * preCropHeight * 4);
                    new Uint8Array(preCropRgbaBuffer).set(new Uint8Array(preCropRgba.data.buffer, preCropRgba.data.byteOffset, preCropWidth * preCropHeight * 4));
                    preCropRgba.delete();
                }

                if (cropRegion) {
                    // Note: applyCropWithPadding deletes grayMat internally
                    const croppedGray = applyCropWithPadding(grayMat, cropRegion, width, height);
                    _cv.cvtColor(croppedGray, rgbaMat, _cv.COLOR_GRAY2RGBA);
                    croppedGray.delete();
                    // grayMat already deleted by applyCropWithPadding
                } else {
                    _cv.cvtColor(grayMat, rgbaMat, _cv.COLOR_GRAY2RGBA);
                    grayMat.delete();
                }
                grayMat = null;
            }

            rawMat.delete();
            rawMat = null;

            // Create grayscale from RGBA for sharpness
            grayMat = new _cv.Mat();
            _cv.cvtColor(rgbaMat, grayMat, _cv.COLOR_RGBA2GRAY);

        } else { // AVI file (or RGBA from decoded PNG)
            // Null fourCC (\0\0\0\0) from FFmpeg rawvideo is uncompressed BGR like DIB
            const isNullFourCC = fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00';
            const normalizedFourCC = isNullFourCC ? 'DIB ' : fourCC;
            // DIB with bpp=8 is 8-bit grayscale, not 24-bit BGR
            const isDib8bit = (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') && bpp === 8;
            const aviDataType = isDib8bit ? _cv.CV_8UC1 : ({ 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[normalizedFourCC]);
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));

            // For AVI with Bayer (Y800 or 8-bit DIB), demosaic first then crop
            if ((normalizedFourCC === 'Y800' || isDib8bit) && bayerChoice && bayerChoice !== "MONO" && _cv[bayerChoice]) {
                const vngChoice = bayerChoice + '_VNG';
                const demosaicMethod = _cv[vngChoice] !== undefined ? vngChoice : bayerChoice;
                const demosaiced = new _cv.Mat();
                _cv.demosaicing(rawMat, demosaiced, _cv[demosaicMethod]);

                // Validate demosaic output
                if (demosaiced.channels() !== 3) {
                    demosaiced.delete();
                    throw new Error(`AVI demosaic produced ${demosaiced.channels()} channels instead of 3 - heap likely corrupted`);
                }

                rgbaMat = new _cv.Mat();
                _cv.cvtColor(demosaiced, rgbaMat, _cv.COLOR_BGR2RGBA);
                demosaiced.delete();
                rawMat.delete();
                rawMat = null;

                // Capture pre-crop RGBA before cropping (for comparison video)
                if (capturePreCrop && cropRegion) {
                    preCropWidth = rgbaMat.cols;
                    preCropHeight = rgbaMat.rows;
                    preCropRgbaBuffer = new ArrayBuffer(preCropWidth * preCropHeight * 4);
                    new Uint8Array(preCropRgbaBuffer).set(new Uint8Array(rgbaMat.data.buffer, rgbaMat.data.byteOffset, preCropWidth * preCropHeight * 4));
                }

                // Crop after demosaicing
                if (cropRegion) {
                    rgbaMat = applyCropWithPadding(rgbaMat, cropRegion, width, height);
                }

                grayMat = new _cv.Mat();
                _cv.cvtColor(rgbaMat, grayMat, _cv.COLOR_RGBA2GRAY);
            } else {
                // Non-Bayer AVI: crop first is fine (no Bayer phase issues)
                if (cropRegion) {
                    rawMat = applyCropWithPadding(rawMat, cropRegion, width, height);
                }

                grayMat = new _cv.Mat();
                if (isDib8bit || normalizedFourCC === 'Y800') {
                    // Already grayscale
                    rawMat.copyTo(grayMat);
                } else if (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
                } else if (normalizedFourCC === 'RGBA') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
                } else if (normalizedFourCC === 'YUY2' || normalizedFourCC === 'UYVY') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
                } else {
                    rawMat.copyTo(grayMat);
                }

                // Convert to RGBA
                rgbaMat = new _cv.Mat();
                if (isDib8bit || normalizedFourCC === 'Y800') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_GRAY2RGBA);
                } else if (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_BGR2RGBA);
                } else if (normalizedFourCC === 'RGBA') {
                    rawMat.copyTo(rgbaMat);
                } else if (normalizedFourCC === 'YUY2' || normalizedFourCC === 'UYVY') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_YUV2RGBA_YUY2);
                }
            }
        }

        // Get actual dimensions (may be cropped)
        const actualWidth = rgbaMat.cols;
        const actualHeight = rgbaMat.rows;

        // --- Step 2: Calculate sharpness from the grayscale mat (skip if only cropping) ---
        let sharpness = 0;
        if (!skipAnalysis) {
            sharpness = calculateSharpnessFromMat(grayMat, frameIndex);
            // Check for Bayer artifact detection (-1 signals skip)
            if (sharpness < 0) {
                return { skipped: true, reason: 'bayer-artifact' };
            }
        }

        // --- Step 4: Create PNG Blob (optional - skip if only cropping) ---
        let pngBlob = null;
        if (!skipAnalysis) {
            try {
                const tempOffscreenCanvas = new OffscreenCanvas(actualWidth, actualHeight);
                const tempCtx = tempOffscreenCanvas.getContext('2d');
                const expectedBytes = actualWidth * actualHeight * 4;
                if (rgbaMat.data.length !== expectedBytes) {
                    throw new Error(`RGBA mat size mismatch: got ${rgbaMat.data.length}, expected ${expectedBytes}`);
                }
                const imageData = new ImageData(new Uint8ClampedArray(rgbaMat.data), actualWidth, actualHeight);
                tempCtx.putImageData(imageData, 0, 0);
                pngBlob = await safeConvertToBlob(tempOffscreenCanvas, { type: 'image/png' });
            } catch (pngErr) {
                // PNG creation failed (likely out of memory) - continue without it
                // The float32Buffer can still be used for stacking and preview generation
                if (frameIndex !== undefined && frameIndex % 500 === 0) {
                    console.warn(`PNG creation skipped for frame ${frameIndex} (memory): ${pngErr.message || pngErr}`);
                }
            }
        }

        // --- Step 5: Get Float32 RGBA buffer for client-side stacking (0.0-1.0 range) ---
        let float32Buffer = null;
        if (includeRgba || skipAnalysis) {
            // Always include RGBA when skipAnalysis (crop-only mode needs it for GPU)
            // Convert 8-bit RGBA to Float32 (0.0-1.0 range) for 16-bit precision pipeline
            const uint8Data = rgbaMat.data;
            const float32Data = new Float32Array(uint8Data.length);
            const scale = 1.0 / 255.0;
            for (let i = 0; i < uint8Data.length; i++) {
                float32Data[i] = uint8Data[i] * scale;
            }
            float32Buffer = float32Data.buffer;
        }

        return { sharpness, pngBlob, croppedBuffer, float32Buffer, width: actualWidth, height: actualHeight, preCropRgbaBuffer, preCropWidth, preCropHeight };

    } finally {
        if (rawMat) rawMat.delete();
        if (grayMat) grayMat.delete();
        if (rgbaMat) rgbaMat.delete();
    }
}


/**
 * Apply crop with padding using BORDER_REPLICATE for edges that extend outside frame
 * This keeps the object perfectly centered even when near frame edges
 */
function applyCropWithPadding(srcMat, cropRegion, frameWidth, frameHeight) {
    const { x, y, size, padding } = cropRegion;

    // If no padding needed, use simple roi crop
    if (!padding || (padding.left === 0 && padding.top === 0 && padding.right === 0 && padding.bottom === 0)) {
        const rect = new _cv.Rect(x, y, size, size);
        const cropped = srcMat.roi(rect).clone();
        srcMat.delete();
        return cropped;
    }

    // Calculate the valid region within the source frame
    const validX = Math.max(0, x);
    const validY = Math.max(0, y);
    const validRight = Math.min(frameWidth, x + size);
    const validBottom = Math.min(frameHeight, y + size);
    const validWidth = validRight - validX;
    const validHeight = validBottom - validY;

    // Extract the valid portion from source
    const validRect = new _cv.Rect(validX, validY, validWidth, validHeight);
    const validPortion = srcMat.roi(validRect).clone();
    srcMat.delete();

    // Apply padding using BORDER_REPLICATE (extends edge pixels)
    const paddedMat = new _cv.Mat();
    _cv.copyMakeBorder(
        validPortion,
        paddedMat,
        padding.top,
        padding.bottom,
        padding.left,
        padding.right,
        _cv.BORDER_REPLICATE
    );
    validPortion.delete();

    return paddedMat;
}


function calculateSharpnessFromMat(grayMat, frameIndex) {
    // Use Tenengrad (Sobel-based) sharpness metric - more robust than Laplacian variance
    // Tenengrad = sum of squared Sobel gradients, normalized by image size

    if (!_cv || !_cv.Mat) {
        console.error('OpenCV not ready in calculateSharpnessFromMat');
        return 0;
    }

    let sobelX = null, sobelY = null, sobelX2 = null, sobelY2 = null, gradientMagnitude = null;

    try {
        sobelX = new _cv.Mat();
        sobelY = new _cv.Mat();

        // Calculate Sobel gradients
        _cv.Sobel(grayMat, sobelX, _cv.CV_64F, 1, 0, 3); // dx
        _cv.Sobel(grayMat, sobelY, _cv.CV_64F, 0, 1, 3); // dy

        // Square the gradients
        sobelX2 = new _cv.Mat();
        sobelY2 = new _cv.Mat();
        _cv.multiply(sobelX, sobelX, sobelX2);
        _cv.multiply(sobelY, sobelY, sobelY2);

        // Sum of squared gradients
        gradientMagnitude = new _cv.Mat();
        _cv.add(sobelX2, sobelY2, gradientMagnitude);

        // Calculate mean (Tenengrad normalized by pixel count)
        const meanVal = _cv.mean(gradientMagnitude);
        const sharpness = meanVal[0]; // Mean of gradient magnitude squared

        // Log first frame only for debugging
        if (frameIndex === 0) {
            console.log(`Frame analysis: ${grayMat.cols}x${grayMat.rows}, Tenengrad sharpness=${sharpness.toFixed(2)}`);
        }

        // Sanity check: abnormally high sharpness (>50000) indicates raw Bayer data that wasn't demosaiced
        // Raw Bayer patterns have extreme contrast between adjacent R/G/B pixels, producing very high sharpness
        if (sharpness > 50000) {
            console.warn(`Frame ${frameIndex}: sharpness ${sharpness.toFixed(0)} is abnormally high - likely un-demosaiced Bayer data, skipping`);
            return -1; // Return -1 to signal frame should be skipped entirely
        }

        return sharpness;
    } catch (error) {
        const errMsg = typeof error === 'number' ? `OpenCV error ${error}` : (error.message || String(error));
        console.warn(`Sharpness calculation failed for frame ${frameIndex}: ${errMsg}`);
        return 0;
    } finally {
        if (sobelX) try { sobelX.delete(); } catch(e) {}
        if (sobelY) try { sobelY.delete(); } catch(e) {}
        if (sobelX2) try { sobelX2.delete(); } catch(e) {}
        if (sobelY2) try { sobelY2.delete(); } catch(e) {}
        if (gradientMagnitude) try { gradientMagnitude.delete(); } catch(e) {}
    }
}

/**
 * Lightweight sharpness calculation for Pass 1 of two-pass processing
 * Uses 8-bit grayscale conversion to minimize memory usage
 * For cropped analysis, calculates sharpness on the cropped region only
 */
async function calculateSharpnessLightweight(frameBuffer, header, bayerChoice, cropRegion, bounds) {
    const { width, height, pixelDepth } = header;
    let rawMat = null, grayMat = null, croppedGray = null;

    try {
        // Create grayscale mat from frame buffer (8-bit only, no float32)
        if (header.fileId && header.fileId.startsWith('LUCAM-REC')) { // SER file
            const serDataType = pixelDepth > 8 ? _cv.CV_16UC1 : _cv.CV_8UC1;
            const serData = pixelDepth > 8 ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);
            rawMat = _cv.matFromArray(height, width, serDataType, serData);

            grayMat = new _cv.Mat();
            const alpha = pixelDepth > 8 ? 1/256 : 1;
            rawMat.convertTo(grayMat, _cv.CV_8U, alpha);
        } else { // AVI file
            const { fourCC, bpp } = header;
            // Null fourCC from FFmpeg rawvideo is uncompressed BGR like DIB
            const isNullFourCC = fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00';
            const normalizedFourCC = isNullFourCC ? 'DIB ' : fourCC;
            // DIB with bpp=8 is 8-bit grayscale, not 24-bit BGR
            const isDib8bit = (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') && bpp === 8;
            const aviDataType = isDib8bit ? _cv.CV_8UC1 : ({ 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[normalizedFourCC]);
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));

            grayMat = new _cv.Mat();
            if (isDib8bit || normalizedFourCC === 'Y800') {
                // Already grayscale
                rawMat.copyTo(grayMat);
            } else if (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
            } else if (normalizedFourCC === 'RGBA') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
            } else if (normalizedFourCC === 'YUY2' || normalizedFourCC === 'UYVY') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
            } else {
                rawMat.copyTo(grayMat);
            }
        }

        // If we have a crop region and valid bounds, calculate sharpness on cropped area
        // This gives more accurate sharpness values for the planet, not background
        if (cropRegion && cropRegion.size && bounds && bounds.canCrop) {
            const centerX = bounds.centerX;
            const centerY = bounds.centerY;
            const halfSize = cropRegion.size / 2;

            let cropX = Math.floor(centerX - halfSize);
            let cropY = Math.floor(centerY - halfSize);
            cropX = Math.max(0, cropX) & ~1;
            cropY = Math.max(0, cropY) & ~1;

            // Ensure crop stays within bounds
            const actualSize = Math.min(cropRegion.size, width - cropX, height - cropY);
            if (actualSize > 50) { // Minimum size for meaningful sharpness
                const rect = new _cv.Rect(cropX, cropY, actualSize, actualSize);
                croppedGray = grayMat.roi(rect).clone();

                const sharpness = calculateSharpnessFromMat(croppedGray, -1); // -1 to suppress logging
                return sharpness;
            }
        }

        // Fallback: calculate sharpness on full frame
        return calculateSharpnessFromMat(grayMat, -1);

    } finally {
        if (croppedGray) try { croppedGray.delete(); } catch(e) {}
        if (grayMat) try { grayMat.delete(); } catch(e) {}
        if (rawMat) try { rawMat.delete(); } catch(e) {}
    }
}

// Detect bounding box of bright objects (planet + moons) in frame
async function detectObjectBounds(frameBuffer, header, bayerChoice) {
    const { width, height, pixelDepth } = header;
    let grayMat = null;
    let rawMat = null;
    let blurred = null;
    let binary = null;
    let contours = null;
    let hierarchy = null;

    try {
        // Create grayscale mat from frame buffer
        if (header.fileId && header.fileId.startsWith('LUCAM-REC')) { // SER file
            const serDataType = pixelDepth > 8 ? _cv.CV_16UC1 : _cv.CV_8UC1;
            const serData = pixelDepth > 8 ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);
            const expectedSize = width * height;
            if (serData.length !== expectedSize) {
                throw new Error(`detectObjectBounds: Buffer size mismatch: got ${serData.length}, expected ${expectedSize} (${width}x${height}, ${pixelDepth}-bit)`);
            }
            rawMat = _cv.matFromArray(height, width, serDataType, serData);
            grayMat = new _cv.Mat();
            const alpha = pixelDepth > 8 ? 1/256 : 1;
            rawMat.convertTo(grayMat, _cv.CV_8U, alpha);
        } else { // AVI file (or RGBA from decoded PNG)
            const { fourCC, bpp } = header;
            // Null fourCC from FFmpeg rawvideo is uncompressed BGR like DIB
            const isNullFourCC = fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00';
            const normalizedFourCC = isNullFourCC ? 'DIB ' : fourCC;
            // DIB with bpp=8 is 8-bit grayscale, not 24-bit BGR
            const isDib8bit = (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') && bpp === 8;
            const bytesPerPixel = getAviBytesPerPixel(header);
            const expectedSize = width * height * bytesPerPixel;
            if (frameBuffer.byteLength !== expectedSize) {
                console.warn(`detectObjectBounds: AVI buffer size mismatch: got ${frameBuffer.byteLength}, expected ${expectedSize} (${width}x${height}, ${fourCC}, bpp=${bpp})`);
                return { canCrop: false, reason: 'buffer-mismatch' };
            }
            const aviDataType = isDib8bit ? _cv.CV_8UC1 : ({ 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[normalizedFourCC]);
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));
            grayMat = new _cv.Mat();
            if (isDib8bit || normalizedFourCC === 'Y800') {
                // Already grayscale
                rawMat.copyTo(grayMat);
            } else if (normalizedFourCC === 'DIB ' || normalizedFourCC === 'RGB ') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
            } else if (normalizedFourCC === 'RGBA') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
            } else if (normalizedFourCC === 'YUY2' || normalizedFourCC === 'UYVY') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
            } else {
                rawMat.copyTo(grayMat);
            }
        }

        // Apply Gaussian blur to reduce noise
        blurred = new _cv.Mat();
        // Note: cv.Size() returns a plain JS object {width, height}, not a WASM object, so no .delete() needed
        _cv.GaussianBlur(grayMat, blurred, new _cv.Size(5, 5), 0);

        // 10% threshold (25/255) - high enough to reject noise, low enough to detect dim planets
        binary = new _cv.Mat();
        _cv.threshold(blurred, binary, 25, 255, _cv.THRESH_BINARY);

        // Find contours
        contours = new _cv.MatVector();
        hierarchy = new _cv.Mat();
        _cv.findContours(binary, contours, hierarchy, _cv.RETR_EXTERNAL, _cv.CHAIN_APPROX_SIMPLE);

        // Collect all bounding boxes; track largest contour (the planet) to measure its circularity
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasObjects = false;
        const minContourArea = (width * height) * 0.0001; // Ignore tiny noise
        let largestContour = null;
        let largestArea = 0;

        for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = _cv.contourArea(contour);
            if (area < minContourArea) continue;

            hasObjects = true;
            const rect = _cv.boundingRect(contour);
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);

            // Track largest contour for circularity calculation
            if (area > largestArea) {
                largestArea = area;
                largestContour = contour;
            }
        }

        // Calculate circularity of largest contour: 4π × area / perimeter²
        // Perfect circle = 1.0, Saturn with rings ≈ 0.3-0.5
        let circularity = 0;
        let aspectRatio = 1;
        if (largestContour) {
            const perimeter = _cv.arcLength(largestContour, true);
            if (perimeter > 0) {
                circularity = (4 * Math.PI * largestArea) / (perimeter * perimeter);
            }
            const rect = _cv.boundingRect(largestContour);
            aspectRatio = rect.width / Math.max(1, rect.height);
        }

        // Cleanup intermediate Mats (raw/gray cleaned in finally)
        if (blurred) { blurred.delete(); blurred = null; }
        if (binary) { binary.delete(); binary = null; }
        if (contours) { contours.delete(); contours = null; }
        if (hierarchy) { hierarchy.delete(); hierarchy = null; }

        if (!hasObjects) {
            return { canCrop: false, reason: 'no-objects' };
        }

        // Check if object is cut off at the edges
        // Use 1% margin - if the bright object's bounding box touches this close to edge, it's likely cut off
        const edgeMargin = Math.max(width, height) * 0.01;
        const isCutOff = minX < edgeMargin || minY < edgeMargin ||
                         maxX > width - edgeMargin || maxY > height - edgeMargin;

        if (isCutOff) {
            return { canCrop: false, reason: 'cut-off' };
        }

        // Calculate bounding box with margin
        // Use 20% padding - enough for Saturn's rings while keeping crop small
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;
        const marginX = boxWidth * 0.2;
        const marginY = boxHeight * 0.2;

        // Make it square (use larger dimension)
        const size = Math.max(boxWidth + marginX * 2, boxHeight + marginY * 2);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        // Calculate crop region (ensure it's within frame bounds)
        let cropX = Math.max(0, Math.floor(centerX - size / 2));
        let cropY = Math.max(0, Math.floor(centerY - size / 2));
        let cropSize = Math.floor(size);

        // Ensure even pixel alignment for Bayer pattern preservation
        cropX = cropX & ~1;
        cropY = cropY & ~1;
        cropSize = cropSize & ~1; // Keep size even too

        // Adjust if crop goes beyond frame (keeping even alignment)
        if (cropX + cropSize > width) cropX = (width - cropSize) & ~1;
        if (cropY + cropSize > height) cropY = (height - cropSize) & ~1;
        if (cropX < 0) { cropX = 0; cropSize = width & ~1; }
        if (cropY < 0) { cropY = 0; cropSize = height & ~1; }

        return {
            canCrop: true,
            x: cropX,
            y: cropY,
            size: cropSize,
            centerX: centerX,  // Actual detected object center (not affected by clamping)
            centerY: centerY,  // Actual detected object center (not affected by clamping)
            originalWidth: width,
            originalHeight: height,
            circularity: circularity,  // 1.0 = perfect circle, lower = elongated (Saturn)
            aspectRatio: aspectRatio   // width/height of largest contour
        };

    } catch (error) {
        // OpenCV errors during bounds detection are non-fatal - frame will still be processed
        // Only log first few to avoid spam
        if (!self.boundsErrorCount) self.boundsErrorCount = 0;
        if (self.boundsErrorCount < 3) {
            const errorMsg = typeof error === 'number' ? `OpenCV error code: ${error}` : (error.message || String(error));
            console.warn('Bounds detection failed (non-fatal):', errorMsg);
            self.boundsErrorCount++;
        }
        return { canCrop: false, reason: 'error' };
    } finally {
        // Clean up ALL OpenCV resources
        if (blurred) try { blurred.delete(); } catch(e) {}
        if (binary) try { binary.delete(); } catch(e) {}
        if (contours) try { contours.delete(); } catch(e) {}
        if (hierarchy) try { hierarchy.delete(); } catch(e) {}
        if (rawMat) try { rawMat.delete(); } catch(e) {}
        if (grayMat) try { grayMat.delete(); } catch(e) {}
    }
}

// =====================================================
// PNG-BASED DETECTION AND CROPPING (for image files)
// =====================================================

/**
 * Detect object bounds from PNG data
 */
async function detectObjectBoundsFromPng(pngData) {
    let rawMat = null, grayMat = null;
    let blurred = null, binary = null, contours = null, hierarchy = null;

    try {
        // Decode PNG using browser APIs
        const blob = new Blob([pngData.buffer], { type: 'image/png' });
        const imageBitmap = await createImageBitmap(blob);
        const { width, height } = imageBitmap;

        // Draw to OffscreenCanvas to get pixel data
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);
        imageBitmap.close();

        // Create OpenCV Mat from RGBA data
        rawMat = _cv.matFromImageData(imageData);
        grayMat = new _cv.Mat();
        _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);

        // Apply Gaussian blur to reduce noise
        blurred = new _cv.Mat();
        // Note: cv.Size() returns a plain JS object {width, height}, not a WASM object, so no .delete() needed
        _cv.GaussianBlur(grayMat, blurred, new _cv.Size(5, 5), 0);

        // 10% threshold (25/255) - high enough to reject noise, low enough to detect dim planets
        binary = new _cv.Mat();
        _cv.threshold(blurred, binary, 25, 255, _cv.THRESH_BINARY);

        // Find contours
        contours = new _cv.MatVector();
        hierarchy = new _cv.Mat();
        _cv.findContours(binary, contours, hierarchy, _cv.RETR_EXTERNAL, _cv.CHAIN_APPROX_SIMPLE);

        // Collect all bounding boxes; track largest contour (the planet) to measure its circularity
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasObjects = false;
        const minContourArea = (width * height) * 0.0001;
        let largestContour = null;
        let largestArea = 0;

        for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = _cv.contourArea(contour);
            if (area < minContourArea) continue;

            hasObjects = true;
            const rect = _cv.boundingRect(contour);
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);

            // Track largest contour for circularity calculation
            if (area > largestArea) {
                largestArea = area;
                largestContour = contour;
            }
        }

        // Calculate circularity of largest contour: 4π × area / perimeter²
        let circularity = 0;
        let aspectRatio = 1;
        if (largestContour) {
            const perimeter = _cv.arcLength(largestContour, true);
            if (perimeter > 0) {
                circularity = (4 * Math.PI * largestArea) / (perimeter * perimeter);
            }
            const rect = _cv.boundingRect(largestContour);
            aspectRatio = rect.width / Math.max(1, rect.height);
        }

        // Cleanup intermediate Mats (raw/gray cleaned in finally)
        if (blurred) { blurred.delete(); blurred = null; }
        if (binary) { binary.delete(); binary = null; }
        if (contours) { contours.delete(); contours = null; }
        if (hierarchy) { hierarchy.delete(); hierarchy = null; }

        if (!hasObjects) {
            return { canCrop: false, reason: 'no-objects' };
        }

        // Check if object is cut off at edges
        const edgeMargin = Math.max(width, height) * 0.01;
        const isCutOff = minX < edgeMargin || minY < edgeMargin ||
                         maxX > width - edgeMargin || maxY > height - edgeMargin;

        if (isCutOff) {
            return { canCrop: false, reason: 'cut-off' };
        }

        // Calculate bounding box with margin
        // Use 20% padding - enough for Saturn's rings while keeping crop small
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;
        const marginX = boxWidth * 0.2;
        const marginY = boxHeight * 0.2;

        // Make it square
        const size = Math.max(boxWidth + marginX * 2, boxHeight + marginY * 2);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        let cropX = Math.max(0, Math.floor(centerX - size / 2));
        let cropY = Math.max(0, Math.floor(centerY - size / 2));
        let cropSize = Math.floor(size);

        // Ensure even pixel alignment
        cropX = cropX & ~1;
        cropY = cropY & ~1;
        cropSize = cropSize & ~1;

        // Adjust if crop goes beyond frame
        if (cropX + cropSize > width) cropX = (width - cropSize) & ~1;
        if (cropY + cropSize > height) cropY = (height - cropSize) & ~1;
        if (cropX < 0) { cropX = 0; cropSize = width & ~1; }
        if (cropY < 0) { cropY = 0; cropSize = height & ~1; }

        return {
            canCrop: true,
            x: cropX,
            y: cropY,
            size: cropSize,
            centerX: centerX,  // Actual detected object center (not affected by clamping)
            centerY: centerY,  // Actual detected object center (not affected by clamping)
            originalWidth: width,
            originalHeight: height,
            circularity: circularity,  // 1.0 = perfect circle, lower = elongated (Saturn)
            aspectRatio: aspectRatio   // width/height of largest contour
        };

    } catch (error) {
        console.warn('PNG bounds detection failed:', error.message || error);
        return { canCrop: false, reason: 'error' };
    } finally {
        // Clean up ALL OpenCV resources
        if (blurred) try { blurred.delete(); } catch(e) {}
        if (binary) try { binary.delete(); } catch(e) {}
        if (contours) try { contours.delete(); } catch(e) {}
        if (hierarchy) try { hierarchy.delete(); } catch(e) {}
        if (rawMat) try { rawMat.delete(); } catch(e) {}
        if (grayMat) try { grayMat.delete(); } catch(e) {}
    }
}

/**
 * Analyze and crop PNG data
 */
async function analyzeAndCropPng(pngData, cropRegion, frameIndex, includeRgba, surfaceMode = false) {
    let rawMat = null, grayMat = null, rgbaMat = null;

    try {
        // Decode PNG using browser APIs
        const blob = new Blob([pngData.buffer], { type: 'image/png' });
        const imageBitmap = await createImageBitmap(blob);
        const { width, height } = imageBitmap;

        // Draw to OffscreenCanvas to get pixel data
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);
        imageBitmap.close();

        // Create OpenCV Mat from RGBA data
        rawMat = _cv.matFromImageData(imageData);

        // Check if object is cut-off
        grayMat = new _cv.Mat();
        _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);

        const bounds = await detectObjectBoundsFromPng(pngData);
        if (bounds.reason === 'cut-off' && !surfaceMode) {
            rawMat.delete();
            grayMat.delete();
            return { skipped: true, reason: 'cut-off' };
        }

        // Skip frames where detected object is too large (doubled/smeared due to bad seeing or tracking)
        if (bounds.canCrop && bounds.size && cropRegion && cropRegion.medianObjectSize) {
            const sizeRatio = bounds.size / cropRegion.medianObjectSize;
            if (sizeRatio > 1.1) {
                if (frameIndex < 10 || frameIndex % 100 === 0) {
                    console.log(`Frame ${frameIndex}: skipping oversized object (${bounds.size} vs median ${cropRegion.medianObjectSize}, ratio ${sizeRatio.toFixed(2)})`);
                }
                rawMat.delete();
                grayMat.delete();
                return { skipped: true, reason: 'oversized' };
            }
        }

        // Calculate crop region - use per-frame detection for centering
        let actualCropRegion = null;
        if (cropRegion && cropRegion.size) {
            let centerX, centerY;
            if (bounds.canCrop && bounds.centerX !== undefined) {
                // Use actual detected center for this frame
                centerX = bounds.centerX;
                centerY = bounds.centerY;
            } else if (cropRegion.referenceCenter) {
                // Fall back to reference center if detection failed
                centerX = cropRegion.referenceCenter.x;
                centerY = cropRegion.referenceCenter.y;
            } else {
                rawMat.delete();
                grayMat.delete();
                return { skipped: true, reason: bounds.reason || 'no-center' };
            }

            const halfSize = cropRegion.size / 2;
            let idealCropX = Math.floor(centerX - halfSize);
            let idealCropY = Math.floor(centerY - halfSize);

            // Ensure even pixel alignment
            idealCropX = idealCropX & ~1;
            idealCropY = idealCropY & ~1;

            // Calculate padding needed
            const padLeft = Math.max(0, -idealCropX);
            const padTop = Math.max(0, -idealCropY);
            const padRight = Math.max(0, (idealCropX + cropRegion.size) - width);
            const padBottom = Math.max(0, (idealCropY + cropRegion.size) - height);

            actualCropRegion = {
                x: idealCropX,
                y: idealCropY,
                size: cropRegion.size,
                padding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom }
            };
        }

        if (cropRegion && !actualCropRegion) {
            rawMat.delete();
            grayMat.delete();
            return { skipped: true, reason: 'crop-failed' };
        }

        // Apply cropping if needed
        if (actualCropRegion) {
            rawMat = applyCropWithPadding(rawMat, actualCropRegion, width, height);
            grayMat.delete();
            grayMat = new _cv.Mat();
            _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
        }

        // Get actual dimensions (may be cropped)
        const actualWidth = rawMat.cols;
        const actualHeight = rawMat.rows;

        // Calculate sharpness
        const sharpness = calculateSharpnessFromMat(grayMat, frameIndex);

        // Check for Bayer artifact detection (-1 signals skip)
        if (sharpness < 0) {
            rawMat.delete();
            grayMat.delete();
            return { skipped: true, reason: 'bayer-artifact' };
        }

        // Create PNG blob from (cropped) RGBA data
        const outputCanvas = new OffscreenCanvas(actualWidth, actualHeight);
        const outputCtx = outputCanvas.getContext('2d');
        const outputImageData = new ImageData(new Uint8ClampedArray(rawMat.data), actualWidth, actualHeight);
        outputCtx.putImageData(outputImageData, 0, 0);
        const pngBlob = await safeConvertToBlob(outputCanvas, { type: 'image/png' });

        // Get Float32 buffer if needed (0.0-1.0 range)
        let float32Buffer = null;
        if (includeRgba) {
            const uint8Data = rawMat.data;
            const float32Data = new Float32Array(uint8Data.length);
            const scale = 1.0 / 255.0;
            for (let i = 0; i < uint8Data.length; i++) {
                float32Data[i] = uint8Data[i] * scale;
            }
            float32Buffer = float32Data.buffer;
        }

        rawMat.delete();
        grayMat.delete();

        return { sharpness, pngBlob, float32Buffer, width: actualWidth, height: actualHeight, circularity: bounds.circularity || 0 };

    } catch (error) {
        if (rawMat) try { rawMat.delete(); } catch(e) {}
        if (grayMat) try { grayMat.delete(); } catch(e) {}
        throw error;
    }
}

// =====================================================
// FRAME STACKING WITH LOCAL ALIGNMENT
// =====================================================

/**
 * Prepare alignment data for external GPU processing
 * Returns AP grid and reference grayscale for use by WebGPU worker
 * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
 */
async function prepareAlignmentData(refFrame, surfaceMode = false) {
    if (!refFrame || !refFrame.float32Buffer || !refFrame.width || !refFrame.height) {
        throw new Error('Invalid reference frame');
    }

    const { width, height } = refFrame;
    // Convert Float32 to Uint8 for OpenCV
    const float32Data = new Float32Array(refFrame.float32Buffer);
    const refData = new Uint8ClampedArray(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        refData[i] = Math.round(float32Data[i] * 255);
    }

    // Create AP grid (surfaceMode uses larger search radius for Moon/Sun)
    const { alignmentPoints, patchSize, searchRadius } = createAPGrid(width, height, surfaceMode);

    // Create reference grayscale
    const refMat = new _cv.Mat(height, width, _cv.CV_8UC4);
    refMat.data.set(refData);
    const refGray = new _cv.Mat();
    _cv.cvtColor(refMat, refGray, _cv.COLOR_RGBA2GRAY);

    // Filter APs by quality
    const filteredAPs = filterAPsByQuality(alignmentPoints, refGray, width, height, patchSize, 0.02, 5);
    const activeAPs = filteredAPs.length > 0 ? filteredAPs : alignmentPoints;

    // Extract grayscale data for GPU
    const refGrayData = new Uint8Array(refGray.data.length);
    refGrayData.set(refGray.data);

    // Cleanup
    refGray.delete();
    refMat.delete();

    return {
        alignmentPoints: activeAPs,
        refGrayData,
        patchSize,
        searchRadius,
        width,
        height
    };
}

/**
 * Stack frames with pre-computed shifts (from external GPU alignment)
 */
async function stackWithPrecomputedShifts(frames, frameShifts, alignmentPoints, refIndex, drizzleScale = 1.0, patchSize = 64) {
    let mapX = null, mapY = null;

    try {
        self.postMessage({ type: 'stack-progress', stage: 'Stacking with GPU shifts...', progress: 50 });

        const validFrames = frames.filter(f => f.float32Buffer && f.width && f.height && f.sharpness > 0);
        const { width, height } = validFrames[0];
        const frameCount = validFrames.length;

        // Calculate output dimensions
        const outWidth = Math.round(width * drizzleScale);
        const outHeight = Math.round(height * drizzleScale);
        const isDrizzle = drizzleScale > 1.0;

        // Accumulator arrays (accumulate in 0.0-1.0 range)
        const accumR = new Float32Array(outWidth * outHeight);
        const accumG = new Float32Array(outWidth * outHeight);
        const accumB = new Float32Array(outWidth * outHeight);
        const accumWeight = new Float32Array(outWidth * outHeight);

        const totalSharpness = validFrames.reduce((sum, f) => sum + f.sharpness, 0);
        const blackCutoff = 0.016; // ~4/255 in 0.0-1.0 range

        // Brightness normalization helper (works with Float32 data in 0.0-1.0 range)
        function calcMeanBrightness(float32Buffer, width, height, blackCutoff) {
            const data = new Float32Array(float32Buffer);
            let sum = 0, count = 0;
            for (let y = 0; y < height; y += 8) {
                for (let x = 0; x < width; x += 8) {
                    const idx = (y * width + x) * 4;
                    const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
            return count > 0 ? sum / count : 1;
        }

        // Helper to convert Float32 (0.0-1.0) to Uint8 for OpenCV
        function float32ToUint8(float32Buffer) {
            const float32Data = new Float32Array(float32Buffer);
            const uint8Data = new Uint8ClampedArray(float32Data.length);
            for (let i = 0; i < float32Data.length; i++) {
                uint8Data[i] = Math.round(float32Data[i] * 255);
            }
            return uint8Data;
        }

        // Calculate reference brightness
        const referenceFrame = validFrames[refIndex];
        const refBrightness = calcMeanBrightness(referenceFrame.float32Buffer, width, height, blackCutoff);

        // Pre-allocate displacement maps at OUTPUT resolution (for drizzle upscaling)
        mapX = new _cv.Mat(outHeight, outWidth, _cv.CV_32FC1);
        mapY = new _cv.Mat(outHeight, outWidth, _cv.CV_32FC1);

        // Stack each frame using OpenCV remap
        for (let f = 0; f < frameCount; f++) {
            const frame = validFrames[f];
            const shifts = frameShifts[f];
            const frameWeight = frame.sharpness / totalSharpness;
            const frameData = float32ToUint8(frame.float32Buffer); // Convert for OpenCV

            // Brightness correction
            const frameBrightness = calcMeanBrightness(frame.float32Buffer, width, height, blackCutoff);
            const brightnessScale = refBrightness / frameBrightness;

            // Sub-pixel offset for global alignment
            const subPixelOffset = frame.subPixelOffset || { x: 0, y: 0 };
            const refSubPixelOffset = referenceFrame.subPixelOffset || { x: 0, y: 0 };
            const globalOffsetX = subPixelOffset.x - refSubPixelOffset.x;
            const globalOffsetY = subPixelOffset.y - refSubPixelOffset.y;

            // Build displacement map from shifts with global offset
            buildDisplacementMaps(mapX, mapY, outWidth, outHeight, alignmentPoints, shifts, patchSize, globalOffsetX, globalOffsetY, drizzleScale);

            // Apply warping with OpenCV remap
            let frameMat = null, warpedMat = null;
            try {
                frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
                frameMat.data.set(frameData);

                // Apply local de-warping via remap (output at outWidth x outHeight)
                warpedMat = new _cv.Mat();
                _cv.remap(frameMat, warpedMat, mapX, mapY, _cv.INTER_LINEAR, _cv.BORDER_CONSTANT);

                // Accumulate warped frame with brightness normalization
                const warpedData = warpedMat.data;
                for (let i = 0; i < outWidth * outHeight; i++) {
                    const srcIdx = i * 4;
                    // Skip black pixels (border from remap)
                    if (warpedData[srcIdx] === 0 && warpedData[srcIdx + 1] === 0 && warpedData[srcIdx + 2] === 0) {
                        continue;
                    }
                    // Apply brightness normalization and weight
                    accumR[i] += warpedData[srcIdx] * brightnessScale * frameWeight;
                    accumG[i] += warpedData[srcIdx + 1] * brightnessScale * frameWeight;
                    accumB[i] += warpedData[srcIdx + 2] * brightnessScale * frameWeight;
                    accumWeight[i] += frameWeight;
                }
            } catch (cvError) {
                const errMsg = typeof cvError === 'number' ? `OpenCV error code: ${cvError}` : (cvError.message || String(cvError));
                console.error(`Frame ${f} warp error:`, errMsg);
                // Skip this frame but continue with others
            } finally {
                if (warpedMat) try { warpedMat.delete(); } catch(e) {}
                if (frameMat) try { frameMat.delete(); } catch(e) {}
            }

            const progress = 50 + (f / frameCount) * 45;
            self.postMessage({ type: 'stack-progress', stage: `Stacking frame ${f + 1}/${frameCount}...`, progress });
        }

        // Cleanup maps
        mapX.delete(); mapX = null;
        mapY.delete(); mapY = null;

        // Create output image
        self.postMessage({ type: 'stack-progress', stage: 'Creating final image...', progress: 95 });

        const outputData = new Uint8ClampedArray(outWidth * outHeight * 4);
        // Also create Float32Array for 16-bit post-processing (RGBA, 0.0-1.0 range)
        const float32Data = new Float32Array(outWidth * outHeight * 4);

        for (let i = 0; i < outWidth * outHeight; i++) {
            const w = accumWeight[i];
            if (w > 0) {
                // Normalized float values (0.0-1.0) - preserves full accumulator precision
                const r = accumR[i] / w / 255.0;
                const g = accumG[i] / w / 255.0;
                const b = accumB[i] / w / 255.0;

                // Float32 output (full precision)
                float32Data[i * 4 + 0] = r;
                float32Data[i * 4 + 1] = g;
                float32Data[i * 4 + 2] = b;
                float32Data[i * 4 + 3] = 1.0;

                // 8-bit output (for preview/compatibility)
                outputData[i * 4] = Math.min(255, Math.max(0, Math.round(r * 255)));
                outputData[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
                outputData[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
            } else {
                float32Data[i * 4 + 0] = 0;
                float32Data[i * 4 + 1] = 0;
                float32Data[i * 4 + 2] = 0;
                float32Data[i * 4 + 3] = 1.0;
            }
            outputData[i * 4 + 3] = 255;
        }

        // Convert to PNG
        const imageData = new ImageData(outputData, outWidth, outHeight);
        const canvas = new OffscreenCanvas(outWidth, outHeight);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        const blob = await safeConvertToBlob(canvas, { type: 'image/png' });

        return { blob, width: outWidth, height: outHeight, float32Data };

    } catch (error) {
        if (mapX) try { mapX.delete(); } catch(e) {}
        if (mapY) try { mapY.delete(); } catch(e) {}
        throw error;
    }
}

/**
 * Stack frames with local alignment using Alignment Points (APs) - CPU only
 * @param frames - Array of frame objects
 * @param drizzleScale - Output scale factor (1.0 = normal, 1.5 = drizzle)
 * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
 */
async function stackFramesLocally(frames, drizzleScale = 1.0, noiseRobustAlignment = false, surfaceMode = false) {
    // Track resources for cleanup on error
    let refMat = null, refGray = null, refGrayBlurred = null, mapX = null, mapY = null;

    try {
        self.postMessage({ type: 'stack-progress', stage: 'Preparing frames...', progress: 0 });

        // Filter frames that have valid float32Buffer and sharpness
        let validFrames = frames.filter(f => f.float32Buffer && f.width && f.height && f.sharpness > 0);

        if (validFrames.length === 0) {
            throw new Error('No valid frames with float32 data for stacking');
        }

        const { width, height } = validFrames[0];
        let frameCount = validFrames.length;

        // Calculate output dimensions (drizzle)
        const outWidth = Math.round(width * drizzleScale);
        const outHeight = Math.round(height * drizzleScale);
        const isDrizzle = drizzleScale > 1.0;

        if (isDrizzle) {
            console.log(`Drizzle mode: ${drizzleScale}x (${width}x${height} -> ${outWidth}x${outHeight})`);
        }

        // Filter frames with inconsistent dimensions (instead of throwing)
        const consistentFrames = validFrames.filter((f, i) => {
            if (f.width !== width || f.height !== height) {
                console.warn(`Skipping frame ${i}: dimensions ${f.width}x${f.height} don't match expected ${width}x${height}`);
                return false;
            }
            const expectedBytes = f.width * f.height * 4 * 4; // Float32 = 4 bytes per value
            if (!f.float32Buffer || f.float32Buffer.byteLength !== expectedBytes) {
                console.warn(`Skipping frame ${i}: buffer size ${f.float32Buffer?.byteLength || 0} doesn't match expected ${expectedBytes}`);
                return false;
            }
            return true;
        });

        if (consistentFrames.length === 0) {
            throw new Error('No frames with consistent dimensions to stack');
        }

        if (consistentFrames.length < validFrames.length) {
            console.log(`Filtered ${validFrames.length - consistentFrames.length} frames with mismatched dimensions`);
        }

        // Use consistent frames for stacking
        validFrames = consistentFrames;
        frameCount = validFrames.length;

        console.log(`Stacking ${frameCount} frames (${width}x${height}) with local alignment`);

        // Helper to convert Float32 (0.0-1.0) to Uint8 for OpenCV
        function float32ToUint8(float32Buffer) {
            const float32Data = new Float32Array(float32Buffer);
            const uint8Data = new Uint8ClampedArray(float32Data.length);
            for (let i = 0; i < float32Data.length; i++) {
                uint8Data[i] = Math.round(float32Data[i] * 255);
            }
            return uint8Data;
        }

        // Sort frames by sharpness and use best as reference
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);
        const referenceFrame = sortedFrames[0];
        const refData = float32ToUint8(referenceFrame.float32Buffer); // Convert for OpenCV
        const refSubPixelOffset = referenceFrame.subPixelOffset || { x: 0, y: 0 };
        console.log(`Reference frame: sharpness ${referenceFrame.sharpness.toFixed(2)}, subPixelOffset=(${refSubPixelOffset.x.toFixed(3)}, ${refSubPixelOffset.y.toFixed(3)})`);

        // === Create Alignment Points Grid ===
        const { alignmentPoints, patchSize, searchRadius } = createAPGrid(width, height, surfaceMode);
        console.log(`Created ${alignmentPoints.length} alignment points (${patchSize}px patches, ${searchRadius}px search, surfaceMode=${surfaceMode})`);

        // === Find local shifts for each frame at each AP ===
        const refIndex = validFrames.findIndex(f => f === referenceFrame);
        self.postMessage({ type: 'stack-progress', stage: `Aligning frame 1/${frameCount}...`, progress: 5 });
        const frameShifts = new Array(frameCount); // frameShifts[frameIdx][apIdx] = {dx, dy, quality}

        // Create reference Mat once (reused for all frames)
        if (!referenceFrame.float32Buffer || referenceFrame.float32Buffer.byteLength === 0) {
            throw new Error(`Reference frame buffer is detached or empty`);
        }

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Clean up any previous failed attempts
                if (refMat) { try { refMat.delete(); } catch(e) {} refMat = null; }
                if (refGray) { try { refGray.delete(); } catch(e) {} refGray = null; }

                refMat = new _cv.Mat(height, width, _cv.CV_8UC4);
                refMat.data.set(refData);
                refGray = new _cv.Mat();
                _cv.cvtColor(refMat, refGray, _cv.COLOR_RGBA2GRAY);

                // Create blurred version for noise-robust coarse alignment (PSS-style) - only if enabled
                if (noiseRobustAlignment) {
                    refGrayBlurred = new _cv.Mat();
                    const ksize = new _cv.Size(5, 5); // 5x5 Gaussian kernel
                    _cv.GaussianBlur(refGray, refGrayBlurred, ksize, 0);
                }

                lastError = null;
                break; // Success!
            } catch (e) {
                lastError = typeof e === 'number' ? `OpenCV error ${e}` : (e.message || String(e));
                console.warn(`  Attempt ${attempt}/${maxRetries} failed: ${lastError}`);

                // Clean up failed attempt
                if (refMat) { try { refMat.delete(); } catch(e) {} refMat = null; }
                if (refGray) { try { refGray.delete(); } catch(e) {} refGray = null; }

                if (attempt < maxRetries) {
                    // Small delay before retry
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }

        if (lastError) {
            throw new Error(`Failed to create reference Mat after ${maxRetries} attempts: ${lastError}`);
        }

        // Filter APs by structure and brightness (PSS defaults: 0.02, 5)
        const filteredAPs = filterAPsByQuality(alignmentPoints, refGray, width, height, patchSize, 0.02, 5);
        console.log(`Filtered APs: ${filteredAPs.length}/${alignmentPoints.length} passed quality threshold`);

        // Use filtered APs for alignment
        const activeAPs = filteredAPs.length > 0 ? filteredAPs : alignmentPoints;

        // Surface mode: sort frames by original index for proper drift tracking
        // Quality selector may pick frames out of temporal order, but drift tracking
        // needs frames processed in sequence (frame 10 → 50 → 100, not 100 → 10 → 50)
        let processingOrder = validFrames.map((f, i) => i); // Default: original array order
        if (surfaceMode) {
            // Sort by original frame index (temporal order)
            processingOrder = validFrames
                .map((f, i) => ({ arrayIdx: i, frameIdx: f.index || i }))
                .sort((a, b) => a.frameIdx - b.frameIdx)
                .map(x => x.arrayIdx);
            console.log(`Surface mode: processing ${frameCount} frames in temporal order`);
        }

        // Surface mode: track cumulative drift across frames (PSS-like)
        // This helps when the object (Moon/Sun) drifts across the frame
        let cumulativeDrift = { dx: 0, dy: 0 };

        for (let p = 0; p < frameCount; p++) {
            const f = processingOrder[p]; // Map to actual frame index in validFrames
            const frame = validFrames[f];

            // Skip alignment for reference frame - it has zero shift by definition
            if (f === refIndex) {
                const zeroShifts = activeAPs.map(() => ({ dx: 0, dy: 0, quality: 1 }));
                frameShifts[f] = zeroShifts;
                continue;
            }

            // Validate frame data
            if (!frame.float32Buffer || frame.float32Buffer.byteLength === 0) {
                console.error(`Frame ${f}: Invalid or detached float32Buffer`);
                throw new Error(`Frame ${f} has invalid float32 buffer (byteLength: ${frame.float32Buffer?.byteLength || 0})`);
            }

            const expectedSize = width * height * 4 * 4; // Float32 = 4 bytes per value
            if (frame.float32Buffer.byteLength !== expectedSize) {
                console.error(`Frame ${f}: Buffer size mismatch. Expected ${expectedSize}, got ${frame.float32Buffer.byteLength}`);
                throw new Error(`Frame ${f} buffer size mismatch: expected ${expectedSize}, got ${frame.float32Buffer.byteLength}`);
            }

            const frameData = float32ToUint8(frame.float32Buffer); // Convert for OpenCV

            // CPU path: OpenCV template matching
            let frameMat = null, frameGray = null, frameGrayBlurred = null;
            try {
                // Try to create Mat with fallback
                try {
                    frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
                } catch (matErr) {
                    // Fallback to matFromArray if constructor fails
                    frameMat = _cv.matFromArray(height, width, _cv.CV_8UC4, frameData);
                }

                if (frameMat.data) {
                    frameMat.data.set(frameData);
                }
                frameGray = new _cv.Mat();
                _cv.cvtColor(frameMat, frameGray, _cv.COLOR_RGBA2GRAY);

                // Create blurred version for noise-robust coarse alignment - only if enabled
                if (noiseRobustAlignment) {
                    frameGrayBlurred = new _cv.Mat();
                    const ksize = new _cv.Size(5, 5);
                    _cv.GaussianBlur(frameGray, frameGrayBlurred, ksize, 0);
                }

                const shifts = [];
                // Surface mode: pass expected drift to offset search regions
                const expectedShift = surfaceMode ? cumulativeDrift : null;

                for (let a = 0; a < activeAPs.length; a++) {
                    const ap = activeAPs[a];
                    // Two-phase alignment: coarse on blurred, fine on original
                    const shift = findLocalShiftFast(refGray, frameGray, width, height, ap, patchSize, searchRadius, refGrayBlurred, frameGrayBlurred, expectedShift);
                    shifts.push(shift);
                }
                frameShifts[f] = shifts;

                // Surface mode: update cumulative drift using median of good shifts
                if (surfaceMode && shifts.length > 0) {
                    // Filter for good quality matches (quality > 0.3)
                    const goodShifts = shifts.filter(s => s.quality > 0.3);
                    if (goodShifts.length > 3) {
                        // Calculate median dx/dy as this frame's global drift
                        const sortedDx = goodShifts.map(s => s.dx).sort((a, b) => a - b);
                        const sortedDy = goodShifts.map(s => s.dy).sort((a, b) => a - b);
                        const medianIdx = Math.floor(goodShifts.length / 2);
                        const frameDriftDx = sortedDx[medianIdx];
                        const frameDriftDy = sortedDy[medianIdx];

                        // Update cumulative drift (add this frame's drift to running total)
                        cumulativeDrift = {
                            dx: cumulativeDrift.dx + frameDriftDx,
                            dy: cumulativeDrift.dy + frameDriftDy
                        };
                        previousFrameDrift = { dx: frameDriftDx, dy: frameDriftDy };
                    }
                }
            } catch (cvError) {
                const errMsg = typeof cvError === 'number' ? `OpenCV error code: ${cvError}` : (cvError.message || String(cvError));
                console.error(`Frame ${f}: OpenCV error during alignment:`, errMsg);
                throw new Error(`Frame ${f} alignment error: ${errMsg}`);
            } finally {
                // Always clean up Mats
                if (frameGrayBlurred) try { frameGrayBlurred.delete(); } catch(e) {}
                if (frameGray) try { frameGray.delete(); } catch(e) {}
                if (frameMat) try { frameMat.delete(); } catch(e) {}
            }

            // Update progress
            const progress = 5 + (f / frameCount) * 45;
            self.postMessage({
                type: 'stack-progress',
                stage: `Aligning frame ${f + 1}/${frameCount}...`,
                progress: progress
            });
        }

        // Clean up reference Mats after alignment phase
        if (refGrayBlurred) { refGrayBlurred.delete(); refGrayBlurred = null; }
        if (refGray) { refGray.delete(); refGray = null; }
        if (refMat) { refMat.delete(); refMat = null; }
        const modeInfo = [
            noiseRobustAlignment ? 'two-phase' : null,
            surfaceMode ? `surface mode, total drift: ${cumulativeDrift.dx.toFixed(1)},${cumulativeDrift.dy.toFixed(1)}px` : null
        ].filter(Boolean).join(', ');
        console.log(`Alignment complete${modeInfo ? ` (${modeInfo})` : ''}`);

        // === Stack with LOCAL de-warping ===
        self.postMessage({ type: 'stack-progress', stage: isDrizzle ? 'Drizzle stacking...' : 'De-warping frames...', progress: 50 });

        // Accumulator for final image (RGB + weight per pixel) - at OUTPUT resolution
        const accumR = new Float32Array(outWidth * outHeight);
        const accumG = new Float32Array(outWidth * outHeight);
        const accumB = new Float32Array(outWidth * outHeight);
        const accumWeight = new Float32Array(outWidth * outHeight);

        // Normalize sharpness for weighting
        const totalSharpness = validFrames.reduce((sum, f) => sum + f.sharpness, 0);

        // === Brightness normalization (PSS-like, black cutoff = ~4/255 in 0.0-1.0 range) ===
        const blackCutoff = 0.016;

        // Calculate mean brightness using sparse sampling (every 8th pixel in each direction = 1/64 of pixels)
        // Works with Float32 data in 0.0-1.0 range
        function calcMeanBrightness(float32Buffer, width, height, blackCutoff) {
            const data = new Float32Array(float32Buffer);
            let sum = 0;
            let count = 0;
            const step = 8; // Sample every 8th pixel in x and y
            for (let y = 0; y < height; y += step) {
                const rowOffset = y * width * 4;
                for (let x = 0; x < width; x += step) {
                    const i = rowOffset + x * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
            return count > 0 ? sum / count : 1;
        }

        const refBrightness = calcMeanBrightness(referenceFrame.float32Buffer, width, height, blackCutoff);

        // Local de-warping with improved Gaussian weighting to reduce grid artifacts
        const useLocalDewarping = true;

        if (useLocalDewarping) {
            // Create remap matrices at OUTPUT resolution (for drizzle upscaling)
            mapX = new _cv.Mat(outHeight, outWidth, _cv.CV_32FC1);
            mapY = new _cv.Mat(outHeight, outWidth, _cv.CV_32FC1);
        }

        for (let f = 0; f < frameCount; f++) {
            const frame = validFrames[f];

            // Re-validate buffer (should still be valid from alignment phase)
            if (!frame.float32Buffer || frame.float32Buffer.byteLength === 0) {
                console.error(`Stack frame ${f}: Buffer became invalid`);
                throw new Error(`Frame ${f} buffer invalid during stacking`);
            }

            const frameData = float32ToUint8(frame.float32Buffer); // Convert for OpenCV remap
            const frameWeight = frame.sharpness / totalSharpness * frameCount;

            // Calculate brightness normalization factor for this frame
            const frameBrightness = calcMeanBrightness(frame.float32Buffer, width, height, blackCutoff);
            const brightnessScale = refBrightness / frameBrightness;

            if (useLocalDewarping) {
                const shifts = frameShifts[f];

                // Compute global offset: how much to shift this frame to align with reference
                // DISABLED: Testing if global offset causes moiré via interpolation artifacts
                // The subPixelOffset tells us how much the planet center differs from crop center
                // If frame's planet is MORE to the right than ref's planet, we shift frame LEFT
                // In remap, shifting LEFT means sampling from further RIGHT (positive offset)
                // So globalOffset = frameOffset - refOffset
                const frameSubPixelOffset = frame.subPixelOffset || { x: 0, y: 0 };
                // const globalOffsetX = frameSubPixelOffset.x - refSubPixelOffset.x;
                // const globalOffsetY = frameSubPixelOffset.y - refSubPixelOffset.y;
                const globalOffsetX = 0; // Disabled for testing
                const globalOffsetY = 0;

                // Create frame Mat
                let frameMat = null, warpedMat = null;
                try {
                    frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
                    frameMat.data.set(frameData);

                    // Build displacement maps from shifts (local atmospheric wobble) plus global offset
                    // Maps are at OUTPUT resolution, mapping back to INPUT coordinates
                    buildDisplacementMaps(mapX, mapY, outWidth, outHeight, activeAPs, shifts, patchSize, globalOffsetX, globalOffsetY, drizzleScale);

                    // Apply local de-warping via remap (output will be at outWidth x outHeight)
                    warpedMat = new _cv.Mat();
                    _cv.remap(frameMat, warpedMat, mapX, mapY, _cv.INTER_LINEAR, _cv.BORDER_CONSTANT);

                    // Accumulate warped frame with brightness normalization (at OUTPUT resolution)
                    const warpedData = warpedMat.data;
                    for (let i = 0; i < outWidth * outHeight; i++) {
                        const srcIdx = i * 4;
                        // Skip black pixels (border from remap)
                        if (warpedData[srcIdx] === 0 && warpedData[srcIdx + 1] === 0 && warpedData[srcIdx + 2] === 0) {
                            continue;
                        }
                        // Apply brightness normalization
                        accumR[i] += warpedData[srcIdx] * brightnessScale * frameWeight;
                        accumG[i] += warpedData[srcIdx + 1] * brightnessScale * frameWeight;
                        accumB[i] += warpedData[srcIdx + 2] * brightnessScale * frameWeight;
                        accumWeight[i] += frameWeight;
                    }
                } catch (cvError) {
                    const errMsg = typeof cvError === 'number' ? `OpenCV error code: ${cvError}` : (cvError.message || String(cvError));
                    console.error(`De-warp frame ${f}: OpenCV error:`, errMsg);
                    throw new Error(`Frame ${f} de-warp error: ${errMsg}`);
                } finally {
                    if (warpedMat) try { warpedMat.delete(); } catch(e) {}
                    if (frameMat) try { frameMat.delete(); } catch(e) {}
                }
            } else {
                // Simple weighted averaging without de-warping (with brightness normalization)
                for (let i = 0; i < width * height; i++) {
                    const srcIdx = i * 4;
                    accumR[i] += frameData[srcIdx] * brightnessScale * frameWeight;
                    accumG[i] += frameData[srcIdx + 1] * brightnessScale * frameWeight;
                    accumB[i] += frameData[srcIdx + 2] * brightnessScale * frameWeight;
                    accumWeight[i] += frameWeight;
                }
            }

            // Update progress every frame
            self.postMessage({
                type: 'stack-progress',
                stage: `Stacking frame ${f + 1}/${frameCount}...`,
                progress: 50 + (f / frameCount) * 45 // 50-95%
            });
        }

        // Clean up remap matrices if used
        if (mapX) { mapX.delete(); mapX = null; }
        if (mapY) { mapY.delete(); mapY = null; }
        console.log('Stacking complete');

        // === Compute final result (at OUTPUT resolution) ===
        self.postMessage({ type: 'stack-progress', stage: 'Finalizing...', progress: 95 });
        const result = new Uint8ClampedArray(outWidth * outHeight * 4);
        // Also create Float32Array for 16-bit post-processing (RGBA, 0.0-1.0 range)
        const float32Data = new Float32Array(outWidth * outHeight * 4);

        for (let i = 0; i < outWidth * outHeight; i++) {
            const w = accumWeight[i];
            if (w > 0) {
                // Normalized float values (0.0-1.0) - preserves full accumulator precision
                const r = accumR[i] / w / 255.0;
                const g = accumG[i] / w / 255.0;
                const b = accumB[i] / w / 255.0;

                // Float32 output (full precision)
                float32Data[i * 4 + 0] = r;
                float32Data[i * 4 + 1] = g;
                float32Data[i * 4 + 2] = b;
                float32Data[i * 4 + 3] = 1.0;

                // 8-bit output (for preview/compatibility)
                result[i * 4 + 0] = Math.round(r * 255);
                result[i * 4 + 1] = Math.round(g * 255);
                result[i * 4 + 2] = Math.round(b * 255);
            } else {
                // Fallback to black if no data (edge case for drizzle borders)
                float32Data[i * 4 + 0] = 0;
                float32Data[i * 4 + 1] = 0;
                float32Data[i * 4 + 2] = 0;
                float32Data[i * 4 + 3] = 1.0;
                result[i * 4 + 0] = 0;
                result[i * 4 + 1] = 0;
                result[i * 4 + 2] = 0;
            }
            result[i * 4 + 3] = 255; // Alpha
        }

        // Create ImageData and convert to blob at OUTPUT resolution
        const canvas = new OffscreenCanvas(outWidth, outHeight);
        const ctx = canvas.getContext('2d');
        const imageData = new ImageData(result, outWidth, outHeight);
        ctx.putImageData(imageData, 0, 0);

        const blob = await safeConvertToBlob(canvas, { type: 'image/png' });
        console.log(`Stacked image: ${outWidth}x${outHeight}${isDrizzle ? ` (${drizzleScale}x drizzle from ${width}x${height})` : ''}, ${(blob.size / 1024).toFixed(1)} KB`);

        self.postMessage({ type: 'stack-progress', stage: 'Stacking complete', progress: 100 });
        return { blob, width: outWidth, height: outHeight, float32Data };

    } catch (error) {
        // Convert OpenCV error codes to meaningful messages
        const errorMsg = typeof error === 'number'
            ? `OpenCV error code: ${error}`
            : (error.message || String(error));
        console.error('Stacking failed:', errorMsg);
        throw new Error(errorMsg);
    } finally {
        // Clean up any remaining OpenCV resources
        if (refGray) try { refGray.delete(); } catch(e) {}
        if (refMat) try { refMat.delete(); } catch(e) {}
        if (mapX) try { mapX.delete(); } catch(e) {}
        if (mapY) try { mapY.delete(); } catch(e) {}
    }
}

/**
 * Create a grid of alignment points
 * Parameters matched to PSS (Planetary System Stacker) defaults
 * @param surfaceMode - If true, use larger search radius for Moon/Sun surface (handles drift)
 */
function createAPGrid(width, height, surfaceMode = false) {
    // PSS default: alignment box width = 20px
    const patchSize = 20;
    // PSS default: max alignment search width = 8px for planets, 34px for surface (Moon/Sun)
    const searchRadius = surfaceMode ? 34 : 8;

    // Adaptive spacing based on image size
    // For small images (<500px), use larger spacing to avoid too many APs
    // Target ~100-200 APs for good coverage without excessive computation
    const minDim = Math.min(width, height);
    let spacing;
    if (minDim < 300) {
        spacing = 30; // ~100 APs for 300x300
    } else if (minDim < 500) {
        spacing = 25; // ~150 APs for 400x400
    } else if (minDim < 800) {
        spacing = 20; // ~250 APs for 600x600
    } else {
        spacing = Math.floor(patchSize / 2); // 10px = 50% overlap for large images
    }

    const alignmentPoints = [];
    const marginX = Math.floor((width % spacing) / 2) + patchSize / 2;
    const marginY = Math.floor((height % spacing) / 2) + patchSize / 2;

    for (let y = marginY; y < height - patchSize / 2; y += spacing) {
        for (let x = marginX; x < width - patchSize / 2; x += spacing) {
            alignmentPoints.push({ x, y });
        }
    }

    return { alignmentPoints, patchSize, searchRadius };
}

/**
 * Filter alignment points by structure (local contrast) and brightness
 * PSS defaults: minStructure=0.02, minBrightness=5
 */
function filterAPsByQuality(alignmentPoints, refGray, width, height, patchSize, minStructure = 0.02, minBrightness = 5) {
    const halfPatch = Math.floor(patchSize / 2);
    const refData = refGray.data;
    const filtered = [];

    for (const ap of alignmentPoints) {
        const x0 = ap.x - halfPatch;
        const y0 = ap.y - halfPatch;

        // Bounds check
        if (x0 < 0 || y0 < 0 || x0 + patchSize > width || y0 + patchSize > height) {
            continue;
        }

        // Calculate mean brightness and structure (std dev) of patch
        let sum = 0;
        let sumSq = 0;
        const n = patchSize * patchSize;

        for (let py = 0; py < patchSize; py++) {
            for (let px = 0; px < patchSize; px++) {
                const val = refData[(y0 + py) * width + (x0 + px)];
                sum += val;
                sumSq += val * val;
            }
        }

        const mean = sum / n;
        const variance = (sumSq / n) - (mean * mean);
        const stdDev = Math.sqrt(Math.max(0, variance));
        // Structure is normalized std dev (0-1 range)
        const structure = stdDev / 255;

        // Filter by PSS criteria
        if (mean >= minBrightness && structure >= minStructure) {
            filtered.push(ap);
        }
    }

    return filtered;
}

/**
 * Build displacement maps for cv.remap by interpolating AP shifts
 * This creates a smooth warp field from sparse alignment point measurements
 * Uses Gaussian weighting for smooth transitions between AP regions
 *
 * @param globalOffsetX - Global X offset to align frame with reference (from sub-pixel crop centering)
 * @param globalOffsetY - Global Y offset to align frame with reference (from sub-pixel crop centering)
 */
function buildDisplacementMaps(mapX, mapY, outWidth, outHeight, alignmentPoints, shifts, patchSize, globalOffsetX = 0, globalOffsetY = 0, drizzleScale = 1.0, minApQuality = 0.3) {
    const mapXData = mapX.data32F;
    const mapYData = mapY.data32F;

    // Larger influence radius for smoother blending (was patchSize * 2)
    const influenceRadius = patchSize * 4;
    // Gaussian sigma - controls falloff smoothness
    const sigma = patchSize * 1.5;
    const sigma2 = sigma * sigma * 2;

    // Minimum quality threshold - ignore poor matches
    const minQuality = minApQuality;

    // For drizzle, output is larger than input
    // Each output pixel maps back to a sub-pixel location in input space
    const invScale = 1.0 / drizzleScale;

    for (let oy = 0; oy < outHeight; oy++) {
        for (let ox = 0; ox < outWidth; ox++) {
            const idx = oy * outWidth + ox;

            // Map output pixel to input coordinate space
            const inX = ox * invScale;
            const inY = oy * invScale;

            // Interpolate shift from nearby APs using Gaussian weighting
            // APs are in input coordinate space
            let totalWeight = 0;
            let weightedDx = 0;
            let weightedDy = 0;

            for (let i = 0; i < alignmentPoints.length; i++) {
                const ap = alignmentPoints[i];
                const shift = shifts[i];

                // Skip low-quality matches - they add noise
                if (shift.quality < minQuality) continue;

                const dx = inX - ap.x;
                const dy = inY - ap.y;
                const dist2 = dx * dx + dy * dy;

                if (dist2 < influenceRadius * influenceRadius) {
                    // Gaussian weighting for smooth falloff (no sharp boundaries)
                    const gaussWeight = Math.exp(-dist2 / sigma2);
                    // Scale by match quality
                    const weight = gaussWeight * shift.quality;

                    weightedDx += shift.dx * weight;
                    weightedDy += shift.dy * weight;
                    totalWeight += weight;
                }
            }

            // remap uses source coordinates (input frame coordinates)
            // Global offset aligns frame to reference (compensates for per-frame crop centering)
            // Local shift (from APs) corrects for atmospheric wobble
            if (totalWeight > 0) {
                mapXData[idx] = inX + globalOffsetX + weightedDx / totalWeight;
                mapYData[idx] = inY + globalOffsetY + weightedDy / totalWeight;
            } else {
                // No nearby APs - apply global offset only
                mapXData[idx] = inX + globalOffsetX;
                mapYData[idx] = inY + globalOffsetY;
            }
        }
    }
}

/**
 * Two-phase AP alignment (PSS-style):
 * Phase 1: Match on blurred images (robust to noise, finds coarse shift)
 * Phase 2: Refine on original images (precise alignment)
 * @param expectedShift - Optional {dx, dy} for surface mode drift tracking (offsets search region)
 */
function findLocalShiftFast(refGray, frameGray, width, height, ap, patchSize, searchRadius, refGrayBlurred = null, frameGrayBlurred = null, expectedShift = null) {
    const halfPatch = Math.floor(patchSize / 2);

    // Apply expected shift offset for drift tracking (surface mode)
    const offsetX = expectedShift ? Math.round(expectedShift.dx) : 0;
    const offsetY = expectedShift ? Math.round(expectedShift.dy) : 0;

    // Define template region (from reference) and search region (from frame)
    // Search region is offset by expected drift to center search around likely position
    const templateX = ap.x - halfPatch;
    const templateY = ap.y - halfPatch;
    const searchX = ap.x - halfPatch - searchRadius + offsetX;
    const searchY = ap.y - halfPatch - searchRadius + offsetY;
    const searchSize = patchSize + searchRadius * 2;

    // Bounds check
    if (templateX < 0 || templateY < 0 ||
        templateX + patchSize > width || templateY + patchSize > height ||
        searchX < 0 || searchY < 0 ||
        searchX + searchSize > width || searchY + searchSize > height) {
        return { dx: 0, dy: 0, quality: 0 };
    }

    let templateMat = null, searchMat = null, resultMat = null;
    let templateMatBlur = null, searchMatBlur = null, resultMatBlur = null;

    try {
        let coarseDx = 0, coarseDy = 0;

        // PHASE 1: Coarse alignment on blurred images (if available)
        if (refGrayBlurred && frameGrayBlurred) {
            templateMatBlur = refGrayBlurred.roi(new _cv.Rect(templateX, templateY, patchSize, patchSize));
            searchMatBlur = frameGrayBlurred.roi(new _cv.Rect(searchX, searchY, searchSize, searchSize));

            resultMatBlur = new _cv.Mat();
            _cv.matchTemplate(searchMatBlur, templateMatBlur, resultMatBlur, _cv.TM_CCOEFF_NORMED);

            const minMaxBlur = _cv.minMaxLoc(resultMatBlur);
            coarseDx = minMaxBlur.maxLoc.x - searchRadius;
            coarseDy = minMaxBlur.maxLoc.y - searchRadius;

            // Clean up phase 1
            templateMatBlur.delete(); templateMatBlur = null;
            searchMatBlur.delete(); searchMatBlur = null;
            resultMatBlur.delete(); resultMatBlur = null;
        }

        // PHASE 2: Fine alignment on original images
        // Use coarse shift to narrow search area (±2 pixels around coarse result)
        const fineSearchRadius = refGrayBlurred ? 2 : searchRadius;
        const fineSearchX = searchX + coarseDx + searchRadius - fineSearchRadius;
        const fineSearchY = searchY + coarseDy + searchRadius - fineSearchRadius;
        const fineSearchSize = patchSize + fineSearchRadius * 2;

        // Bounds check for fine search
        if (fineSearchX < 0 || fineSearchY < 0 ||
            fineSearchX + fineSearchSize > width || fineSearchY + fineSearchSize > height) {
            // Fall back to coarse result
            return { dx: coarseDx, dy: coarseDy, quality: 0.5 };
        }

        // Extract template from reference (the patch we're looking for)
        templateMat = refGray.roi(new _cv.Rect(templateX, templateY, patchSize, patchSize));

        // Extract search region from frame (narrowed by coarse alignment)
        searchMat = frameGray.roi(new _cv.Rect(fineSearchX, fineSearchY, fineSearchSize, fineSearchSize));

        // Run template matching on original (sharp) data
        resultMat = new _cv.Mat();
        _cv.matchTemplate(searchMat, templateMat, resultMat, _cv.TM_CCOEFF_NORMED);

        // Find best match location
        const minMax = _cv.minMaxLoc(resultMat);
        const bestLoc = minMax.maxLoc;
        const quality = minMax.maxVal;

        // Calculate final shift (coarse + fine refinement)
        const fineDx = bestLoc.x - fineSearchRadius;
        const fineDy = bestLoc.y - fineSearchRadius;
        const dx = coarseDx + fineDx;
        const dy = coarseDy + fineDy;

        return { dx, dy, quality: Math.max(0, quality) };

    } catch (err) {
        return { dx: 0, dy: 0, quality: 0 };
    } finally {
        // IMPORTANT: roi() Mats MUST be deleted in OpenCV.js
        if (templateMat) try { templateMat.delete(); } catch(e) {}
        if (searchMat) try { searchMat.delete(); } catch(e) {}
        if (resultMat) try { resultMat.delete(); } catch(e) {}
        if (templateMatBlur) try { templateMatBlur.delete(); } catch(e) {}
        if (searchMatBlur) try { searchMatBlur.delete(); } catch(e) {}
        if (resultMatBlur) try { resultMatBlur.delete(); } catch(e) {}
    }
}

/**
 * Find local shift at an alignment point using OpenCV's matchTemplate
 * This is the same approach PSS uses - optimized WASM correlation
 */
function findLocalShift(refData, frameData, width, height, ap, patchSize, searchRadius) {
    const halfPatch = Math.floor(patchSize / 2);

    // Define template region (from reference) and search region (from frame)
    const templateX = ap.x - halfPatch;
    const templateY = ap.y - halfPatch;
    const searchX = ap.x - halfPatch - searchRadius;
    const searchY = ap.y - halfPatch - searchRadius;
    const searchSize = patchSize + searchRadius * 2;

    // Bounds check
    if (templateX < 0 || templateY < 0 ||
        templateX + patchSize > width || templateY + patchSize > height ||
        searchX < 0 || searchY < 0 ||
        searchX + searchSize > width || searchY + searchSize > height) {
        return { dx: 0, dy: 0, quality: 0 };
    }

    let templateMat, searchMat, resultMat, refMat, frameMat;
    let templateGray, searchGray;

    try {
        // Create Mats from RGBA data
        refMat = new _cv.Mat(height, width, _cv.CV_8UC4);
        refMat.data.set(refData);
        frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
        frameMat.data.set(frameData);

        // Extract template from reference (the patch we're looking for)
        const templateRect = new _cv.Rect(templateX, templateY, patchSize, patchSize);
        templateMat = refMat.roi(templateRect).clone();

        // Extract search region from frame (where we look for the template)
        const searchRect = new _cv.Rect(searchX, searchY, searchSize, searchSize);
        searchMat = frameMat.roi(searchRect).clone();

        // Convert to grayscale for matching
        templateGray = new _cv.Mat();
        searchGray = new _cv.Mat();
        _cv.cvtColor(templateMat, templateGray, _cv.COLOR_RGBA2GRAY);
        _cv.cvtColor(searchMat, searchGray, _cv.COLOR_RGBA2GRAY);

        // Run template matching
        resultMat = new _cv.Mat();
        _cv.matchTemplate(searchGray, templateGray, resultMat, _cv.TM_CCOEFF_NORMED);

        // Find best match location
        const minMax = _cv.minMaxLoc(resultMat);
        const bestLoc = minMax.maxLoc; // For TM_CCOEFF_NORMED, max is best
        const quality = minMax.maxVal;

        // Calculate shift (bestLoc is relative to search region, searchRadius is the offset)
        const dx = bestLoc.x - searchRadius;
        const dy = bestLoc.y - searchRadius;

        // Cleanup
        templateGray.delete();
        searchGray.delete();
        templateMat.delete();
        searchMat.delete();
        resultMat.delete();
        refMat.delete();
        frameMat.delete();

        return { dx, dy, quality: Math.max(0, quality) };

    } catch (err) {
        // Cleanup on error
        if (templateGray) try { templateGray.delete(); } catch(e) {}
        if (searchGray) try { searchGray.delete(); } catch(e) {}
        if (templateMat) try { templateMat.delete(); } catch(e) {}
        if (searchMat) try { searchMat.delete(); } catch(e) {}
        if (resultMat) try { resultMat.delete(); } catch(e) {}
        if (refMat) try { refMat.delete(); } catch(e) {}
        if (frameMat) try { frameMat.delete(); } catch(e) {}

        console.warn('matchTemplate failed:', err);
        return { dx: 0, dy: 0, quality: 0 };
    }
}


