// public/unified_analyze_worker.js
console.log('unified_analyze_worker.js loaded (v9 - callback-based OpenCV init)');

// Use _cv to avoid conflicts with global 'cv' from opencv-bindings
let _cv = null;
let isCvReady = false;
const messageQueue = [];

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

        // Analyze with optional cropping - detects object center per-frame and applies fixed crop size
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

            // First detect where the object is in this specific frame
            let bounds;
            try {
                bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            } catch (boundsError) {
                // Fall back to no cropping
                bounds = { canCrop: false, reason: 'detection-error' };
            }

            let actualCropRegion = null;
            if (bounds.canCrop && cropRegion && cropRegion.size) {
                // Skip cropping if crop size exceeds frame dimensions
                if (cropRegion.size <= header.width && cropRegion.size <= header.height) {
                    // Calculate crop region centered on the detected object
                    const centerX = bounds.x + bounds.size / 2;
                    const centerY = bounds.y + bounds.size / 2;
                    const halfSize = cropRegion.size / 2;

                    let cropX = Math.floor(centerX - halfSize);
                    let cropY = Math.floor(centerY - halfSize);

                    // Ensure even pixel alignment for Bayer pattern preservation
                    cropX = cropX & ~1; // Round down to even
                    cropY = cropY & ~1;

                    // Ensure crop stays within frame bounds (keeping even alignment)
                    cropX = Math.max(0, Math.min(cropX, (header.width - cropRegion.size) & ~1));
                    cropY = Math.max(0, Math.min(cropY, (header.height - cropRegion.size) & ~1));

                    actualCropRegion = { x: cropX, y: cropY, size: cropRegion.size };
                }
            }

            // If we're in crop mode but couldn't crop this frame, skip it entirely
            if (cropRegion && !actualCropRegion) {
                self.postMessage({ skipped: true, reason: bounds.reason || 'crop-failed', index });
                return;
            }

            const includeRgba = e.data.clientSideStacking === true;
            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, actualCropRegion, index, includeRgba);

            const response = {
                sharpness: result.sharpness,
                pngBlob: result.pngBlob,
                croppedBuffer: result.croppedBuffer,
                index
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

        let sharpness, pngBlob;

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

            // Return with rgbaBuffer if client-side stacking is enabled
            if (includeRgba && result.rgbaBuffer) {
                self.postMessage({
                    sharpness, pngBlob, index,
                    rgbaBuffer: result.rgbaBuffer,
                    width: result.width,
                    height: result.height
                }, [result.rgbaBuffer]);
                return;
            }

        } else {
            throw new Error('Unknown analysis type');
        }

        self.postMessage({ sharpness, pngBlob, index });

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
    let rawMat, grayMat, rgbaMat, croppedRawMat;

    try {
        // Log every 100th frame to track progress without flooding console
        if (frameIndex !== undefined && frameIndex % 100 === 0) {
            console.log(`Processing frame ${frameIndex}: ${width}x${height}, crop=${cropRegion ? 'yes' : 'no'}`);
        }

        // --- Step 1: Create initial Mat from raw buffer ---
        if (header.fileId && header.fileId.startsWith('LUCAM-REC')) { // SER file
            const serDataType = pixelDepth > 8 ? _cv.CV_16UC1 : _cv.CV_8UC1;
            const serData = pixelDepth > 8 ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);
            const expectedSize = width * height;
            if (serData.length !== expectedSize) {
                throw new Error(`Buffer size mismatch: got ${serData.length}, expected ${expectedSize} (${width}x${height}, ${pixelDepth}-bit)`);
            }
            rawMat = _cv.matFromArray(height, width, serDataType, serData);

            // Apply cropping if specified
            if (cropRegion) {
                const rect = new _cv.Rect(cropRegion.x, cropRegion.y, cropRegion.size, cropRegion.size);
                croppedRawMat = rawMat.roi(rect).clone();
                rawMat.delete();
                rawMat = croppedRawMat;
            }

            // Convert to 8-bit for processing
            grayMat = new _cv.Mat();
            const alpha = pixelDepth > 8 ? 1/256 : 1;
            rawMat.convertTo(grayMat, _cv.CV_8U, alpha);

        } else { // AVI file (or RGBA from decoded PNG)
            const aviDataType = { 'DIB ': _cv.CV_8UC3, 'RGB ': _cv.CV_8UC3, 'Y800': _cv.CV_8UC1, 'YUY2': _cv.CV_8UC2, 'UYVY': _cv.CV_8UC2, 'RGBA': _cv.CV_8UC4 }[fourCC];
            rawMat = new _cv.Mat(height, width, aviDataType);
            rawMat.data.set(new Uint8Array(frameBuffer));

            // Apply cropping if specified
            if (cropRegion) {
                const rect = new _cv.Rect(cropRegion.x, cropRegion.y, cropRegion.size, cropRegion.size);
                croppedRawMat = rawMat.roi(rect).clone();
                rawMat.delete();
                rawMat = croppedRawMat;
            }

            grayMat = new _cv.Mat();
            // Convert to grayscale for sharpness analysis
            if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_BGR2GRAY);
            } else if (fourCC === 'RGBA') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_RGBA2GRAY);
            } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                _cv.cvtColor(rawMat, grayMat, _cv.COLOR_YUV2GRAY_YUY2);
            } else { // Y800 is already grayscale
                rawMat.copyTo(grayMat);
            }
        }

        // Get actual dimensions (may be cropped)
        const actualWidth = rawMat.cols;
        const actualHeight = rawMat.rows;

        // --- Step 2: Calculate sharpness from the grayscale mat ---
        const sharpness = calculateSharpnessFromMat(grayMat, frameIndex);

        // --- Step 3: Create RGBA Mat for PNG conversion ---
        rgbaMat = new _cv.Mat();
        if (header.fileId && header.fileId.startsWith('LUCAM-REC')) { // SER File
             if (bayerChoice && bayerChoice !== "MONO") {
                // Validate Bayer constant exists
                if (_cv[bayerChoice] === undefined) {
                    throw new Error(`Invalid Bayer pattern: ${bayerChoice} not found in OpenCV. Available: COLOR_BayerBG2BGR, COLOR_BayerGB2BGR, COLOR_BayerRG2BGR, COLOR_BayerGR2BGR`);
                }
                const demosaiced = new _cv.Mat();
                try {
                    _cv.demosaicing(grayMat, demosaiced, _cv[bayerChoice]);
                } catch (demosaicErr) {
                    throw new Error(`Demosaicing failed (${actualWidth}x${actualHeight}, ${bayerChoice}=${_cv[bayerChoice]}): ${demosaicErr.message || demosaicErr}`);
                }
                try {
                    _cv.cvtColor(demosaiced, rgbaMat, _cv.COLOR_RGB2RGBA);
                } catch (cvtErr) {
                    demosaiced.delete();
                    throw new Error(`cvtColor RGB2RGBA failed: ${cvtErr.message || cvtErr}`);
                }
                demosaiced.delete();
            } else {
                try {
                    _cv.cvtColor(grayMat, rgbaMat, _cv.COLOR_GRAY2RGBA);
                } catch (cvtErr) {
                    throw new Error(`cvtColor GRAY2RGBA failed: ${cvtErr.message || cvtErr}`);
                }
            }
        } else { // AVI File (or RGBA from decoded PNG)
            if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_BGR2RGBA);
            } else if (fourCC === 'RGBA') {
                // Already RGBA, just copy
                rawMat.copyTo(rgbaMat);
            } else if (fourCC === 'Y800') {
                 if (bayerChoice && bayerChoice !== "MONO" && _cv[bayerChoice]) {
                    const demosaiced = new _cv.Mat();
                    _cv.demosaicing(rawMat, demosaiced, _cv[bayerChoice]);
                    _cv.cvtColor(demosaiced, rgbaMat, _cv.COLOR_BGR2RGBA);
                    demosaiced.delete();
                } else {
                    _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_GRAY2RGBA);
                }
            } else if (fourCC === 'YUY2' || fourCC === 'UYVY'){
                _cv.cvtColor(rawMat, rgbaMat, _cv.COLOR_YUV2RGBA_YUY2);
            }
        }

        // --- Step 4: Create PNG Blob ---
        let pngBlob;
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
            throw new Error(`PNG creation failed (${actualWidth}x${actualHeight}): ${pngErr.message || pngErr}`);
        }

        // --- Step 5: Get cropped raw buffer for SER export (if cropping was applied) ---
        let croppedBuffer = null;
        if (cropRegion && header.fileId && header.fileId.startsWith('LUCAM-REC')) {
            // Extract raw data from cropped mat for SER export
            const bytesPerPixel = pixelDepth > 8 ? 2 : 1;
            croppedBuffer = new ArrayBuffer(actualWidth * actualHeight * bytesPerPixel);
            if (pixelDepth > 8) {
                new Uint16Array(croppedBuffer).set(new Uint16Array(rawMat.data.buffer, rawMat.data.byteOffset, actualWidth * actualHeight));
            } else {
                new Uint8Array(croppedBuffer).set(new Uint8Array(rawMat.data.buffer, rawMat.data.byteOffset, actualWidth * actualHeight));
            }
        }

        // --- Step 6: Get RGBA buffer for client-side stacking (copy before mat is deleted) ---
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


