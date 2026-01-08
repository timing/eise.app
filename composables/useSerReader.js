
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

// These functions remain on the main thread as they are not performance bottlenecks
function parseSerHeader(buffer) {
    const view = new DataView(buffer);
    const le = true; // SER files are little-endian
    let h = {
        fileId: Array.from(new Uint8Array(buffer.slice(0, 14))).map(b => String.fromCharCode(b)).join(''),
        luId: view.getInt32(14, le),
        pixelDepth: view.getInt32(18, le),
        colorID: view.getInt32(22, le),
        width: view.getInt32(26, le),
        height: view.getInt32(30, le),
        pixelDepthPerPlane: view.getInt32(34, le),
        frameCount: view.getInt32(38, le),
        observer:  Array.from(new Uint8Array(buffer.slice(42, 40))).map(b => String.fromCharCode(b)).join(''),
        instrument:  Array.from(new Uint8Array(buffer.slice(82, 40))).map(b => String.fromCharCode(b)).join(''),
        telescope:  Array.from(new Uint8Array(buffer.slice(122, 40))).map(b => String.fromCharCode(b)).join(''),
        dateTime: view.getBigInt64(162, le),
        dateTimeUTC: view.getBigInt64(170, le)
    };
    
    // some SER files have a different header layout, we try to detect this by checking for a sane width
    if (h.width <= 0 || h.width > 10000) {
        h = { ...h,
            pixelDepth: view.getInt32(20, le),
            colorID: view.getInt32(24, le),
            width: view.getInt32(32, le),
            height: view.getInt32(36, le),
            frameCount: view.getInt32(40, le)
        };
    }
    return h;
}

