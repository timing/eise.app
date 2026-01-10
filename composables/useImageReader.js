// composables/useImageReader.js

import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

// Native image formats that browsers can decode directly
const NATIVE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

export function useImageReader() {
    const { addLog, emit } = useEventBus();
    const { uploadFrames } = useUploader();

    const numWorkers = navigator.hardwareConcurrency || 4;
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;

    async function initializeWorkers() {
        if (workersReady) return;
        addLog("Initializing analysis workers...");

        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js'));
        }

        const workerPromises = unifiedAnalyzeWorkers.map((worker, i) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Worker ${i} initialization timed out.`)), 10000);
                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        clearTimeout(timeout);
                        worker.onmessage = null;
                        resolve();
                    }
                };
                worker.onerror = (e) => {
                    clearTimeout(timeout);
                    reject(e);
                };
                worker.postMessage({ type: 'init' });
            });
        });

        try {
            await Promise.all(workerPromises);
            workersReady = true;
            addLog("Analysis workers ready.");
        } catch (error) {
            console.error("Worker initialization failed:", error);
            addLog(`Error: Could not initialize analysis workers. Reason: ${error.message}`);
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const messageHandler = (e) => {
                worker.removeEventListener('message', messageHandler);
                if (e.data.error) {
                    reject(e.data.error);
                } else {
                    resolve({ sharpness: e.data.sharpness, pngBlob: e.data.pngBlob, index: e.data.index });
                }
            };
            const errorHandler = (e) => {
                worker.removeEventListener('error', errorHandler);
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            worker.postMessage(data, transferables);
        });
    }

    // Convert an image file to PNG ArrayBuffer using FFmpeg
    async function convertImageToPng(file, ffmpeg, loadFFmpeg) {
        await loadFFmpeg();

        const { fetchFile } = await import('@ffmpeg/ffmpeg');

        const inputName = `input_${Date.now()}_${file.name}`;
        const outputName = `output_${Date.now()}.png`;

        ffmpeg.FS('writeFile', inputName, await fetchFile(file));
        await ffmpeg.run('-i', inputName, outputName);

        const data = ffmpeg.FS('readFile', outputName);

        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);

        return data;
    }

    // Convert a native format image to PNG ArrayBuffer
    async function nativeImageToPngBuffer(file) {
        // Create an image element to decode the image
        const img = new Image();
        const url = URL.createObjectURL(file);

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        URL.revokeObjectURL(url);

        // Draw to canvas and export as PNG
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Get PNG blob and convert to ArrayBuffer
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function readImageFiles(files, ffmpeg, loadFFmpeg) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping image processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        emit('start-loading', 'Processing images');
        emit('update-loading', 0);

        addLog(`Processing ${files.length} images for stacking...`);

        const frameCount = files.length;
        const bestFramesCapacity = Math.max(1, Math.floor(frameCount * 0.3));
        const bestFramesForStacking = [];
        let top4Frames = [];
        let worstFrame = null;

        function rankFrame(frame) {
            if (top4Frames.length < 4) {
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness);
            } else if (frame.sharpness > top4Frames[3].sharpness) {
                top4Frames.pop();
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness);
            }

            if (worstFrame === null || frame.sharpness < worstFrame.sharpness) {
                worstFrame = frame;
            }

            if (bestFramesForStacking.length < bestFramesCapacity) {
                bestFramesForStacking.push(frame);
            } else {
                let minSharpnessIndex = bestFramesForStacking.reduce((minIdx, currFrame, idx, arr) =>
                    (currFrame.sharpness < arr[minIdx].sharpness) ? idx : minIdx, 0);

                if (frame.sharpness > bestFramesForStacking[minSharpnessIndex].sharpness) {
                    bestFramesForStacking[minSharpnessIndex] = frame;
                }
            }
        }

        const workerPromises = [];
        let completedFrames = 0;
        let ffmpegLoaded = false;

        for (let i = 0; i < frameCount; i++) {
            const file = files[i];
            const isNative = NATIVE_FORMATS.includes(file.type);

            let pngData;
            try {
                if (isNative) {
                    pngData = await nativeImageToPngBuffer(file);
                } else {
                    addLog(`Converting ${file.name} using FFmpeg...`);
                    if (!ffmpegLoaded) {
                        await loadFFmpeg();
                        ffmpegLoaded = true;
                    }
                    pngData = await convertImageToPng(file, ffmpeg, loadFFmpeg);
                }
            } catch (error) {
                addLog(`Error processing ${file.name}: ${error.message}`);
                continue;
            }

            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const dataToWorker = {
                type: 'ffmpeg', // Use ffmpeg type since it's PNG data
                analyze: pngData.slice(0),
                index: i
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.analyze.buffer])
                .then(result => {
                    const currentFrame = { sharpness: result.sharpness, blob: result.pngBlob };
                    rankFrame(currentFrame);

                    completedFrames++;

                    if (result.index % 5 === 0 || result.index === frameCount - 1) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });

                        const top4FrameBlobs = top4Frames.map(f => f.blob);
                        const worstFrameBlob = worstFrame ? worstFrame.blob : null;

                        emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
                    }
                })
                .catch(error => {
                    addLog(`Error analyzing image ${i}: ${error}`);
                    console.error(`Error analyzing image ${i}:`, error);
                });

            workerPromises.push(promise);
        }

        await Promise.all(workerPromises);

        addLog(`Finished analyzing ${frameCount} images. Kept ${bestFramesForStacking.length} best images.`);

        // Terminate workers
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());

        // Clean up FFmpeg if it was used
        if (ffmpegLoaded) {
            try {
                ffmpeg.exit();
            } catch (e) {}
        }

        // Upload best frames for stacking
        const pngBlobs = bestFramesForStacking.map(f => ({ pngFile: [f.blob] }));
        await uploadFrames(pngBlobs);
    }

    return { readImageFiles };
}