function calculateSharpnessFromMat(grayMat, frameIndex) {
    // Use Tenengrad (Sobel-based) sharpness metric - more robust than Laplacian variance
    // Tenengrad = sum of squared Sobel gradients, normalized by image size

    if (!_cv || !_cv.Mat) {
        console.error('OpenCV not ready in calculateSharpnessFromMat');
        return 0;
    }

    const sobelX = new _cv.Mat();
    const sobelY = new _cv.Mat();

    // Calculate Sobel gradients
    _cv.Sobel(grayMat, sobelX, _cv.CV_64F, 1, 0, 3); // dx
    _cv.Sobel(grayMat, sobelY, _cv.CV_64F, 0, 1, 3); // dy

    // Square the gradients
    const sobelX2 = new _cv.Mat();
    const sobelY2 = new _cv.Mat();
    _cv.multiply(sobelX, sobelX, sobelX2);
    _cv.multiply(sobelY, sobelY, sobelY2);

    // Sum of squared gradients
    const gradientMagnitude = new _cv.Mat();
    _cv.add(sobelX2, sobelY2, gradientMagnitude);

    // Calculate mean (Tenengrad normalized by pixel count)
    const meanVal = _cv.mean(gradientMagnitude);
    const sharpness = meanVal[0]; // Mean of gradient magnitude squared

    // Log first frame only for debugging
    if (frameIndex === 0) {
        console.log(`Frame analysis: ${grayMat.cols}x${grayMat.rows}, Tenengrad sharpness=${sharpness.toFixed(2)}`);
    }

    sobelX.delete();
    sobelY.delete();
    sobelX2.delete();
    sobelY2.delete();
    gradientMagnitude.delete();

    return sharpness;
}

