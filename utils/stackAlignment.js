/**
 * stackAlignment.js - Alignment transforms for batch stacked images
 *
 * Aligns multiple stacked images for wobble-free rotation animations.
 * Analyzes each stacked image to detect centroid, tilt angle, and size,
 * then applies transforms to align all images to a reference frame.
 *
 * Uses WebGPU for high-quality bicubic interpolation when available.
 */

// WebGPU worker for alignment transforms
let gpuWorker = null;
let gpuWorkerReady = false;
let requestIdCounter = 0;
const pendingRequests = new Map();

async function getGpuWorker() {
    if (gpuWorker && gpuWorkerReady) return gpuWorker;

    if (!gpuWorker) {
        try {
            gpuWorker = new Worker('/webgpu_postprocessor_worker.js');

            gpuWorker.onmessage = (e) => {
                const { type, requestId, result, error } = e.data;

                if (type === 'ready') {
                    gpuWorkerReady = true;
                    console.log('[Alignment] GPU worker ready');
                    return;
                }

                if (type === 'init-error') {
                    console.warn('[Alignment] GPU worker init failed:', error);
                    gpuWorkerReady = false;
                    return;
                }

                const pending = pendingRequests.get(requestId);
                if (!pending) return;
                pendingRequests.delete(requestId);

                if (type === 'transform-result') {
                    pending.resolve(result);
                } else if (type === 'transform-error') {
                    pending.reject(new Error(error));
                }
            };

            gpuWorker.postMessage({ type: 'init' });

            // Wait for ready
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('GPU worker init timeout')), 5000);
                const checkReady = setInterval(() => {
                    if (gpuWorkerReady) {
                        clearTimeout(timeout);
                        clearInterval(checkReady);
                        resolve();
                    }
                }, 10);
            });
        } catch (e) {
            console.warn('[Alignment] WebGPU worker not available:', e);
            gpuWorker = null;
            gpuWorkerReady = false;
            return null;
        }
    }

    return gpuWorker;
}

async function applyTransformViaWorker(inputData, width, height, transform, options) {
    const worker = await getGpuWorker();
    if (!worker) return null;

    const requestId = ++requestIdCounter;

    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });

        worker.postMessage({
            type: 'apply-transform',
            requestId,
            inputData,
            width,
            height,
            transform,
            options
        }, [inputData.buffer]);
    });
}

/**
 * Analyze a stacked image to extract alignment parameters
 * Uses image moments for centroid, orientation, and size detection
 *
 * @param {Float32Array} float32Data - RGBA pixel data (0-1 range)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} threshold - Brightness threshold for planet detection (default 0.05)
 * @returns {Object} { centroid: {x, y}, tiltAngle, radius, area }
 */
export function analyzeStackedImage(float32Data, width, height, threshold = 0.05) {
    // Compute image moments for bright pixels (planet)
    let m00 = 0;  // Area (zeroth moment)
    let m10 = 0;  // First moment X
    let m01 = 0;  // First moment Y
    let m20 = 0;  // Second moment XX
    let m02 = 0;  // Second moment YY
    let m11 = 0;  // Second moment XY

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = float32Data[idx];
            const g = float32Data[idx + 1];
            const b = float32Data[idx + 2];

            // Luminance as weight
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            if (lum > threshold) {
                const w = lum;  // Use luminance as weight
                m00 += w;
                m10 += x * w;
                m01 += y * w;
                m20 += x * x * w;
                m02 += y * y * w;
                m11 += x * y * w;
            }
        }
    }

    if (m00 <= 0) {
        // No bright pixels found
        return {
            centroid: { x: width / 2, y: height / 2 },
            tiltAngle: 0,
            radius: Math.min(width, height) / 4,
            area: 0
        };
    }

    // Centroid
    const cx = m10 / m00;
    const cy = m01 / m00;

    // Central moments (translation invariant)
    const mu20 = m20 / m00 - cx * cx;
    const mu02 = m02 / m00 - cy * cy;
    const mu11 = m11 / m00 - cx * cy;

    // Tilt angle from principal axis
    const tiltAngle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);

    // Equivalent radius from second moments
    // For a disk, mu20 = mu02 = r^2/4, so r = 2*sqrt(mu20)
    const avgMoment = (mu20 + mu02) / 2;
    const radius = 2 * Math.sqrt(Math.max(0, avgMoment));

    return {
        centroid: { x: cx, y: cy },
        tiltAngle,
        radius,
        area: m00
    };
}

