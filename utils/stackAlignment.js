/**
 * stackAlignment.js - Alignment transforms for batch stacked images
 *
 * Aligns multiple stacked images for wobble-free rotation animations.
 * Uses moment-based detection for robust center and scale alignment.
 */

// Postprocessor worker for GPU transforms (float32 bicubic)
let transformWorker = null;
let transformWorkerReady = false;
let requestIdCounter = 0;
const pendingRequests = new Map();

async function getTransformWorker() {
    if (transformWorker && transformWorkerReady) return transformWorker;

    if (!transformWorker) {
        try {
            transformWorker = new Worker('/webgpu_postprocessor_worker.js');

            transformWorker.onmessage = (e) => {
                const { type, requestId, result, error } = e.data;

                if (type === 'ready') {
                    transformWorkerReady = true;
                    console.log('[Alignment] Transform worker ready');
                    return;
                }

                if (type === 'init-error') {
                    console.warn('[Alignment] Transform worker init failed:', error);
                    transformWorkerReady = false;
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

            transformWorker.postMessage({ type: 'init' });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Transform worker init timeout')), 5000);
                const checkReady = setInterval(() => {
                    if (transformWorkerReady) {
                        clearTimeout(timeout);
                        clearInterval(checkReady);
                        resolve();
                    }
                }, 10);
            });
        } catch (e) {
            console.warn('[Alignment] Transform worker not available:', e);
            transformWorker = null;
            transformWorkerReady = false;
            return null;
        }
    }

    return transformWorker;
}

/**
 * Analyze image to find centroid, radius, and ellipse shape using image moments
 * Returns centroid, radius, ellipse parameters, and image dimensions
 */
