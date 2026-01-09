
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

// These functions remain on the main thread as they are not performance bottlenecks
function parseSerHeader(buffer) {
    const view = new DataView(buffer);
    const le = true; // SER files are little-endian

    // Standard SER V3 header layout:
    // 0-13: FileID "LUCAM-RECORDER" (14 bytes)
    // 14-17: LuID (4 bytes) - camera ID
    // 18-21: ColorID (4 bytes) - color format (0=MONO, 8=RGGB, 9=GRBG, 10=GBRG, 11=BGGR)
    // 22-25: LittleEndian (4 bytes) - byte order indicator
    // 26-29: ImageWidth (4 bytes)
    // 30-33: ImageHeight (4 bytes)
    // 34-37: PixelDepthPerPlane (4 bytes) - bits per pixel (8, 10, 12, 14, 16)
    // 38-41: FrameCount (4 bytes)
    // 42-81: Observer (40 bytes)
    // 82-121: Instrument (40 bytes)
    // 122-161: Telescope (40 bytes)
    // 162-169: DateTime (8 bytes)
    // 170-177: DateTimeUTC (8 bytes)

    let h = {
        fileId: Array.from(new Uint8Array(buffer.slice(0, 14))).map(b => String.fromCharCode(b)).join(''),
        luId: view.getInt32(14, le),
        colorID: view.getInt32(18, le),
        littleEndian: view.getInt32(22, le),
        width: view.getInt32(26, le),
        height: view.getInt32(30, le),
        pixelDepth: view.getInt32(34, le),  // PixelDepthPerPlane - bits per pixel
        frameCount: view.getInt32(38, le),
        observer: Array.from(new Uint8Array(buffer.slice(42, 82))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        instrument: Array.from(new Uint8Array(buffer.slice(82, 122))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        telescope: Array.from(new Uint8Array(buffer.slice(122, 162))).map(b => String.fromCharCode(b)).join('').replace(/\0/g, ''),
        dateTime: view.getBigInt64(162, le),
        dateTimeUTC: view.getBigInt64(170, le)
    };

    // Sanity check: if values don't make sense, the file might have a non-standard layout
    if (h.width <= 0 || h.width > 10000 || h.height <= 0 || h.height > 10000) {
        console.warn('SER header values look invalid, file may be corrupted or non-standard');
    }

    // Ensure pixelDepth is sensible (common values: 8, 10, 12, 14, 16)
    if (h.pixelDepth <= 0 || h.pixelDepth > 16) {
        console.warn(`Unusual pixelDepth ${h.pixelDepth}, defaulting to 8`);
        h.pixelDepth = 8;
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
    let workersReady = false;

    // Initializes workers and ensures OpenCV is ready before processing
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
                        worker.onmessage = null; // Clear init listener
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

    // Function to process a frame with a worker
    function processFrameWithWorker(worker, data, transferables) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                reject(new Error(`Worker timeout for frame ${data.index}`));
            }, 30000); // 30 second timeout per frame

            const messageHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                if (e.data.error) {
                    reject(e.data.error);
                } else if (e.data.type === 'bounds') {
                    resolve({ type: 'bounds', bounds: e.data.bounds, index: e.data.index });
                } else if (e.data.skipped) {
                    // Frame was skipped (e.g., couldn't crop)
                    resolve({ skipped: true, reason: e.data.reason, index: e.data.index });
                } else {
                    resolve({ sharpness: e.data.sharpness, pngBlob: e.data.pngBlob, croppedBuffer: e.data.croppedBuffer, index: e.data.index });
                }
            };
            const errorHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            worker.postMessage(data, transferables);
        });
    }

    // Detect bounds for a sample of frames to determine crop region
    async function detectCropRegion(file, header, frameSize, frameCount, bayerChoice) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50)); // ~50 samples max
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        let maxX = 0, maxY = 0, maxSize = 0;
        let canCropCount = 0;
        const boundsPromises = [];

        const headerForWorker = {
            fileId: header.fileId,
            width: header.width,
            height: header.height,
            pixelDepth: header.pixelDepth,
            colorID: header.colorID
        };

        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];
            const offset = 178 + (i * frameSize);
            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();

            const workerIndex = idx % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const dataToWorker = {
                type: 'detect-bounds',
                frameBuffer: frameBuffer.slice(0),
                header: headerForWorker,
                bayerChoice: bayerChoice,
                index: idx
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.frameBuffer])
                .then(result => {
                    if (result.bounds && result.bounds.canCrop) {
                        canCropCount++;
                        // Track the maximum crop region needed
                        maxSize = Math.max(maxSize, result.bounds.size);
                    }
                    emit('update-loading', { progress: ((idx + 1) / sampleIndices.length) * 100, current: idx + 1, total: sampleIndices.length });
                })
                .catch(error => {
                    console.error(`Error detecting bounds for sample ${idx}:`, error);
                });

            boundsPromises.push(promise);
        }

        await Promise.all(boundsPromises);

        // Only need 50% of frames to be croppable (was 80%, but too strict for videos where planet moves near edges)
        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        // Add 10% margin to the max size and round up to even number
        let finalSize = Math.ceil(maxSize * 1.1 / 2) * 2;

        // Limit crop size to frame dimensions
        const maxAllowedSize = Math.min(header.width, header.height);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize };
    }

    async function readSerFile(file, maxFrames = -1, enableAutoCrop = false) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping SER processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        emit('start-loading', 'Reading file header');
        emit('update-loading', 0); // Initial progress

        const headerBuf = await file.slice(0, 178).arrayBuffer();
        const header = parseSerHeader(headerBuf);

        // Calculate bytes per pixel and frame size
        const bpp = header.pixelDepth > 8 ? 2 : 1;
        const frameSize = header.width * header.height * bpp;

        // Validate header against actual file size
        const expectedFileSize = 178 + (frameSize * header.frameCount);
        const actualFrameCount = Math.floor((file.size - 178) / frameSize);

        addLog(`SER Header: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit, colorID=${header.colorID}`);

        // Use calculated frame count if header value seems wrong
        if (actualFrameCount !== header.frameCount) {
            addLog(`Warning: Header says ${header.frameCount} frames, but file size suggests ${actualFrameCount} frames. Using calculated value.`);
            header.frameCount = actualFrameCount;
        }

        // Determine initial bayer choice from header for auto-detection hint
        // Using BGR output variants because we later convert BGR->RGBA
        const bayerMap = { 0: "MONO", 8: "COLOR_BayerRG2BGR", 9: "COLOR_BayerGR2BGR", 10: "COLOR_BayerGB2BGR", 11: "COLOR_BayerBG2BGR" };
        let autoDetectedProfile = bayerMap[header.colorID];
        if (!autoDetectedProfile) {
            autoDetectedProfile = "COLOR_BayerRG2BGR";
        }

        // Show color profile selector with thumbnails of first frame
        const firstFrameBuffer = await file.slice(178, 178 + frameSize).arrayBuffer();

        emit('set-caption', 'Select color profile');

        // Wait for user to select a color profile
        const bayerChoice = await new Promise((resolve) => {
            emit('show-color-profile-selector', {
                frameBuffer: firstFrameBuffer,
                header: header,
                autoDetectedProfile: autoDetectedProfile,
                resolve: resolve
            });
        });

        addLog(`User selected color profile: ${bayerChoice}`);

        emit('set-caption', 'Importing and analyzing frames');

        const frameCount = (maxFrames === -1) ? header.frameCount : Math.min(header.frameCount, maxFrames);

        // Determine if we should auto-crop (only for frames larger than minimum)
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;
        let croppedFrameBuffers = []; // Store cropped raw data for SER export

        if (enableAutoCrop && header.width >= MIN_SIZE_FOR_CROP && header.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${header.width}x${header.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegion(file, header, frameSize, frameCount, bayerChoice);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop) {
            addLog(`Frame size ${header.width}x${header.height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.floor(frameCount * 0.3);
        const bestFramesForStacking = []; // These will store {sharpness, blob, croppedBuffer}
        let top4Frames = []; // These will store {sharpness, blob}
        let worstFrame = null; // This will store {sharpness, blob}

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
        let skippedFrames = 0;
        let errorCount = 0;
        const maxConsecutiveErrors = 10;

        for (let i = 0; i < frameCount; i++) {
            // Stop if too many errors
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors. Check console for details.`);
                break;
            }
            const offset = 178 + (i * frameSize);
            if (offset + frameSize > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();

            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const headerForWorker = {
                fileId: header.fileId,
                width: header.width,
                height: header.height,
                pixelDepth: header.pixelDepth,
                colorID: header.colorID
            };

            // Use analyze-cropped type if we have a crop region, otherwise regular ser type
            const dataToWorker = {
                type: cropRegion ? 'analyze-cropped' : 'ser',
                frameBuffer: frameBuffer.slice(0),
                header: headerForWorker,
                bayerChoice: bayerChoice,
                cropRegion: cropRegion,
                index: i
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.frameBuffer])
                .then(result => {
                    errorCount = 0; // Reset on success

                    // Skip frames that couldn't be cropped (when in crop mode)
                    if (result.skipped) {
                        skippedFrames++;
                        completedFrames++;
                        if (result.index % 10 === 0) {
                            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                            emit('crop-stats-updated', { skipped: skippedFrames, total: completedFrames });
                        }
                        return;
                    }

                    // Worker returns pngBlob directly, use it instead of re-rendering
                    const currentFrame = {
                        sharpness: result.sharpness,
                        blob: result.pngBlob,
                        croppedBuffer: result.croppedBuffer,
                        index: result.index
                    };
                    rankFrame(currentFrame);

                    // Store cropped buffer for SER export if available
                    if (result.croppedBuffer) {
                        croppedFrameBuffers[result.index] = result.croppedBuffer;
                    }

                    completedFrames++;

                    // Emit updated frames for preview (less frequently)
                    if (result.index % 10 === 0 || result.index === frameCount - 1) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                        addLog(`Analyzed frame ${completedFrames}/${frameCount}`);

                        // Use blobs directly from ranked frames - filter out any without blobs
                        const top4FrameBlobs = top4Frames.filter(f => f && f.blob).map(f => f.blob);
                        const worstFrameBlob = worstFrame?.blob || null;

                        emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
                    }
                })
                .catch(error => {
                    errorCount++;
                    addLog(`Error processing frame ${i}: ${error}`);
                    console.error(`Error processing frame ${i}:`, error);
                });
            workerPromises.push(promise);
        }

        // Wait for all worker tasks to complete
        await Promise.all(workerPromises);

        const skippedMsg = skippedFrames > 0 ? ` (${skippedFrames} skipped - couldn't crop)` : '';
        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, total: frameCount, done: true });

        // Terminate workers after all tasks are done
        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());

        // Offer cropped SER download if we did cropping - available immediately before upload
        if (cropRegion && croppedFrameBuffers.length > 0) {
            const validFrameCount = croppedFrameBuffers.filter(b => b).length;
            const croppedSerBlob = createCroppedSerFile(header, cropRegion, croppedFrameBuffers);
            emit('cropped-ser-ready', {
                blob: croppedSerBlob,
                filename: file.name.replace('.ser', '_cropped.ser'),
                cropSize: cropRegion.size,
                frameCount: validFrameCount
            });
            addLog(`Cropped SER ready: ${cropRegion.size}x${cropRegion.size}, ${validFrameCount} frames - download available now`);
            emit('set-caption', 'Cropped SER ready for download');
        }

        emit('set-caption', 'Uploading best frames for stacking...');

        // Blobs are already available from worker processing, no need to re-render
        const pngBlobs = bestFramesForStacking.map(f => ({ pngFile: [f.blob] }));

        await uploadFrames(pngBlobs);
    }

    // Create a SER file from cropped frame buffers
    function createCroppedSerFile(originalHeader, cropRegion, frameBuffers) {
        const validFrames = frameBuffers.filter(b => b);
        const frameCount = validFrames.length;
        const bpp = originalHeader.pixelDepth > 8 ? 2 : 1;
        const croppedFrameSize = cropRegion.size * cropRegion.size * bpp;

        // SER header is 178 bytes
        const totalSize = 178 + (croppedFrameSize * frameCount);
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);

        // Write SER header (little-endian)
        // File ID: "LUCAM-RECORDER" (14 bytes)
        const fileId = "LUCAM-RECORDER";
        for (let i = 0; i < 14; i++) {
            uint8[i] = fileId.charCodeAt(i);
        }

        // LuID (4 bytes) - camera ID
        view.setInt32(14, 0, true);

        // Color ID (4 bytes) - same as original
        view.setInt32(18, originalHeader.colorID, true);

        // Little endian (4 bytes) - 0 = big endian, otherwise little
        view.setInt32(22, 0, true);

        // Image width (4 bytes)
        view.setInt32(26, cropRegion.size, true);

        // Image height (4 bytes)
        view.setInt32(30, cropRegion.size, true);

        // Pixel depth per plane (4 bytes)
        view.setInt32(34, originalHeader.pixelDepth, true);

        // Frame count (4 bytes)
        view.setInt32(38, frameCount, true);

        // Observer (40 bytes) - leave empty
        // Instrument (40 bytes) - leave empty
        // Telescope (40 bytes) - leave empty
        // DateTime (8 bytes) - leave as 0
        // DateTime UTC (8 bytes) - leave as 0

        // Write frame data
        let offset = 178;
        for (const frameBuffer of validFrames) {
            uint8.set(new Uint8Array(frameBuffer), offset);
            offset += croppedFrameSize;
        }

        return new Blob([buffer], { type: 'application/octet-stream' });
    }

    return { readSerFile };
}