/**
 * Calculate alignment transforms for a batch of stacked results
 *
 * @param {Array} analysisResults - Array of analysis results from analyzeStackedImage
 * @param {Object} options - Alignment options
 *   - alignCenter: boolean - Align centers (default: true)
 *   - alignTilt: boolean - Correct tilt angle (default: true)
 *   - alignScale: boolean - Match sizes (default: true)
 *   - referenceIndex: number - Index of reference frame (default: 0)
 * @returns {Array} Array of transform objects { dx, dy, dTheta, scale }
 */
export function calculateAlignmentTransforms(analysisResults, options = {}) {
    const {
        alignCenter = true,
        alignTilt = true,
        alignScale = true,
        referenceIndex = null  // null = use middle frame
    } = options;

    if (analysisResults.length === 0) return [];

    // Use middle frame as reference by default
    const refIdx = referenceIndex !== null
        ? Math.min(referenceIndex, analysisResults.length - 1)
        : Math.floor(analysisResults.length / 2);

    console.log(`[Alignment] Using frame ${refIdx + 1}/${analysisResults.length} as reference (chained)`);

    // Initialize transforms array
    const transforms = new Array(analysisResults.length);

    // Reference frame has no transform
    transforms[refIdx] = { dx: 0, dy: 0, dTheta: 0, scale: 1 };

    // Helper to compute pairwise transform from frame A to frame B
    function pairwiseTransform(fromResult, toResult) {
        const scale = (alignScale && fromResult.radius > 0 && toResult.radius > 0)
            ? toResult.radius / fromResult.radius
            : 1;
        const dx = alignCenter ? toResult.centroid.x - fromResult.centroid.x * scale : 0;
        const dy = alignCenter ? toResult.centroid.y - fromResult.centroid.y * scale : 0;
        const dTheta = alignTilt ? toResult.tiltAngle - fromResult.tiltAngle : 0;
        return { dx, dy, dTheta, scale };
    }

    // Helper to accumulate transforms: apply t1 then t2
    function accumulateTransform(t1, t2) {
        // Combined scale
        const scale = t1.scale * t2.scale;

        // Combined rotation
        const dTheta = t1.dTheta + t2.dTheta;

        // t1's translation, then rotated/scaled by t2, plus t2's translation
        const cos = Math.cos(t2.dTheta);
        const sin = Math.sin(t2.dTheta);
        const dx = (t1.dx * cos - t1.dy * sin) * t2.scale + t2.dx;
        const dy = (t1.dx * sin + t1.dy * cos) * t2.scale + t2.dy;

        return { dx, dy, dTheta, scale };
    }

    // Chain forward: refIdx+1, refIdx+2, ... (each aligns to previous)
    for (let i = refIdx + 1; i < analysisResults.length; i++) {
        const pairwise = pairwiseTransform(analysisResults[i], analysisResults[i - 1]);
        transforms[i] = accumulateTransform(pairwise, transforms[i - 1]);
    }

    // Chain backward: refIdx-1, refIdx-2, ... (each aligns to next)
    for (let i = refIdx - 1; i >= 0; i--) {
        const pairwise = pairwiseTransform(analysisResults[i], analysisResults[i + 1]);
        transforms[i] = accumulateTransform(pairwise, transforms[i + 1]);
    }

    return transforms;
}