// Detect bounding box of bright objects (planet + moons) in frame
async function detectObjectBounds(frameBuffer, header, bayerChoice) {
    const { width, height, pixelDepth } = header;
    let grayMat = null;
    let rawMat = null;

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
        const blurred = new _cv.Mat();
        _cv.GaussianBlur(grayMat, blurred, new _cv.Size(5, 5), 0);

        // Use a low threshold to catch faint features like Saturn's rings
        // Otsu often sets threshold too high for faint details
        // Using ~5% of max (threshold 12-15) catches rings while ignoring noise
        const binary = new _cv.Mat();
        _cv.threshold(blurred, binary, 12, 255, _cv.THRESH_BINARY);

        // Find contours
        const contours = new _cv.MatVector();
        const hierarchy = new _cv.Mat();
        _cv.findContours(binary, contours, hierarchy, _cv.RETR_EXTERNAL, _cv.CHAIN_APPROX_SIMPLE);

        // Collect all bounding boxes
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasObjects = false;
        const minContourArea = (width * height) * 0.0001; // Ignore tiny noise

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
        }

        // Cleanup
        blurred.delete();
        binary.delete();
        contours.delete();
        hierarchy.delete();
        if (rawMat) rawMat.delete();
        if (grayMat) grayMat.delete();

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
        // Use 50% padding to accommodate Saturn's rings and other extended features
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;
        const marginX = boxWidth * 0.5;
        const marginY = boxHeight * 0.5;

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
            originalWidth: width,
            originalHeight: height
        };

    } catch (error) {
        if (rawMat) try { rawMat.delete(); } catch(e) {}
        if (grayMat) try { grayMat.delete(); } catch(e) {}
        // OpenCV errors during bounds detection are non-fatal - frame will still be processed
        // Only log first few to avoid spam
        if (!self.boundsErrorCount) self.boundsErrorCount = 0;
        if (self.boundsErrorCount < 3) {
            const errorMsg = typeof error === 'number' ? `OpenCV error code: ${error}` : (error.message || String(error));
            console.warn('Bounds detection failed (non-fatal):', errorMsg);
            self.boundsErrorCount++;
        }
        return { canCrop: false, reason: 'error' };
    }
}