function analyzeImage(float32Data, width, height, threshold = 0.05) {
    let m00 = 0;  // Total weight (area)
    let m10 = 0;  // First moment X
    let m01 = 0;  // First moment Y
    let m20 = 0;  // Second moment XX
    let m02 = 0;  // Second moment YY
    let m11 = 0;  // Second moment XY (covariance)

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = float32Data[idx];
            const g = float32Data[idx + 1];
            const b = float32Data[idx + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            if (lum > threshold) {
                const w = lum;
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
        return {
            centroid: { x: width / 2, y: height / 2 },
            radius: Math.min(width, height) / 4,
            ellipse: { angle: 0, axisRatio: 1, majorAxis: 1, minorAxis: 1 },
            width,
            height
        };
    }

    // Centroid
    const cx = m10 / m00;
    const cy = m01 / m00;

    // Central moments (covariance matrix)
    const mu20 = m20 / m00 - cx * cx;
    const mu02 = m02 / m00 - cy * cy;
    const mu11 = m11 / m00 - cx * cy;

    // Equivalent radius from second moments
    const avgMoment = (mu20 + mu02) / 2;
    const radius = 2 * Math.sqrt(Math.max(0, avgMoment));

    // Ellipse parameters from eigenvalues of covariance matrix
    // | mu20  mu11 |
    // | mu11  mu02 |
    // Eigenvalues: λ = (mu20 + mu02)/2 ± sqrt(((mu20 - mu02)/2)² + mu11²)
    const trace = mu20 + mu02;
    const det = mu20 * mu02 - mu11 * mu11;
    const discriminant = Math.sqrt(Math.max(0, trace * trace / 4 - det));

    const lambda1 = trace / 2 + discriminant;  // Larger eigenvalue
    const lambda2 = trace / 2 - discriminant;  // Smaller eigenvalue

    // Axis lengths (proportional to sqrt of eigenvalues)
    const majorAxis = 2 * Math.sqrt(Math.max(0, lambda1));
    const minorAxis = 2 * Math.sqrt(Math.max(0, lambda2));
    const axisRatio = minorAxis > 0 ? majorAxis / minorAxis : 1;

    // Angle of major axis (eigenvector direction)
    // For eigenvector of lambda1: (mu20 - lambda1) * v1 + mu11 * v2 = 0
    // So v2/v1 = -(mu20 - lambda1) / mu11 = (lambda1 - mu20) / mu11
    let angle = 0;
    if (Math.abs(mu11) > 1e-10) {
        angle = Math.atan2(lambda1 - mu20, mu11);
    } else if (mu20 > mu02) {
        angle = 0;  // Major axis along X
    } else {
        angle = Math.PI / 2;  // Major axis along Y
    }

    return {
        centroid: { x: cx, y: cy },
        radius,
        ellipse: { angle, axisRatio, majorAxis, minorAxis },
        width,
        height
    };
}

/**
 * Calculate alignment transforms for center + scale alignment
 *
 * Transform order (applied in shader):
 * 1. Translate so source centroid is at origin
 * 2. Scale to match reference radius
 * 3. Translate so origin moves to reference centroid
 *
 * Combined: dst = (src - srcCenter) * scale + refCenter
 * Rearranged: dst = src * scale + (refCenter - srcCenter * scale)
 * So: dx = refCenter.x - srcCenter.x * scale
 *     dy = refCenter.y - srcCenter.y * scale
 */
export function calculateAlignmentTransforms(analyses, options = {}) {
    const { referenceIndex = null } = options;

    if (analyses.length === 0) return [];

    // Use middle frame as reference
    const refIdx = referenceIndex !== null
        ? Math.min(referenceIndex, analyses.length - 1)
        : Math.floor(analyses.length / 2);

    const ref = analyses[refIdx];
    console.log(`[Alignment] Reference frame ${refIdx + 1}/${analyses.length}: center=(${ref.centroid.x.toFixed(1)}, ${ref.centroid.y.toFixed(1)}), radius=${ref.radius.toFixed(1)}`);

    return analyses.map((analysis, i) => {
        // Scale to match reference radius
        const uniformScale = (analysis.radius > 0 && ref.radius > 0)
            ? ref.radius / analysis.radius
            : 1;

        // Ellipse correction WITHOUT rotation:
        // We want to fix the wobble (ellipse shape) but NOT rotate the planet.
        // Strategy: Scale along the ellipse's own axes to match reference axis ratio,
        // then rotate back by the SAME angle (not refAngle).
        //
        // A = R(srcAngle) * S * R(-srcAngle)
        // This stretches the ellipse to match ref axis ratio, but preserves orientation.

        const srcAngle = analysis.ellipse.angle;

        // Target axis ratio from reference
        const targetRatio = ref.ellipse.axisRatio;
        const srcRatio = analysis.ellipse.axisRatio;

        // Scale factors: we want to transform src ellipse to have same axis ratio as ref
        // Without rotation, we scale along src's own major/minor axes
        // scaleX = along major axis, scaleY = along minor axis
        // To match ratio: scaleY / scaleX should equal targetRatio / srcRatio
        // We also apply uniform scale to match radius

        // Make src ellipse have same axis ratio as ref
        // In ellipse local coords: X = major axis, Y = minor axis
        // After scaling: new_ratio = srcRatio * (scaleX / scaleY)
        // We want: new_ratio = targetRatio
        // So: scaleY / scaleX = srcRatio / targetRatio
        const ratioCorrection = (srcRatio > 0 && targetRatio > 0)
            ? srcRatio / targetRatio  // > 1 when src is more elliptical, stretches minor axis
            : 1;

        // Scale along major axis (X in ellipse coords) = uniform scale
        // Scale along minor axis (Y in ellipse coords) = uniform scale * ratio correction
        const scaleX = uniformScale;
        const scaleY = uniformScale * ratioCorrection;

        // Build affine matrix: A = R(srcAngle) * S * R(-srcAngle)
        // This applies scale in the ellipse's local coordinate system
        const cosA = Math.cos(srcAngle);
        const sinA = Math.sin(srcAngle);

        // R(-srcAngle) rotates points into ellipse local coords
        // S scales in local coords
        // R(srcAngle) rotates back to image coords
        //
        // R(-θ) = | cos(-θ)  -sin(-θ) | = |  cos(θ)  sin(θ) |
        //         | sin(-θ)   cos(-θ) |   | -sin(θ)  cos(θ) |
        //
        // R(θ)  = | cos(θ)  -sin(θ) |
        //         | sin(θ)   cos(θ) |
        //
        // A = R(θ) * S * R(-θ)

        // First: S * R(-θ) where S = diag(scaleX, scaleY)
        const sr00 = scaleX * cosA;
        const sr01 = scaleX * sinA;
        const sr10 = scaleY * (-sinA);
        const sr11 = scaleY * cosA;

        // Then: R(θ) * (S * R(-θ))
        const a00 = cosA * sr00 - sinA * sr10;
        const a01 = cosA * sr01 - sinA * sr11;
        const a10 = sinA * sr00 + cosA * sr10;
        const a11 = sinA * sr01 + cosA * sr11;

        // For translation, we need to account for the full affine transform
        // dst = A * (src - imgCenter) + imgCenter + (dx, dy)
        // We want srcCentroid -> refCentroid:
        // refCentroid = A * (srcCentroid - imgCenter) + imgCenter + (dx, dy)
        // (dx, dy) = refCentroid - A * (srcCentroid - imgCenter) - imgCenter

        const imgCx = analysis.width / 2;
        const imgCy = analysis.height / 2;

        const srcRelX = analysis.centroid.x - imgCx;
        const srcRelY = analysis.centroid.y - imgCy;

        const transformedX = a00 * srcRelX + a01 * srcRelY;
        const transformedY = a10 * srcRelX + a11 * srcRelY;

        const dx = ref.centroid.x - transformedX - imgCx;
        const dy = ref.centroid.y - transformedY - imgCy;

        return {
            dx, dy,
            // Pass the full 2x2 affine matrix
            affine: { a00, a01, a10, a11 }
        };
    });
}

/**
 * Apply alignment transform using WebGPU (float32 bicubic)
 */
export async function applyAlignmentTransform(result, transform, options = {}) {
    const {
        outputWidth = result.width,
        outputHeight = result.height
    } = options;

    const { dx, dy, affine } = transform;

    // Check if affine is identity (or close to it)
    const isIdentity = affine &&
        Math.abs(affine.a00 - 1) < 0.0001 &&
        Math.abs(affine.a01) < 0.0001 &&
        Math.abs(affine.a10) < 0.0001 &&
        Math.abs(affine.a11 - 1) < 0.0001;

    // Skip if no transform needed
    const needsTransform = Math.abs(dx) >= 0.5 ||
                           Math.abs(dy) >= 0.5 ||
                           !isIdentity;

    if (!needsTransform) {
        return result;
    }

    // Try GPU transform (float32 bicubic)
    const worker = await getTransformWorker();
    if (worker) {
        console.log('[Alignment] Using GPU transform:', { dx: dx.toFixed(2), dy: dy.toFixed(2), affine });
        try {
            const requestId = ++requestIdCounter;
            const inputCopy = new Float32Array(result.float32Data);

            const transformedData = await new Promise((resolve, reject) => {
                pendingRequests.set(requestId, { resolve, reject });
                worker.postMessage({
                    type: 'apply-transform',
                    requestId,
                    inputData: inputCopy,
                    width: result.width,
                    height: result.height,
                    transform: { dx, dy, affine },
                    options: { outputWidth, outputHeight }
                }, [inputCopy.buffer]);
            });

            const blob = await float32ToBlob(transformedData, outputWidth, outputHeight);

            return {
                blob,
                float32Data: transformedData,
                width: outputWidth,
                height: outputHeight
            };
        } catch (err) {
            console.warn('[Alignment] GPU transform failed, falling back to canvas:', err);
        }
    } else {
        console.warn('[Alignment] GPU worker not available, using canvas fallback');
    }

    // Canvas fallback (8-bit precision loss - not ideal)
    console.warn('[Alignment] Using canvas fallback (8-bit precision loss)');
    return applyAlignmentTransformCanvas(result, transform, options);
}

/**
 * Canvas fallback (8-bit precision loss)
 */
async function applyAlignmentTransformCanvas(result, transform, options = {}) {
    const { outputWidth = result.width, outputHeight = result.height } = options;
    const { dx, dy, affine } = transform;

    const srcCanvas = new OffscreenCanvas(result.width, result.height);
    const srcCtx = srcCanvas.getContext('2d');

    const uint8Data = new Uint8ClampedArray(result.float32Data.length);
    for (let i = 0; i < result.float32Data.length; i++) {
        uint8Data[i] = Math.round(Math.min(1, Math.max(0, result.float32Data[i])) * 255);
    }
    srcCtx.putImageData(new ImageData(uint8Data, result.width, result.height), 0, 0);

    const dstCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const dstCtx = dstCanvas.getContext('2d');
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = 'high';

    const srcCenterX = result.width / 2;
    const srcCenterY = result.height / 2;

    dstCtx.save();
    dstCtx.translate(srcCenterX + dx, srcCenterY + dy);
    // Apply affine matrix using setTransform (a, b, c, d, e, f)
    // Canvas: | a  c  e |   Our affine: | a00  a01 |
    //         | b  d  f |               | a10  a11 |
    if (affine) {
        dstCtx.transform(affine.a00, affine.a10, affine.a01, affine.a11, 0, 0);
    }
    dstCtx.drawImage(srcCanvas, -srcCenterX, -srcCenterY);
    dstCtx.restore();

    const outputImageData = dstCtx.getImageData(0, 0, outputWidth, outputHeight);
    const outputFloat32 = new Float32Array(outputImageData.data.length);
    for (let i = 0; i < outputImageData.data.length; i++) {
        outputFloat32[i] = outputImageData.data[i] / 255;
    }

    const blob = await dstCanvas.convertToBlob({ type: 'image/png' });
    return { blob, float32Data: outputFloat32, width: outputWidth, height: outputHeight };
}

/**
 * Convert float32 RGBA to PNG blob
 */
async function float32ToBlob(float32Data, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const uint8 = new Uint8ClampedArray(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        uint8[i] = Math.round(Math.min(1, Math.max(0, float32Data[i])) * 255);
    }
    ctx.putImageData(new ImageData(uint8, width, height), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Align all stacked images - center + scale alignment
 */
export async function alignStackedImages(stackedResults, options = {}) {
    const { onProgress = null, threshold = 0.05 } = options;

    if (stackedResults.length <= 1) {
        return stackedResults;
    }

    // Step 1: Analyze all images (find centroid + radius)
    if (onProgress) onProgress(0, stackedResults.length, 'Analyzing images...');

    const analyses = stackedResults.map((result, i) => {
        const analysis = analyzeImage(result.float32Data, result.width, result.height, threshold);
        if (onProgress) onProgress(i + 1, stackedResults.length, `Analyzed ${i + 1}/${stackedResults.length}`);
        return analysis;
    });

    // Step 2: Calculate transforms
    const transforms = calculateAlignmentTransforms(analyses, options);

    // Log transforms and ellipse info
    const refIdx = Math.floor(analyses.length / 2);
    console.log('[Alignment] Reference (middle frame):', {
        cx: analyses[refIdx].centroid.x.toFixed(1),
        cy: analyses[refIdx].centroid.y.toFixed(1),
        radius: analyses[refIdx].radius.toFixed(1),
        axisRatio: analyses[refIdx].ellipse.axisRatio.toFixed(3)
    });
    console.log('[Alignment] Analyses:', analyses.map((a, i) => ({
        frame: i,
        cx: a.centroid.x.toFixed(1),
        cy: a.centroid.y.toFixed(1),
        radius: a.radius.toFixed(1),
        axisRatio: a.ellipse.axisRatio.toFixed(3)
    })));

    console.log('[Alignment] Transforms:', transforms.map((t, i) => ({
        frame: i,
        dx: t.dx.toFixed(1),
        dy: t.dy.toFixed(1),
        affine: t.affine ? `[${t.affine.a00.toFixed(3)}, ${t.affine.a01.toFixed(3)}; ${t.affine.a10.toFixed(3)}, ${t.affine.a11.toFixed(3)}]` : 'identity'
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

export default {
    analyzeImage,
    calculateAlignmentTransforms,
    applyAlignmentTransform,
    alignStackedImages
};