/**
 * Apply alignment transform to an image using WebGPU (bicubic interpolation)
 *
 * @param {Object} result - Stacking result with float32Data, width, height
 * @param {Object} transform - Transform { dx, dy, dTheta, scale }
 * @param {Object} options - Output options
 *   - outputWidth: number - Output width (default: result.width)
 *   - outputHeight: number - Output height (default: result.height)
 * @returns {Promise<{blob: Blob, float32Data: Float32Array, width: number, height: number}>}
 */
export async function applyAlignmentTransform(result, transform, options = {}) {
    const {
        outputWidth = result.width,
        outputHeight = result.height
    } = options;

    const { dx, dy, dTheta, scale = 1 } = transform;

    // Skip if no transform needed
    const needsTransform = Math.abs(dx) >= 0.5 ||
                           Math.abs(dy) >= 0.5 ||
                           Math.abs(dTheta) >= 0.001 ||
                           Math.abs(scale - 1) >= 0.001;

    if (!needsTransform) {
        return result;
    }

    // Try WebGPU first for high-quality bicubic interpolation
    try {
        // Clone the data since it will be transferred to the worker
        const inputDataCopy = new Float32Array(result.float32Data);
        const transformedData = await applyTransformViaWorker(
            inputDataCopy,
            result.width,
            result.height,
            transform,
            { outputWidth, outputHeight }
        );

        if (transformedData) {
            // Generate blob from transformed data
            const blob = await float32ToBlob(transformedData, outputWidth, outputHeight);

            return {
                blob,
                float32Data: transformedData,
                width: outputWidth,
                height: outputHeight
            };
        }
    } catch (err) {
        console.warn('[Alignment] WebGPU transform failed, falling back to canvas:', err);
    }

    // Fallback to canvas (lower quality)
    return applyAlignmentTransformCanvas(result, transform, options);
}

/**
 * Canvas fallback for alignment transform (lower quality bilinear interpolation)
 */
async function applyAlignmentTransformCanvas(result, transform, options = {}) {
    const {
        outputWidth = result.width,
        outputHeight = result.height
    } = options;

    const { dx, dy, dTheta, scale = 1 } = transform;

    // Create source canvas from float32Data
    const srcCanvas = new OffscreenCanvas(result.width, result.height);
    const srcCtx = srcCanvas.getContext('2d');

    // Convert float32 to uint8 for canvas
    const uint8Data = new Uint8ClampedArray(result.float32Data.length);
    for (let i = 0; i < result.float32Data.length; i++) {
        uint8Data[i] = Math.round(Math.min(1, Math.max(0, result.float32Data[i])) * 255);
    }
    const imageData = new ImageData(uint8Data, result.width, result.height);
    srcCtx.putImageData(imageData, 0, 0);

    // Create output canvas
    const dstCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const dstCtx = dstCanvas.getContext('2d');
    dstCtx.imageSmoothingQuality = 'high';

    // Apply transform: scale, rotate, then translate
    const centerX = outputWidth / 2;
    const centerY = outputHeight / 2;

    dstCtx.save();
    dstCtx.translate(centerX + dx, centerY + dy);
    dstCtx.rotate(dTheta);
    dstCtx.scale(scale, scale);
    dstCtx.drawImage(
        srcCanvas,
        -result.width / 2,
        -result.height / 2
    );
    dstCtx.restore();

    // Extract output data
    const outputImageData = dstCtx.getImageData(0, 0, outputWidth, outputHeight);
    const outputFloat32 = new Float32Array(outputImageData.data.length);
    for (let i = 0; i < outputImageData.data.length; i++) {
        outputFloat32[i] = outputImageData.data[i] / 255;
    }

    // Generate blob
    const blob = await dstCanvas.convertToBlob({ type: 'image/png' });

    return {
        blob,
        float32Data: outputFloat32,
        width: outputWidth,
        height: outputHeight
    };
}

/**
 * Convert Float32Array RGBA data to PNG blob
 */