// =====================================================
// FRAME STACKING WITH LOCAL ALIGNMENT
// =====================================================

/**
 * Stack frames with local alignment using Alignment Points (APs)
 */
async function stackFramesLocally(frames) {
    self.postMessage({ type: 'stack-progress', stage: 'Preparing frames...', progress: 0 });

    // Filter frames that have valid rgbaBuffer and sharpness
    const validFrames = frames.filter(f => f.rgbaBuffer && f.width && f.height && f.sharpness > 0);

    if (validFrames.length === 0) {
        throw new Error('No valid frames with RGBA data for stacking');
    }

    const { width, height } = validFrames[0];
    const frameCount = validFrames.length;

    console.log(`Stacking ${frameCount} frames (${width}x${height}) with local alignment`);

    // Sort frames by sharpness and use best as reference
    const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);
    const referenceFrame = sortedFrames[0];
    const refData = new Uint8ClampedArray(referenceFrame.rgbaBuffer);
    console.log(`Reference frame: sharpness ${referenceFrame.sharpness.toFixed(2)}`);

    // === Create Alignment Points Grid ===
    const { alignmentPoints, patchSize, searchRadius } = createAPGrid(width, height);
    console.log(`Created ${alignmentPoints.length} alignment points (${patchSize}px patches, ${searchRadius}px search)`);

    // === Find local shifts for each frame at each AP ===
    console.log(`Finding alignments for ${frameCount} frames with ${alignmentPoints.length} APs each...`);
    self.postMessage({ type: 'stack-progress', stage: `Aligning frame 1/${frameCount}...`, progress: 5 });
    const frameShifts = []; // frameShifts[frameIdx][apIdx] = {dx, dy, quality}

    // Create reference Mat once (reused for all frames)
    const refMat = new _cv.Mat(height, width, _cv.CV_8UC4);
    refMat.data.set(refData);
    const refGray = new _cv.Mat();
    _cv.cvtColor(refMat, refGray, _cv.COLOR_RGBA2GRAY);

    for (let f = 0; f < frameCount; f++) {
        const frame = validFrames[f];

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
            frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
            frameMat.data.set(frameData);
            frameGray = new _cv.Mat();
            _cv.cvtColor(frameMat, frameGray, _cv.COLOR_RGBA2GRAY);

            const shifts = [];
            for (let a = 0; a < alignmentPoints.length; a++) {
                const ap = alignmentPoints[a];
                const shift = findLocalShiftFast(refGray, frameGray, width, height, ap, patchSize, searchRadius);
                shifts.push(shift);
            }
            frameShifts.push(shifts);
        } catch (cvError) {
            console.error(`Frame ${f}: OpenCV error during alignment:`, cvError);
            throw new Error(`Frame ${f} OpenCV error: ${cvError.message || cvError}`);
        } finally {
            // Always clean up Mats
            if (frameGray) frameGray.delete();
            if (frameMat) frameMat.delete();
        }

        // Update progress every frame
        const progress = 5 + (f / frameCount) * 45;
        self.postMessage({
            type: 'stack-progress',
            stage: `Aligning frame ${f + 1}/${frameCount}...`,
            progress: progress
        });
    }

    refGray.delete();
    refMat.delete();
    console.log('Alignment complete');

    // === Stack with LOCAL de-warping (true de-wobble) ===
    self.postMessage({ type: 'stack-progress', stage: 'De-warping frames...', progress: 50 });

    // Accumulator for final image (RGB + weight per pixel)
    const accumR = new Float32Array(width * height);
    const accumG = new Float32Array(width * height);
    const accumB = new Float32Array(width * height);
    const accumWeight = new Float32Array(width * height);

    // Normalize sharpness for weighting
    const totalSharpness = validFrames.reduce((sum, f) => sum + f.sharpness, 0);

    // Create remap matrices once (reused for each frame)
    const mapX = new _cv.Mat(height, width, _cv.CV_32FC1);
    const mapY = new _cv.Mat(height, width, _cv.CV_32FC1);

    for (let f = 0; f < frameCount; f++) {
        const frame = validFrames[f];

        // Re-validate buffer (should still be valid from alignment phase)
        if (!frame.rgbaBuffer || frame.rgbaBuffer.byteLength === 0) {
            console.error(`De-warp frame ${f}: Buffer became invalid`);
            throw new Error(`Frame ${f} buffer invalid during de-warping`);
        }

        const frameData = new Uint8ClampedArray(frame.rgbaBuffer);
        const frameWeight = frame.sharpness / totalSharpness * frameCount;
        const shifts = frameShifts[f];

        // Build displacement maps by interpolating AP shifts
        buildDisplacementMaps(mapX, mapY, width, height, alignmentPoints, shifts, patchSize);

        // Create frame Mat and apply remap (de-warp)
        let frameMat, warpedMat;
        try {
            frameMat = new _cv.Mat(height, width, _cv.CV_8UC4);
            frameMat.data.set(frameData);

            warpedMat = new _cv.Mat();
            _cv.remap(frameMat, warpedMat, mapX, mapY, _cv.INTER_LINEAR, _cv.BORDER_CONSTANT);
        } catch (cvError) {
            console.error(`De-warp frame ${f}: OpenCV error:`, cvError);
            throw new Error(`Frame ${f} de-warp OpenCV error: ${cvError.message || cvError}`);
        }

        // Accumulate warped frame
        const warpedData = warpedMat.data;
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * 4;
            // Skip black pixels (border from remap)
            if (warpedData[srcIdx] === 0 && warpedData[srcIdx + 1] === 0 && warpedData[srcIdx + 2] === 0) {
                continue;
            }
            accumR[i] += warpedData[srcIdx] * frameWeight;
            accumG[i] += warpedData[srcIdx + 1] * frameWeight;
            accumB[i] += warpedData[srcIdx + 2] * frameWeight;
            accumWeight[i] += frameWeight;
        }

        frameMat.delete();
        warpedMat.delete();

        // Update progress every frame
        self.postMessage({
            type: 'stack-progress',
            stage: `De-warping frame ${f + 1}/${frameCount}...`,
            progress: 50 + (f / frameCount) * 45 // 50-95%
        });
    }

    mapX.delete();
    mapY.delete();
    console.log('De-warping complete');

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
}

