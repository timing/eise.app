// public/unified_analyze_worker.js
console.log('unified_analyze_worker.js loaded (v2 - with detailed error handling)');

// Use _cv to avoid conflicts with global 'cv' from opencv-bindings
let _cv = null;
let isCvReady = false;
const messageQueue = [];

// Load OpenCV and signal readiness
self.importScripts('https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js');

self.addEventListener('message', (e) => {
    if (e.data.type === 'init') {
        if (!self.cv) {
            console.error("Worker: self.cv is not available after importScripts. OpenCV might not have loaded correctly.");
            self.postMessage({ type: 'error', message: 'OpenCV failed to load.' });
            return;
        }
        _cv = self.cv; // Assign the global cv to our local _cv reference
        isCvReady = true;
        console.log('Worker: OpenCV loaded and initialized.');
        self.postMessage({ type: 'ready' });

        // Process any queued messages that arrived before init was complete
        while (messageQueue.length > 0) {
            handleMessage(messageQueue.shift());
        }
    } else {
        // If cv is not ready, queue the message.
        // If _cv is null, it implies init hasn't happened successfully.
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

            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, actualCropRegion, index);
            self.postMessage({ sharpness: result.sharpness, pngBlob: result.pngBlob, croppedBuffer: result.croppedBuffer, index });
            return;
        }

        let sharpness, pngBlob;

        if (type === 'ffmpeg') {
            const { analyze } = e.data;
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
        } else if (type === 'ser' || type === 'avi') {
            const header = type === 'ser' ? e.data.header : e.data.aviHeader;
            const { frameBuffer, bayerChoice } = e.data;

            // Check for cut-off even in non-crop mode
            const bounds = await detectObjectBounds(frameBuffer, header, bayerChoice);
            if (bounds.reason === 'cut-off' || bounds.reason === 'touches-edge') {
                self.postMessage({ skipped: true, reason: 'cut-off', index });
                return;
            }

            const result = await processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, null, index);
            sharpness = result.sharpness;
            pngBlob = result.pngBlob;

        } else {
            throw new Error('Unknown analysis type');
        }

        self.postMessage({ sharpness, pngBlob, index });

    } catch (error) {
        const errorMsg = error.message || String(error);
        // Only log first error per worker to avoid console flooding
        if (!self.errorLogged) {
            console.error(`Error in worker for index ${index}:`, errorMsg, error);
            if (error.stack) console.error('Stack:', error.stack);
            self.errorLogged = true;
        }
        // Include more context for debugging
        const debugInfo = `${errorMsg} (type: ${e.data.type}, size: ${e.data.frameBuffer?.byteLength || 'N/A'})`;
        self.postMessage({ error: debugInfo, index: index });
    }
}

async function processRawFrameWithOpenCV(frameBuffer, header, bayerChoice, cropRegion = null, frameIndex = undefined) {
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

        return { sharpness, pngBlob, croppedBuffer };

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
        if (rawMat) rawMat.delete();
        if (grayMat) grayMat.delete();
        console.error('Error detecting bounds:', error);
        return { canCrop: false, reason: 'error', message: error.message };
    }
}