async function float32ToBlob(float32Data, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const uint8Data = new Uint8ClampedArray(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        uint8Data[i] = Math.round(Math.min(1, Math.max(0, float32Data[i])) * 255);
    }

    const imageData = new ImageData(uint8Data, width, height);
    ctx.putImageData(imageData, 0, 0);

    return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Align all stacked images in a batch
 *
 * @param {Array} stackedResults - Array of stacking results with float32Data, width, height
 * @param {Object} options - Alignment options
 *   - alignCenter: boolean - Align centers (default: true)
 *   - alignTilt: boolean - Correct tilt angle (default: true)
 *   - alignScale: boolean - Match sizes (default: true)
 *   - referenceIndex: number - Index of reference frame (default: 0)
 *   - threshold: number - Brightness threshold for detection (default: 0.05)
 *   - onProgress: function - Progress callback (index, total, message)
 * @returns {Promise<Array>} Aligned results
 */
export async function alignStackedImages(stackedResults, options = {}) {
    const { threshold = 0.05, onProgress = null } = options;

    if (stackedResults.length <= 1) {
        return stackedResults;
    }

    // Step 1: Analyze all images
    if (onProgress) onProgress(0, stackedResults.length, 'Analyzing images...');

    const analysisResults = stackedResults.map((result, i) => {
        const analysis = analyzeStackedImage(
            result.float32Data,
            result.width,
            result.height,
            threshold
        );
        if (onProgress) onProgress(i + 1, stackedResults.length, `Analyzed ${i + 1}/${stackedResults.length}`);
        return analysis;
    });

    // Step 2: Calculate transforms
    const transforms = calculateAlignmentTransforms(analysisResults, options);

    // Log transforms for debugging
    console.log('[Alignment] Transforms:', transforms.map((t, i) => ({
        frame: i,
        dx: t.dx.toFixed(1),
        dy: t.dy.toFixed(1),
        rotation: (t.dTheta * 180 / Math.PI).toFixed(2) + '°',
        scale: t.scale.toFixed(3)
    })));

    // Step 3: Apply transforms
    if (onProgress) onProgress(0, stackedResults.length, 'Applying alignment...');

    const alignedResults = [];
    for (let i = 0; i < stackedResults.length; i++) {
        const aligned = await applyAlignmentTransform(
            stackedResults[i],
            transforms[i],
            { outputWidth: stackedResults[i].width, outputHeight: stackedResults[i].height }
        );
        alignedResults.push({
            ...stackedResults[i],
            ...aligned
        });
        if (onProgress) onProgress(i + 1, stackedResults.length, `Aligned ${i + 1}/${stackedResults.length}`);
    }

    return alignedResults;
}

/**
 * Calculate the maximum bounds needed to contain all aligned images
 * without cropping after rotation
 *
 * @param {Array} stackedResults - Array of stacking results
 * @param {Array} transforms - Array of transform objects from calculateAlignmentTransforms
 * @returns {Object} { width, height } - Maximum output dimensions needed
 */
export function calculateAlignedBounds(stackedResults, transforms) {
    let maxWidth = 0;
    let maxHeight = 0;

    for (let i = 0; i < stackedResults.length; i++) {
        const result = stackedResults[i];
        const transform = transforms[i];

        // For rotation, calculate the bounding box of the rotated rectangle
        const angle = Math.abs(transform.dTheta);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        // Rotated bounding box dimensions
        const rotatedWidth = Math.abs(result.width * cos) + Math.abs(result.height * sin);
        const rotatedHeight = Math.abs(result.width * sin) + Math.abs(result.height * cos);

        // Add translation offset
        const totalWidth = rotatedWidth + Math.abs(transform.dx) * 2;
        const totalHeight = rotatedHeight + Math.abs(transform.dy) * 2;

        maxWidth = Math.max(maxWidth, totalWidth);
        maxHeight = Math.max(maxHeight, totalHeight);
    }

    return {
        width: Math.ceil(maxWidth),
        height: Math.ceil(maxHeight)
    };
}

export default {
    analyzeStackedImage,
    calculateAlignmentTransforms,
    applyAlignmentTransform,
    alignStackedImages,
    calculateAlignedBounds
};
