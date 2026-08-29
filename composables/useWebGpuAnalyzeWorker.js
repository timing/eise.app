// composables/useWebGpuAnalyzeWorker.js
// Shared WebGPU analyze worker wrapper - provides RGBA GPU analysis functions
// Used by readers that work with already-decoded RGBA frames (MJPEG, FFmpeg, images)

import { useEventBus } from '@/composables/eventBus';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { reportError } from '@/composables/useSentryReporting';

// Singleton GPU worker - shared across all readers
let gpuWorker = null;
let gpuReady = false;
let initPromise = null;
let logListenerAttached = false;
let deviceLostListenerAttached = false;
// Cache getMaxBatchSize results per (width, height, bitDepth) — the underlying
// message round-trip is ~1ms but adds up on hot paths. Cleared on terminate.
const maxBatchCache = new Map();

export function useWebGpuAnalyzeWorker() {
    const { addLog, emit } = useEventBus();
    const { workerUrl } = useWorkerUrl();

    // Route worker-side {type: 'log'} messages into the app logger + Sentry.
    // Without this, uncaptured WebGPU validation errors (e.g. buffer > maxBufferSize)
    // only appear in the worker's DevTools console and never reach the user or Sentry.
    function attachWorkerLogListener() {
        if (logListenerAttached || !gpuWorker) return;
        logListenerAttached = true;
        gpuWorker.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'log') return;
            const { level, message } = e.data;
            addLog(message);
            if (level === 'error') {
                reportError(new Error(message), { component: 'useWebGpuAnalyzeWorker', action: 'workerLog' });
            }
        });
    }

    // Route worker-side device.lost / auto-recovery events into stack-step
    // analytics. Before this, the worker posted device-lost-recovering and
    // device-recovered but no one listened, so we couldn't tell whether the
    // 13 `GPU device was lost` failures in the analytics were "never tried
    // recovery", "tried and failed", or "tried repeatedly". Now every step
    // shows up in the funnel so we can measure the recovery success rate.
    function attachDeviceLostListener() {
        if (deviceLostListenerAttached || !gpuWorker) return;
        deviceLostListenerAttached = true;
        gpuWorker.addEventListener('message', (e) => {
            if (!e.data) return;
            if (e.data.type === 'device-lost-recovering') {
                addLog(`GPU device lost, auto-recovery starting: ${e.data.message || ''}`);
                emit('stack-step', 'gpu_device_lost');
            } else if (e.data.type === 'device-recovered') {
                addLog('GPU device recovered');
                emit('stack-step', 'gpu_device_recovered');
            }
        });
    }

    /**
     * Initialize GPU worker (singleton - safe to call multiple times)
     */
    async function initializeGpuWorker() {
        // Return existing ready state
        if (gpuReady) return true;

        // Return pending initialization
        if (initPromise) return initPromise;

        // Start new initialization
        initPromise = (async () => {
            gpuWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' });

            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU worker timeout')), 30000);
                    gpuWorker.onerror = (event) => {
                        clearTimeout(timeout);
                        reject(event.error || new Error(event.message || 'GPU worker load error'));
                    };
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
                attachWorkerLogListener();
                attachDeviceLostListener();
                addLog('GPU analyze worker initialized');
                return true;
            } catch (error) {
                console.error('GPU worker init failed:', error);
                addLog(`GPU worker init failed: ${error.message}`);
                reportError(error, { component: 'useWebGpuAnalyzeWorker', action: 'initializeGpuWorker' });
                gpuWorker.terminate();
                gpuWorker = null;
                initPromise = null;
                return false;
            }
        })();

        return initPromise;
    }

    /**
     * Terminate GPU worker
     */
    function terminateGpuWorker() {
        if (gpuWorker) {
            gpuWorker.terminate();
            gpuWorker = null;
            gpuReady = false;
            initPromise = null;
            logListenerAttached = false;
            deviceLostListenerAttached = false;
            maxBatchCache.clear();
        }
    }

    /**
     * Query the GPU worker for batch info at these dimensions. Returns the full
     * {maxBatch, deviceCanFit, ...} payload. maxBatch is always >= 1 (floored so
     * callers' chunking loops never divide-by-zero); check deviceCanFit to know
     * whether a single frame actually fits the device's per-buffer caps.
     */
    async function queryMaxBatchInfo(width, height, bitDepth = 8) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }
        return new Promise((resolve, reject) => {
            let timeout;
            const handler = (e) => {
                if (e.data?.type !== 'max-batch-size') return;
                clearTimeout(timeout);
                gpuWorker.removeEventListener('message', handler);
                resolve(e.data);
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({ type: 'get-max-batch-size', width, height, bitDepth });
            timeout = setTimeout(() => {
                gpuWorker.removeEventListener('message', handler);
                reject(new Error('GPU worker did not respond to get-max-batch-size'));
            }, 15000);
        });
    }

    /**
     * Ask the GPU worker how many frames fit in one analyzeBatch call at these
     * dimensions, given the current device's maxBufferSize. Callers should chunk
     * larger batches to avoid silent WebGPU allocation failures (Sentry EISE-M2).
     * Always >= 1; callers wanting to know whether a single frame fits should
     * use assertDeviceCanFitFrame instead.
     */
    async function getMaxBatchSize(width, height, bitDepth = 8) {
        return (await queryMaxBatchInfo(width, height, bitDepth)).maxBatch;
    }

    /**
     * Bail early with an actionable error when a device cannot fit even a single
     * frame at these dimensions. Reader composables should call this after
     * decoding the first frame and learning the true dimensions, before dispatching
     * any analyze work. Errors are tagged `source: 'device-capability'` so the
     * caller (FileUploader) can skip the ffmpeg fallback, since ffmpeg feeds the same
     * analyze worker and would fail identically.
     */
    async function assertDeviceCanFitFrame(width, height, bitDepth = 8) {
        const info = await queryMaxBatchInfo(width, height, bitDepth);
        if (info.deviceCanFit) return info.maxBatch;
        const err = new Error(
            `This device's GPU cannot analyze ${width}×${height} frames: a single frame's ` +
            `analysis buffer exceeds the per-buffer limit. Try a lower-resolution capture, ` +
            `or use CPU mode (slower but no size limit).`
        );
        err.source = 'device-capability';
        throw err;
    }

    /**
     * Check if GPU worker is ready
     */
    function isGpuReady() {
        return gpuReady;
    }

    /**
     * Cached wrapper around getMaxBatchSize — same result per dimensions until
     * the worker is terminated (which invalidates the cache).
     */
    async function getMaxBatchCached(width, height, bitDepth = 8) {
        const key = `${width}x${height}x${bitDepth}`;
        if (maxBatchCache.has(key)) return maxBatchCache.get(key);
        const maxBatch = await getMaxBatchSize(width, height, bitDepth);
        maxBatchCache.set(key, maxBatch);
        return maxBatch;
    }

    /**
     * GPU batch analysis for RGBA frames. Transparently chunks large batches
     * so no single dispatch exceeds the device's maxBufferSize — the caller's
     * batch-sizing heuristic doesn't need to know about GPU memory limits.
     * See Sentry EISE-M2 / EISE-MT.
     */
    async function analyzeRgbaBatchGpu(frames, width, height) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }
        const maxBatch = await getMaxBatchCached(width, height, 8);
        if (frames.length <= maxBatch) {
            return dispatchAnalyzeBatch(frames, width, height);
        }
        // Batch is larger than the device can handle in one dispatch — chunk it.
        addLog(`GPU analyze chunked: ${frames.length} frames / ${maxBatch} per batch (${width}x${height})`);
        const results = [];
        for (let start = 0; start < frames.length; start += maxBatch) {
            const chunk = frames.slice(start, start + maxBatch);
            const chunkResults = await dispatchAnalyzeBatch(chunk, width, height);
            results.push(...chunkResults);
        }
        return results;
    }

    async function dispatchAnalyzeBatch(frames, width, height) {
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
                    const err = new Error(e.data.error);
                    reportError(err, { component: 'useWebGpuAnalyzeWorker', action: 'analyzeRgbaBatchGpu', frameCount: frames.length, width, height });
                    reject(err);
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

    /**
     * GPU crop and analyze for RGBA frames. Chunks larger-than-device batches
     * so a single dispatch never trips maxBufferSize / maxStorageBufferBindingSize.
     * See Sentry EISE-MT / EISE-NJ.
     */
    async function cropAndAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, centers, metadataOnly = false) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }
        const maxBatch = await getMaxBatchCached(srcWidth, srcHeight, 8);
        if (frames.length <= maxBatch) {
            return dispatchCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, metadataOnly);
        }
        addLog(`GPU crop-analyze chunked: ${frames.length} frames / ${maxBatch} per batch (${srcWidth}x${srcHeight})`);
        const results = [];
        for (let start = 0; start < frames.length; start += maxBatch) {
            const chunk = frames.slice(start, start + maxBatch);
            const chunkCenters = centers ? centers.slice(start, start + maxBatch) : centers;
            const chunkResults = await dispatchCropAnalyzeBatch(chunk, srcWidth, srcHeight, cropSize, chunkCenters, metadataOnly);
            results.push(...chunkResults);
        }
        return results;
    }

    async function dispatchCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, metadataOnly) {
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
                    const err = new Error(e.data.error);
                    reportError(err, { component: 'useWebGpuAnalyzeWorker', action: 'cropAndAnalyzeRgbaGpu', frameCount: frames.length, srcWidth, srcHeight });
                    reject(err);
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

    /**
     * Combined detect + crop + analyze in ONE GPU pass for RGBA frames. Chunks
     * larger-than-device batches. See Sentry EISE-MT / EISE-NJ.
     */
    async function detectCropAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, threshold = 0.1, metadataOnly = false) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }
        const maxBatch = await getMaxBatchCached(srcWidth, srcHeight, 8);
        if (frames.length <= maxBatch) {
            return dispatchDetectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, threshold, metadataOnly);
        }
        addLog(`GPU detect-crop-analyze chunked: ${frames.length} frames / ${maxBatch} per batch (${srcWidth}x${srcHeight})`);
        const results = [];
        for (let start = 0; start < frames.length; start += maxBatch) {
            const chunk = frames.slice(start, start + maxBatch);
            const chunkResults = await dispatchDetectCropAnalyzeBatch(chunk, srcWidth, srcHeight, cropSize, threshold, metadataOnly);
            results.push(...chunkResults);
        }
        return results;
    }

    async function dispatchDetectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, threshold, metadataOnly) {
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
                if (e.data.type === 'detect-crop-analyze-result') {
                    resolve(e.data.results);
                } else if (e.data.type === 'detect-crop-analyze-error') {
                    const err = new Error(e.data.error);
                    reportError(err, { component: 'useWebGpuAnalyzeWorker', action: 'detectCropAnalyzeRgbaGpu', frameCount: frames.length, srcWidth, srcHeight });
                    reject(err);
                }
            };
            gpuWorker.addEventListener('message', handler);
            gpuWorker.postMessage({
                type: 'detect-crop-analyze-batch',
                frames,
                srcWidth,
                srcHeight,
                cropSize,
                bayerPattern: -1, // RGBA input, no demosaic
                threshold,
                requestId,
                metadataOnly
            });
        });
    }

    /**
     * Decode image data to RGBA using native browser decoding (hardware accelerated)
     */
    async function decodeImageToRgba(data, mimeType = 'image/png') {
        const blob = new Blob([data], { type: mimeType });
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            data: imageData.data,
            width: canvas.width,
            height: canvas.height
        };
    }

    return {
        initializeGpuWorker,
        terminateGpuWorker,
        isGpuReady,
        getMaxBatchSize,
        assertDeviceCanFitFrame,
        analyzeRgbaBatchGpu,
        cropAndAnalyzeRgbaGpu,
        detectCropAnalyzeRgbaGpu,
        decodeImageToRgba
    };
}