// This function will still be used on the main thread for preview rendering.
// It relies on cv being globally available, which it is via plugin.
async function renderFrameToBlob(canvas, buffer, header, bayerChoice) {
    const { width, height, pixelDepth } = header;
    const type = pixelDepth > 8 ? cv.CV_16UC1 : cv.CV_8UC1;
    const data = pixelDepth > 8 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    let mat = cv.matFromArray(height, width, type, data);

    // Convert to 8-bit for display
    let temp8u = new cv.Mat();
    mat.convertTo(temp8u, cv.CV_8U, pixelDepth > 8 ? 1/256 : 1);

    // Apply Color Demosaic for the preview
    let displayMat = new cv.Mat();
    
    if (bayerChoice !== "MONO" && cv[bayerChoice] !== undefined) {
        cv.demosaicing(temp8u, displayMat, cv[bayerChoice]);
    } else {
        temp8u.copyTo(displayMat);
    }

    // Auto-Stretch and Show
    let stretched = new cv.Mat();
    cv.normalize(displayMat, stretched, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
    
    canvas.width = width;
    canvas.height = height;
    cv.imshow(canvas, stretched);
    
    // Cleanup
    [mat, temp8u, displayMat, stretched].forEach(m => m.delete());

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

export function useSerReader() {
    const { addLog, emit } = useEventBus();
    const { uploadFrames } = useUploader();

    // Create a pool of workers
    const numWorkers = navigator.hardwareConcurrency || 4;
    const unifiedAnalyzeWorkers = [];
    for (let i = 0; i < numWorkers; i++) {
        unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js', { type: 'module' }));
    }

    // Function to process a frame with a worker
    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const messageHandler = (e) => {
                worker.removeEventListener('message', messageHandler); // Remove listener after message
                if (e.data.error) {
                    reject(e.data.error);
                } else {
                    resolve({ sharpness: e.data.frameData.sharpness, index: e.data.index });
                }
            };
            const errorHandler = (e) => {
                worker.removeEventListener('error', errorHandler); // Remove listener after error
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            // Transfer ownership of the ArrayBuffer for efficiency
            worker.postMessage(data, transferables);
        });
    }

    async function readSerFile(file, maxFrames = -1, bayerPattern = 'AUTO') {
        emit('start-loading', 'Importing and analyzing frames');
        emit('update-loading', 0); // Initial progress

        const headerBuf = await file.slice(0, 178).arrayBuffer();
        const header = parseSerHeader(headerBuf);
        
        addLog(`SER Header: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit`);

        let bayerChoice;
        if (bayerPattern === 'AUTO') {
            const bayerMap = { 0: "MONO", 8: "COLOR_BayerRG2RGB", 9: "COLOR_BayerGR2RGB", 10: "COLOR_BayerBayerGB2RGB", 11: "COLOR_BayerBG2RGB" };
            bayerChoice = bayerMap[header.colorID];

            if (!bayerChoice) {
                addLog(`Unknown colorID ${header.colorID}, falling back to RGGB`);
                bayerChoice = "COLOR_BayerRG2RGB";
            } else {
                addLog(`Auto-detected color profile: ${bayerChoice}`);
            }
        } else {
            bayerChoice = bayerPattern;
            addLog(`Using manually selected color profile: ${bayerChoice}`);
        }

        const bpp = header.pixelDepth > 8 ? 2 : 1;
        const frameSize = header.width * header.height * bpp;

        const previewCanvas = document.createElement('canvas'); // Used only for rendering preview blobs
        previewCanvas.width = header.width;
        previewCanvas.height = header.height;

        const frameCount = (maxFrames === -1) ? header.frameCount : Math.min(header.frameCount, maxFrames);

        const bestFramesCapacity = Math.floor(frameCount * 0.3);
	    const bestFramesForStacking = []; // These will store {sharpness, frameBuffer}
        let top4Frames = []; // These will store {sharpness, frameBuffer}
        let worstFrame = null; // This will store {sharpness, frameBuffer}

        // Store all frameBuffers in an array so we can access them by index later
        // We need to store a *copy* if we want to retain them after transferring to worker
        // Or store a reference to the file slice directly.
        // For simplicity, let's create a temporary store of ArrayBuffers for ranking
        const frameBufferStore = new Array(frameCount);

        function rankFrame(frame) {
            // Update top 4 frames
            if (top4Frames.length < 4) {
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness);
            } else if (frame.sharpness > top4Frames[3].sharpness) {
                top4Frames.pop();
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness);
            }

            // Update worst frame
            if (worstFrame === null || frame.sharpness < worstFrame.sharpness) {
                worstFrame = frame;
            }

            // Keep track of best frames for stacking
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

        for (let i = 0; i < frameCount; i++) {
            const offset = 178 + (i * frameSize);
            if (offset + frameSize > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
            frameBufferStore[i] = frameBuffer; // Store the original buffer

            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const headerForWorker = {
                width: header.width,
                height: header.height,
                pixelDepth: header.pixelDepth,
                colorID: header.colorID
            };

            const dataToWorker = {
                type: 'ser',
                frameBuffer: frameBuffer.slice(0), // Use slice(0) to create a copy for transfer
                header: headerForWorker,
                bayerChoice: bayerChoice,
                index: i
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.frameBuffer])
                .then(result => {
                    const originalBuffer = frameBufferStore[result.index]; // Retrieve original buffer
                    const currentFrame = { sharpness: result.sharpness, frameBuffer: originalBuffer };
                    rankFrame(currentFrame);
                    addLog(`Processed frame ${result.index}/${frameCount}, sharpness: ${result.sharpness.toFixed(2)}`);

                    completedFrames++;

                    // Emit updated frames for preview (less frequently)
                    if (result.index % 10 === 0 || result.index === frameCount - 1) {

                    	emit('update-loading', (completedFrames / frameCount) * 100);

                        const top4FrameBlobsPromise = Promise.all(top4Frames.map(f => renderFrameToBlob(previewCanvas, f.frameBuffer, header, bayerChoice)));
                        const worstFrameBlobPromise = worstFrame ? renderFrameToBlob(previewCanvas, worstFrame.frameBuffer, header, bayerChoice) : Promise.resolve(null);
                        
                        return Promise.all([top4FrameBlobsPromise, worstFrameBlobPromise])
                            .then(([top4FrameBlobs, worstFrameBlob]) => {
                                emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
                            });
                    }
                })
                .catch(error => {
                    addLog(`Error processing frame ${i}: ${error}`);
                    console.error(`Error processing frame ${i}:`, error);
                });
            workerPromises.push(promise);
        }
        
        // Wait for all worker tasks to complete
        await Promise.all(workerPromises);

        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.`);
        
        // Terminate workers after all tasks are done
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());

        // Now, convert the best frames for stacking to PNG blobs with color
        const pngBlobs = [];
        for (let i = 0; i < bestFramesForStacking.length; i++) {
            const frame = bestFramesForStacking[i];
            // Ensure frameBuffer is still valid or re-slice if needed
            const blob = await renderFrameToBlob(previewCanvas, frame.frameBuffer, header, bayerChoice);
            pngBlobs.push({ pngFile: [blob] });
        }

        await uploadFrames(pngBlobs);
    }

    return { readSerFile };
}
