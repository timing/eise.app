/**
 * WebGPU rotation with bicubic (Keys, a=-0.5) interpolation on float32 data.
 * Reuses the shared transform worker at public/webgpu_postprocessor_worker.js.
 * Returns null when WebGPU is unavailable so the caller can fall back to CPU.
 */

let worker = null;
let workerReady = false;
let workerInitPromise = null;
let requestIdCounter = 0;
const pendingRequests = new Map();

async function getWorker() {
    if (workerReady) return worker;

    if (!workerInitPromise) {
        workerInitPromise = (async () => {
            try {
                worker = new Worker('/webgpu_postprocessor_worker.js');

                worker.onmessage = (e) => {
                    const { type, requestId, result, error } = e.data;

                    if (type === 'ready') {
                        workerReady = true;
                        return;
                    }
                    if (type === 'init-error') {
                        workerReady = false;
                        return;
                    }

                    const pending = pendingRequests.get(requestId);
                    if (!pending) return;
                    pendingRequests.delete(requestId);

                    if (type === 'transform-result') pending.resolve(result);
                    else if (type === 'transform-error') pending.reject(new Error(error));
                };

                worker.postMessage({ type: 'init' });

                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('init timeout')), 5000);
                    const iv = setInterval(() => {
                        if (workerReady) {
                            clearTimeout(timeout);
                            clearInterval(iv);
                            resolve();
                        }
                    }, 10);
                });
            } catch (e) {
                console.warn('[rotateGPU] worker init failed:', e);
                worker = null;
                workerReady = false;
            }
        })();
    }

    await workerInitPromise;
    return workerReady ? worker : null;
}

/**
 * Rotate an RGBA Float32 image (values 0..1) by angleDegrees on the GPU.
 * Same CCW direction convention as Image16.rotate().
 * @param {Float32Array} float32Data - RGBA data, length = width*height*4
 * @param {number} width
 * @param {number} height
 * @param {number} angleDegrees
 * @returns {Promise<Float32Array|null>} rotated data, or null if GPU unavailable
 */
export async function rotateGPU(float32Data, width, height, angleDegrees) {
    const w = await getWorker();
    if (!w) return null;

    const theta = angleDegrees * Math.PI / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // Standard rotation matrix R(θ). The shader inverts it internally to get the
    // output→source backward mapping R(-θ), which matches Image16.rotate().
    const affine = { a00: cos, a01: -sin, a10: sin, a11: cos };

    const requestId = ++requestIdCounter;
    const inputCopy = new Float32Array(float32Data);

    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        w.postMessage({
            type: 'apply-transform',
            requestId,
            inputData: inputCopy,
            width,
            height,
            transform: { dx: 0, dy: 0, affine },
            options: { outputWidth: width, outputHeight: height }
        }, [inputCopy.buffer]);
    });
}