/**
 * Create a grid of alignment points
 * Optimized: fewer points, smaller search radius for speed
 */
function createAPGrid(width, height) {
    // Larger patches = fewer APs = faster
    const patchSize = Math.max(48, Math.min(96, Math.floor(Math.min(width, height) / 4)));
    // Smaller search radius - atmospheric wobble is usually only a few pixels
    const searchRadius = Math.min(16, Math.floor(patchSize / 4));
    // Larger spacing = fewer APs
    const spacing = Math.floor(patchSize * 0.8);

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
 * Build displacement maps for cv.remap by interpolating AP shifts
 * This creates a smooth warp field from sparse alignment point measurements
 */
function buildDisplacementMaps(mapX, mapY, width, height, alignmentPoints, shifts, patchSize) {
    const mapXData = mapX.data32F;
    const mapYData = mapY.data32F;
    const influenceRadius = patchSize * 2; // How far each AP influences

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;

            // Interpolate shift from nearby APs using inverse distance weighting
            let totalWeight = 0;
            let weightedDx = 0;
            let weightedDy = 0;

            for (let i = 0; i < alignmentPoints.length; i++) {
                const ap = alignmentPoints[i];
                const shift = shifts[i];
                const dist = Math.sqrt((x - ap.x) ** 2 + (y - ap.y) ** 2);

                if (dist < influenceRadius) {
                    // Inverse distance weighting with quality factor
                    const distWeight = 1 / (1 + (dist / patchSize) ** 2);
                    const weight = distWeight * (0.5 + 0.5 * shift.quality);

                    weightedDx += shift.dx * weight;
                    weightedDy += shift.dy * weight;
                    totalWeight += weight;
                }
            }

            // remap uses source coordinates, so we ADD the shift
            if (totalWeight > 0) {
                mapXData[idx] = x + weightedDx / totalWeight;
                mapYData[idx] = y + weightedDy / totalWeight;
            } else {
                // No nearby APs - identity mapping
                mapXData[idx] = x;
                mapYData[idx] = y;
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
        const templateGray = new _cv.Mat();
        const searchGray = new _cv.Mat();
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
        if (templateMat) try { templateMat.delete(); } catch(e) {}
        if (searchMat) try { searchMat.delete(); } catch(e) {}
        if (resultMat) try { resultMat.delete(); } catch(e) {}
        if (refMat) try { refMat.delete(); } catch(e) {}
        if (frameMat) try { frameMat.delete(); } catch(e) {}

        console.warn('matchTemplate failed:', err);
        return { dx: 0, dy: 0, quality: 0 };
    }
}

