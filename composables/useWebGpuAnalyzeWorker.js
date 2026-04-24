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

export function useWebGpuAnalyzeWorker() {
    const { addLog } = useEventBus();
    const { workerUrl } = useWorkerUrl();

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
        }
    }

    /**
     * Check if GPU worker is ready
     */
    function isGpuReady() {
        return gpuReady;
    }

    /**
     * GPU batch analysis for RGBA frames
     */
    async function analyzeRgbaBatchGpu(frames, width, height) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }

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
     * GPU crop and analyze for RGBA frames
     */
    async function cropAndAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, centers, metadataOnly = false) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }

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
     * Combined detect + crop + analyze in ONE GPU pass for RGBA frames
     */
    async function detectCropAnalyzeRgbaGpu(frames, srcWidth, srcHeight, cropSize, threshold = 0.1, metadataOnly = false) {
        if (!gpuReady || !gpuWorker) {
            throw new Error('GPU worker not initialized');
        }

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
        analyzeRgbaBatchGpu,
        cropAndAnalyzeRgbaGpu,
        detectCropAnalyzeRgbaGpu,
        decodeImageToRgba
    };
}
