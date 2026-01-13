// public/unified_analyze_worker.js
console.log('unified_analyze_worker.js loaded (v28 - production cleanup)');

// Use _cv to avoid conflicts with global 'cv' from opencv-bindings
let _cv = null;
let isCvReady = false;
const messageQueue = [];
let loggedDemosaicMethod = false; // Log demosaic method once per worker

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

        // Frame stacking with local alignment
        if (type === 'stack-frames') {
            const { frames } = e.data; // Array of {rgbaBuffer, width, height, sharpness}
            try {
                const result = await stackFramesLocally(frames);
                self.postMessage({ type: 'stack-complete', blob: result.blob, width: result.width, height: result.height });
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

        // Analyze PNG with cropping (for image files)
        if (type === 'analyze-cropped-png') {
            const { pngData, cropRegion, includeRgba } = e.data;
            const result = await analyzeAndCropPng(pngData, cropRegion, index, includeRgba);
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
            if (includeRgba && result.rgbaBuffer) {
                response.rgbaBuffer = result.rgbaBuffer;
                response.width = result.width;
                response.height = result.height;
                self.postMessage(response, [result.rgbaBuffer]);
            } else {
                self.postMessage(response);
            }
            return;
        }

        // Analyze with optional cropping - uses fixed reference center for stable positioning
        if (type === 'analyze-cropped') {
            const { frameBuffer, header, bayerChoice, cropRegion } = e.data;

            // Calculate expected size based on file type
            let expectedSize;
            if (header.fileId && header.fileId.startsWith('LUCAM-REC')) {
                // SER file: single channel
                expectedSize = header.width * header.height * (header.pixelDepth > 8 ? 2 : 1);
            } else {
                // AVI file (or RGBA from decoded PNG): use fourCC to determine channels
                const bytesPerPixel = { 'DIB ': 3, 'RGB ': 3, 'Y800': 1, 'YUY2': 2, 'UYVY': 2, 'RGBA': 4 }[header.fourCC] || 3;
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

            // Skip frames where the object is cut-off (partially outside frame)
            if (bounds.reason === 'cut-off') {
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

            const includeRgba = e.data.clientSideStacking === true;
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, actualCropRegion, index, includeRgba);

            const response = {
                sharpness: result.sharpness,
                pngBlob: result.pngBlob,
                croppedBuffer: result.croppedBuffer,
                // Force subPixelOffset to 0 - testing if this causes moiré
                subPixelOffset: { x: 0, y: 0 },
                index,
                circularity: bounds.circularity || 0
            };

            // Only include RGBA data when client-side stacking is enabled
            if (includeRgba && result.rgbaBuffer) {
                response.rgbaBuffer = result.rgbaBuffer;
                response.width = result.width;
                response.height = result.height;
                self.postMessage(response, [result.rgbaBuffer]); // Transfer for zero-copy
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
            pngBlob = blob; // Reuse the blob we created

            imgMat.delete();
            grayMat.delete();
            imageBitmap.close();

            // Return with rgbaBuffer if client-side stacking is enabled
            if (includeRgba) {
                const rgbaBuffer = imageData.data.buffer.slice(0); // Copy the buffer
                self.postMessage({
                    sharpness, pngBlob, index,
                    rgbaBuffer: rgbaBuffer,
                    width: imageData.width,
                    height: imageData.height
                }, [rgbaBuffer]);
                return;
            }
        } else if (type === 'ser' || type === 'avi') {
            const header = type === 'ser' ? e.data.header : e.data.aviHeader;
            const { frameBuffer, bayerChoice } = e.data;

            // Check for cut-off even in non-crop mode
            const bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            if (bounds.reason === 'cut-off' || bounds.reason === 'touches-edge') {
                self.postMessage({ skipped: true, reason: 'cut-off', index });
                return;
            }

            const includeRgba = e.data.clientSideStacking === true;
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, null, index, includeRgba);
            sharpness = result.sharpness;
            pngBlob = result.pngBlob;

            // Include circularity for reference frame selection (1.0 = perfect circle)
            circularity = bounds.circularity || 0;

            // Return with rgbaBuffer if client-side stacking is enabled
            if (includeRgba && result.rgbaBuffer) {
                self.postMessage({
                    sharpness, pngBlob, index, circularity,
                    rgbaBuffer: result.rgbaBuffer,
                    width: result.width,
                    height: result.height
                }, [result.rgbaBuffer]);
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

async function processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, cropRegion = null, frameIndex = undefined, includeRgba = false) {
    const { width, height, pixelDepth, fourCC, bpp } = header;
    let rawMat, grayMat, rgbaMat;
    let croppedBuffer = null;

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

                    // Convert to 8-bit RGB after demosaicing
                    if (pixelDepth > 8) {
                        demosaiced8 = new _cv.Mat();
                        demosaiced.convertTo(demosaiced8, _cv.CV_8UC3, 1/256);
                        rgbFull = demosaiced8;
                        demosaiced8 = null; // Don't delete, we're using it
                    } else {
                        rgbFull = demosaiced;
                        demosaiced = null; // Don't delete, we're using it
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
            const aviDataType = { 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[fourCC];
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));

            // For AVI with Bayer (Y800), demosaic first then crop
            if (fourCC === 'Y800' && bayerChoice && bayerChoice !== "MONO" && _cv[bayerChoice]) {
                const vngChoice = bayerChoice + '_VNG';
                const demosaicMethod = _cv[vngChoice] !== undefined ? vngChoice : bayerChoice;
                const demosaiced = new _cv.Mat();
                _cv.demosaicing(rawMat, demosaiced, _cv[demosaicMethod]);
                rgbaMat = new _cv.Mat();
                _cv.cvtColor(demosaiced, rgbaMat, _cv.COLOR_BGR2RGBA);
                demosaiced.delete();
                rawMat.delete();
                rawMat = null;

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
                if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
                } else if (fourCC === 'RGBA') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
                } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                    _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
                } else {
                    rawMat.copyTo(grayMat);
                }

                // Convert to RGBA
                rgbaMat = new _cv.Mat();
                if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_BGR2RGBA);
                } else if (fourCC === 'RGBA') {
                    rawMat.copyTo(rgbaMat);
                } else if (fourCC === 'Y800') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_GRAY2RGBA);
                } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_YUV2RGBA_YUY2);
                }
            }
        }

        // Get actual dimensions (may be cropped)
        const actualWidth = rgbaMat.cols;
        const actualHeight = rgbaMat.rows;

        // --- Step 2: Calculate sharpness from the grayscale mat ---
        const sharpness = calculateSharpnessFromMat(grayMat, frameIndex);

        // --- Step 4: Create PNG Blob (optional - may fail if memory is tight) ---
        let pngBlob = null;
        try {
            const tempOffscreenCanvas = new OffscreenCanvas(actualWidth, actualHeight);
            const tempCtx = tempOffscreenCanvas.getContext('2d');
            const expectedBytes = actualWidth * actualHeight * 4;
            if (rgbaMat.data.length !== expectedBytes) {
                throw new Error(`RGBA mat size mismatch: got ${rgbaMat.data.length}, expected ${expectedBytes}`);
            }
            const imageData = new ImageData(new Uint8ClampedArray(rgbaMat.data), actualWidth, actualHeight);
            tempCtx.putImageData(imageData, 0, 0);
            pngBlob = await tempOffscreenCanvas.convertToBlob({ type: 'image/png' });
        } catch (pngErr) {
            // PNG creation failed (likely out of memory) - continue without it
            // The rgbaBuffer can still be used for stacking and preview generation
            if (frameIndex !== undefined && frameIndex % 500 === 0) {
                console.warn(`PNG creation skipped for frame ${frameIndex} (memory): ${pngErr.message || pngErr}`);
            }
        }

        // --- Step 5: Get RGBA buffer for client-side stacking (copy before mat is deleted) ---
        let rgbaBuffer = null;
        if (includeRgba) {
            rgbaBuffer = new Uint8ClampedArray(rgbaMat.data).buffer;
        }

        return { sharpness, pngBlob, croppedBuffer, rgbaBuffer, width: actualWidth, height: actualHeight };

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
            const { fourCC } = header;
            const bytesPerPixel = { 'DIB ': 3, 'RGB ': 3, 'Y800': 1, 'YUY2': 2, 'UYVY': 2, 'RGBA': 4 }[fourCC] || 3;
            const expectedSize = width * height * bytesPerPixel;
            if (frameBuffer.byteLength !== expectedSize) {
                console.warn(`detectObjectBounds: AVI buffer size mismatch: got ${frameBuffer.byteLength}, expected ${expectedSize} (${width}x${height}, ${fourCC})`);
                return { canCrop: false, reason: 'buffer-mismatch' };
            }
            const aviDataType = { 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[fourCC];
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));
            grayMat = new _cv.Mat();
            if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
            } else if (fourCC === 'RGBA') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
            } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
            } else {
                rawMat.copyTo(grayMat);
            }
        }

        // Apply Gaussian blur to reduce noise
        blurred = new _cv.Mat();
        // Note: cv.Size() returns a plain JS object {width, height}, not a WASM object, so no .delete() needed
        _cv.GaussianBlur(grayMat, blurred, new _cv.Size(5, 5), 0);

        // Use a low threshold to catch faint features like Saturn's rings
        // Otsu often sets threshold too high for faint details
        // Using ~5% of max (threshold 12-15) catches rings while ignoring noise
        binary = new _cv.Mat();
        _cv.threshold(blurred, binary, 12, 255, _cv.THRESH_BINARY);

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

        // Use low threshold to catch faint features
        binary = new _cv.Mat();
        _cv.threshold(blurred, binary, 12, 255, _cv.THRESH_BINARY);

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
async function analyzeAndCropPng(pngData, cropRegion, frameIndex, includeRgba) {
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
        if (bounds.reason === 'cut-off') {
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

        // Create PNG blob from (cropped) RGBA data
        const outputCanvas = new OffscreenCanvas(actualWidth, actualHeight);
        const outputCtx = outputCanvas.getContext('2d');
        const outputImageData = new ImageData(new Uint8ClampedArray(rawMat.data), actualWidth, actualHeight);
        outputCtx.putImageData(outputImageData, 0, 0);
        const pngBlob = await outputCanvas.convertToBlob({ type: 'image/png' });

        // Get RGBA buffer if needed
        let rgbaBuffer = null;
        if (includeRgba) {
            rgbaBuffer = new Uint8ClampedArray(rawMat.data).buffer;
        }

        rawMat.delete();
        grayMat.delete();

        return { sharpness, pngBlob, rgbaBuffer, width: actualWidth, height: actualHeight, circularity: bounds.circularity || 0 };

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
 * Stack frames with local alignment using Alignment Points (APs)
 */
async function stackFramesLocally(frames) {
    // Track resources for cleanup on error
    let refMat = null, refGray = null, mapX = null, mapY = null;

    try {
        self.postMessage({ type: 'stack-progress', stage: 'Preparing frames...', progress: 0 });

        // Filter frames that have valid rgbaBuffer and sharpness
        const validFrames = frames.filter(f => f.rgbaBuffer && f.width && f.height && f.sharpness > 0);

        if (validFrames.length === 0) {
            throw new Error('No valid frames with RGBA data for stacking');
        }

        const { width, height } = validFrames[0];
        const frameCount = validFrames.length;

        // Validate all frames have consistent dimensions
        for (let i = 0; i < validFrames.length; i++) {
            const f = validFrames[i];
            if (f.width !== width || f.height !== height) {
                throw new Error(`Frame ${i} has dimensions ${f.width}x${f.height}, expected ${width}x${height}`);
            }
            const expectedBytes = f.width * f.height * 4;
            if (!f.rgbaBuffer || f.rgbaBuffer.byteLength !== expectedBytes) {
                throw new Error(`Frame ${i} buffer mismatch: got ${f.rgbaBuffer?.byteLength || 0} bytes, expected ${expectedBytes} (${f.width}x${f.height})`);
            }
        }

        console.log(`Stacking ${frameCount} frames (${width}x${height}) with local alignment`);

        // Sort frames by sharpness and use best as reference
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);
        const referenceFrame = sortedFrames[0];
        const refData = new Uint8ClampedArray(referenceFrame.rgbaBuffer);
        const refSubPixelOffset = referenceFrame.subPixelOffset || { x: 0, y: 0 };
        console.log(`Reference frame: sharpness ${referenceFrame.sharpness.toFixed(2)}, subPixelOffset=(${refSubPixelOffset.x.toFixed(3)}, ${refSubPixelOffset.y.toFixed(3)})`);

        // === Create Alignment Points Grid ===
        const { alignmentPoints, patchSize, searchRadius } = createAPGrid(width, height);
        console.log(`Created ${alignmentPoints.length} alignment points (${patchSize}px patches, ${searchRadius}px search)`);

        // === Find local shifts for each frame at each AP ===
        const refIndex = validFrames.findIndex(f => f === referenceFrame);
        self.postMessage({ type: 'stack-progress', stage: `Aligning frame 1/${frameCount}...`, progress: 5 });
        const frameShifts = []; // frameShifts[frameIdx][apIdx] = {dx, dy, quality}

        // Create reference Mat once (reused for all frames)
        if (!referenceFrame.rgbaBuffer || referenceFrame.rgbaBuffer.byteLength === 0) {
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

        for (let f = 0; f < frameCount; f++) {
            const frame = validFrames[f];

            // Skip alignment for reference frame - it has zero shift by definition
            if (f === refIndex) {
                const zeroShifts = activeAPs.map(() => ({ dx: 0, dy: 0, quality: 1 }));
                frameShifts.push(zeroShifts);
                continue;
            }

            // Validate frame data
            if (!frame.rgbaBuffer || frame.rgbaBuffer.byteLength === 0) {
                console.error(`Frame ${f}: Invalid or detached rgbaBuffer`);
                throw new Error(`Frame ${f} has invalid RGBA buffer (byteLength: ${frame.rgbaBuffer?.byteLength || 0})`);
            }

            const expectedSize = width * height * 4;
            if (frame.rgbaBuffer.byteLength !== expectedSize) {
                console.error(`Frame ${f}: Buffer size mismatch. Expected ${expectedSize}, got ${frame.rgbaBuffer.byteLength}`);
                throw new Error(`Frame ${f} buffer size mismatch: expected ${expectedSize}, got ${frame.rgbaBuffer.byteLength}`);
            }

            const frameData = new Uint8ClampedArray(frame.rgbaBuffer);

            // Create frame Mat once per frame
            let frameMat = null, frameGray = null;
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

                const shifts = [];
                for (let a = 0; a < activeAPs.length; a++) {
                    const ap = activeAPs[a];
                    const shift = findLocalShiftFast(refGray, frameGray, width, height, ap, patchSize, searchRadius);
                    shifts.push(shift);
                }
                frameShifts.push(shifts);
            } catch (cvError) {
                const errMsg = typeof cvError === 'number' ? `OpenCV error code: ${cvError}` : (cvError.message || String(cvError));
                console.error(`Frame ${f}: OpenCV error during alignment:`, errMsg);
                throw new Error(`Frame ${f} alignment error: ${errMsg}`);
            } finally {
                // Always clean up Mats
                if (frameGray) try { frameGray.delete(); } catch(e) {}
                if (frameMat) try { frameMat.delete(); } catch(e) {}
            }

            // Update progress every frame
            const progress = 5 + (f / frameCount) * 45;
            self.postMessage({
                type: 'stack-progress',
                stage: `Aligning frame ${f + 1}/${frameCount}...`,
                progress: progress
            });
        }

        // Clean up reference Mats after alignment phase
        if (refGray) { refGray.delete(); refGray = null; }
        if (refMat) { refMat.delete(); refMat = null; }
        console.log('Alignment complete');

        // === Stack with LOCAL de-warping ===
        self.postMessage({ type: 'stack-progress', stage: 'De-warping frames...', progress: 50 });

        // Accumulator for final image (RGB + weight per pixel)
        const accumR = new Float32Array(width * height);
        const accumG = new Float32Array(width * height);
        const accumB = new Float32Array(width * height);
        const accumWeight = new Float32Array(width * height);

        // Normalize sharpness for weighting
        const totalSharpness = validFrames.reduce((sum, f) => sum + f.sharpness, 0);

        // === Brightness normalization (PSS-like, black cutoff = 4) ===
        const blackCutoff = 4;

        // Calculate mean brightness using sparse sampling (every 8th pixel in each direction = 1/64 of pixels)
        function calcMeanBrightness(rgbaBuffer, width, height, blackCutoff) {
            const data = new Uint8ClampedArray(rgbaBuffer);
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

        const refBrightness = calcMeanBrightness(referenceFrame.rgbaBuffer, width, height, blackCutoff);

        // Local de-warping with improved Gaussian weighting to reduce grid artifacts
        const useLocalDewarping = true;

        if (useLocalDewarping) {
            // Create remap matrices once (reused for each frame)
            mapX = new _cv.Mat(height, width, _cv.CV_32FC1);
            mapY = new _cv.Mat(height, width, _cv.CV_32FC1);
        }

        for (let f = 0; f < frameCount; f++) {
            const frame = validFrames[f];

            // Re-validate buffer (should still be valid from alignment phase)
            if (!frame.rgbaBuffer || frame.rgbaBuffer.byteLength === 0) {
                console.error(`Stack frame ${f}: Buffer became invalid`);
                throw new Error(`Frame ${f} buffer invalid during stacking`);
            }

            const frameData = new Uint8ClampedArray(frame.rgbaBuffer);
            const frameWeight = frame.sharpness / totalSharpness * frameCount;

            // Calculate brightness normalization factor for this frame
            const frameBrightness = calcMeanBrightness(frame.rgbaBuffer, width, height, blackCutoff);
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
                    buildDisplacementMaps(mapX, mapY, width, height, activeAPs, shifts, patchSize, globalOffsetX, globalOffsetY);

                    // Apply local de-warping via remap
                    warpedMat = new _cv.Mat();
                    _cv.remap(frameMat, warpedMat, mapX, mapY, _cv.INTER_LINEAR, _cv.BORDER_CONSTANT);

                    // Accumulate warped frame with brightness normalization
                    const warpedData = warpedMat.data;
                    for (let i = 0; i < width * height; i++) {
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

        // === Compute final result ===
        self.postMessage({ type: 'stack-progress', stage: 'Finalizing...', progress: 95 });
        const result = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < width * height; i++) {
            const w = accumWeight[i];
            if (w > 0) {
                result[i * 4 + 0] = Math.round(accumR[i] / w);
                result[i * 4 + 1] = Math.round(accumG[i] / w);
                result[i * 4 + 2] = Math.round(accumB[i] / w);
            } else {
                // Fallback to reference frame if no data
                result[i * 4 + 0] = refData[i * 4 + 0];
                result[i * 4 + 1] = refData[i * 4 + 1];
                result[i * 4 + 2] = refData[i * 4 + 2];
            }
            result[i * 4 + 3] = 255; // Alpha
        }

        // Create ImageData and convert to blob
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const imageData = new ImageData(result, width, height);
        ctx.putImageData(imageData, 0, 0);

        const blob = await canvas.convertToBlob({ type: 'image/png' });
        console.log(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);

        self.postMessage({ type: 'stack-progress', stage: 'Stacking complete', progress: 100 });
        return { blob, width, height };

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
 */
function createAPGrid(width, height) {
    // PSS default: alignment box width = 20px
    const patchSize = 20;
    // PSS default: max alignment search width = 8px
    const searchRadius = 8;
    // Spacing with 50% overlap for denser coverage (like PSS)
    const spacing = Math.floor(patchSize / 2); // 10px spacing = 50% overlap

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
function buildDisplacementMaps(mapX, mapY, width, height, alignmentPoints, shifts, patchSize, globalOffsetX = 0, globalOffsetY = 0) {
    const mapXData = mapX.data32F;
    const mapYData = mapY.data32F;

    // Larger influence radius for smoother blending (was patchSize * 2)
    const influenceRadius = patchSize * 4;
    // Gaussian sigma - controls falloff smoothness
    const sigma = patchSize * 1.5;
    const sigma2 = sigma * sigma * 2;

    // Minimum quality threshold - ignore poor matches
    const minQuality = 0.3;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;

            // Interpolate shift from nearby APs using Gaussian weighting
            let totalWeight = 0;
            let weightedDx = 0;
            let weightedDy = 0;

            for (let i = 0; i < alignmentPoints.length; i++) {
                const ap = alignmentPoints[i];
                const shift = shifts[i];

                // Skip low-quality matches - they add noise
                if (shift.quality < minQuality) continue;

                const dx = x - ap.x;
                const dy = y - ap.y;
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

            // remap uses source coordinates, so we ADD the shift
            // Global offset aligns frame to reference (compensates for per-frame crop centering)
            // Local shift (from APs) corrects for atmospheric wobble
            if (totalWeight > 0) {
                mapXData[idx] = x + globalOffsetX + weightedDx / totalWeight;
                mapYData[idx] = y + globalOffsetY + weightedDy / totalWeight;
            } else {
                // No nearby APs - apply global offset only
                mapXData[idx] = x + globalOffsetX;
                mapYData[idx] = y + globalOffsetY;
            }
        }
    }
}

/**
 * Fast version that takes pre-converted grayscale Mats
 */
function findLocalShiftFast(refGray, frameGray, width, height, ap, patchSize, searchRadius) {
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

    let templateMat = null, searchMat = null, resultMat = null;

    try {
        // Extract template from reference (the patch we're looking for)
        templateMat = refGray.roi(new _cv.Rect(templateX, templateY, patchSize, patchSize));

        // Extract search region from frame (where we look for the template)
        searchMat = frameGray.roi(new _cv.Rect(searchX, searchY, searchSize, searchSize));

        // Run template matching
        resultMat = new _cv.Mat();
        _cv.matchTemplate(searchMat, templateMat, resultMat, _cv.TM_CCOEFF_NORMED);

        // Find best match location
        const minMax = _cv.minMaxLoc(resultMat);
        const bestLoc = minMax.maxLoc;
        const quality = minMax.maxVal;

        // Calculate shift
        const dx = bestLoc.x - searchRadius;
        const dy = bestLoc.y - searchRadius;

        return { dx, dy, quality: Math.max(0, quality) };

    } catch (err) {
        return { dx: 0, dy: 0, quality: 0 };
    } finally {
        // IMPORTANT: roi() Mats MUST be deleted in OpenCV.js
        if (templateMat) try { templateMat.delete(); } catch(e) {}
        if (searchMat) try { searchMat.delete(); } catch(e) {}
        if (resultMat) try { resultMat.delete(); } catch(e) {}
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


