// composables/useAviReader.js

import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

/**
 * Determines if an AVI FourCC represents an "easy" (uncompressed/raw) format.
 * @param {string} fourCC The FourCC code.
 * @returns {boolean} True if easy, false otherwise.
 */
function isEasyAviFourCC(fourCC) {
    if (!fourCC) return false;
    const easyFourCCs = ['DIB ', 'Y800', 'YUY2', 'UYVY', 'RGB ', 'RAW ']; // 'RGB ' and 'RAW ' are sometimes used
    return easyFourCCs.includes(fourCC.toUpperCase());
}


// This function will be called on the main thread for preview rendering and final PNG generation
// It needs to convert raw AVI frame data (DIB, Y800, YUY2) into an 8-bit PNG blob using OpenCV.js.
async function renderAviFrameToBlob(canvas, frameDataBuffer, aviHeader, fourCC, bayerChoice) {
    // Check if cv is available in the global scope
    if (typeof cv === 'undefined') {
        console.error("OpenCV.js (cv) not loaded for renderAviFrameToBlob.");
        return null;
    }

    const { width, height } = aviHeader;

    // Create Mat from raw frameDataBuffer based on FourCC
    let mat;
    if (fourCC === 'DIB ' || fourCC === 'RGB ') { // Raw RGB24 - DIB is often BGR
        mat = new cv.Mat(height, width, cv.CV_8UC3);
        mat.data.set(new Uint8Array(frameDataBuffer));
    } else if (fourCC === 'Y800') { // 8-bit Greyscale / Raw Bayer
        mat = new cv.Mat(height, width, cv.CV_8UC1);
        mat.data.set(new Uint8Array(frameDataBuffer));
    } else if (fourCC === 'YUY2' || fourCC === 'UYVY') { // YUV 4:2:2 Packed
        mat = new cv.Mat(height, width, cv.CV_8UC2);
        mat.data.set(new Uint8Array(frameDataBuffer));
    } else {
        console.error(`Unsupported FourCC for direct AVI rendering: ${fourCC}`);
        return null;
    }

    // Convert to BGR/RGBA for consistent processing
    let displayMat;
    if (fourCC === 'DIB ' || fourCC === 'RGB ') { // Already 3-channel BGR
        displayMat = mat;
    } else if (fourCC === 'Y800') {
        if (bayerChoice && bayerChoice !== "MONO" && cv[bayerChoice]) {
             displayMat = new cv.Mat();
             cv.demosaicing(mat, displayMat, cv[bayerChoice]); // Demosaic to BGR
        } else {
            displayMat = new cv.Mat();
            cv.cvtColor(mat, displayMat, cv.COLOR_GRAY2BGR); // Convert grayscale to BGR
        }
    } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
        displayMat = new cv.Mat();
        cv.cvtColor(mat, displayMat, cv.COLOR_YUV2BGR_YUYV); // Convert YUY2 to BGR
    }

    // Convert BGR to RGBA for canvas
    let rgbaMat = new cv.Mat();
    cv.cvtColor(displayMat, rgbaMat, cv.COLOR_BGR2RGBA);
    
    // Auto-Stretch and Show (optional, but consistent with SER)
    let stretched = new cv.Mat();
    cv.normalize(rgbaMat, stretched, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
    
    canvas.width = width;
    canvas.height = height;
    cv.imshow(canvas, stretched);
    
    // Cleanup
    const matsToDelete = new Set([mat, displayMat, rgbaMat, stretched]);
    matsToDelete.forEach(m => {
        // Check if the mat exists and has not been deleted already
        if (m && !m.isDeleted()) {
            m.delete();
        }
    });

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

export function useAviReader() {
    const { addLog, emit } = useEventBus();
    const { uploadFrames } = useUploader();

    const previewCanvas = document.createElement('canvas');

    const numWorkers = navigator.hardwareConcurrency || 4;
    const unifiedAnalyzeWorkers = [];
    let workersReady = false;

    // Initializes workers and ensures OpenCV is ready before processing
    async function initializeWorkers() {
        if (workersReady) return;
        addLog("Initializing analysis workers...");

        for (let i = 0; i < numWorkers; i++) {
            unifiedAnalyzeWorkers.push(new Worker('/unified_analyze_worker.js?v=20260110'));
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
            // Handle cleanup of created workers if necessary
            unifiedAnalyzeWorkers.forEach(w => w.terminate());
            unifiedAnalyzeWorkers.length = 0;
        }
    }

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
                    // Worker now returns sharpness and the processed pngBlob
                    resolve({ sharpness: e.data.sharpness, pngBlob: e.data.pngBlob, index: e.data.index });
                }
            };
            const errorHandler = (e) => {
                clearTimeout(timeout);
                worker.removeEventListener('error', errorHandler);
                reject(e);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            worker.postMessage(data, transferables);
        });
    }

    // Detect bounds for a sample of frames to determine crop region
    async function detectCropRegion(file, aviHeader, frameCount) {
        emit('set-caption', 'Detecting planet position...');
        emit('update-loading', { progress: 0, current: 0, total: frameCount });

        // Sample every Nth frame for faster detection
        const sampleInterval = Math.max(1, Math.floor(frameCount / 50)); // ~50 samples max
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        let maxSize = 0;
        let canCropCount = 0;
        const boundsPromises = [];

        const headerForWorker = {
            width: aviHeader.width,
            height: aviHeader.height,
            fourCC: aviHeader.fourCC,
            bpp: aviHeader.bpp
        };

        // Calculate frame positions
        const frameChunkHeaderSize = 8;
        const frameDataLength = aviHeader.frameDataSize;

        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];
            const frameOffset = aviHeader.moviListOffset + i * (frameChunkHeaderSize + frameDataLength + (frameDataLength % 2));
            const frameDataStart = frameOffset + frameChunkHeaderSize;

            if (frameDataStart + frameDataLength > file.size) break;

            const frameBuffer = await file.slice(frameDataStart, frameDataStart + frameDataLength).arrayBuffer();

            const workerIndex = idx % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const dataToWorker = {
                type: 'detect-bounds',
                frameBuffer: frameBuffer.slice(0),
                header: headerForWorker,
                bayerChoice: aviHeader.bayerChoice,
                index: idx
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.frameBuffer])
                .then(result => {
                    if (result.bounds && result.bounds.canCrop) {
                        canCropCount++;
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
        const maxAllowedSize = Math.min(aviHeader.width, aviHeader.height);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize };
    }

    // Robust AVI header parser
    async function parseFullAviHeader(buffer) {
        const view = new DataView(buffer);
        const readFourCC = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
        
        addLog("Starting AVI header parsing...");

        try {
            if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'AVI ') {
                addLog("File is not a valid RIFF AVI file.");
                throw new Error('Not a valid AVI file');
            }
            addLog("File identified as RIFF AVI.");

            let offset = 12;
            const fileEnd = buffer.byteLength;

            let avihData = null;
            let strhData = null;
            let strfData = null;
            let moviListOffset = -1;
            let moviListSize = -1;

            addLog("Scanning for RIFF chunks...");
            while (offset < fileEnd - 8) {
                const chunkId = readFourCC(view, offset);
                let chunkSize = view.getUint32(offset + 4, true);
                const chunkDataOffset = offset + 8;
                addLog(`Found chunk '${chunkId}' at offset ${offset} with size ${chunkSize}`);

                if (chunkId === 'LIST') {
                    const listType = readFourCC(view, chunkDataOffset);
                    addLog(`  - It's a LIST chunk with type '${listType}'`);
                    if (listType === 'hdrl') {
                        let hdrlOffset = chunkDataOffset + 4;
                        let videoStreamFound = false;
                        addLog("  - Parsing 'hdrl' list...");
                        while (hdrlOffset < chunkDataOffset + chunkSize - 4) {
                            const subChunkId = readFourCC(view, hdrlOffset);
                            const subChunkSize = view.getUint32(hdrlOffset + 4, true);
                            const subChunkPaddedSize = (subChunkSize + 1) & ~1;
                            addLog(`    - Found sub-chunk '${subChunkId}' of size ${subChunkSize}`);

                            if (subChunkId === 'avih') {
                                avihData = { offset: hdrlOffset + 8, size: subChunkSize };
                                addLog("      - Found 'avih' chunk.");
                            } else if (subChunkId === 'LIST' && readFourCC(view, hdrlOffset + 8) === 'strl') {
                                addLog("      - Found 'strl' list.");
                                if (!videoStreamFound) {
                                    let streamOffset = hdrlOffset + 12;
                                    while (streamOffset < hdrlOffset + 8 + subChunkSize) {
                                        const streamChunkId = readFourCC(view, streamOffset);
                                        const streamChunkSize = view.getUint32(streamOffset + 4, true);
                                        const streamChunkPaddedSize = (streamChunkSize + 1) & ~1;

                                        if (streamChunkId === 'strh' && readFourCC(view, streamOffset + 8) === 'vids') {
                                            videoStreamFound = true;
                                            strhData = { offset: streamOffset + 8, size: streamChunkSize };
                                            addLog("        - Found video 'strh' chunk.");
                                        } else if (streamChunkId === 'strf' && videoStreamFound && !strfData) {
                                            strfData = { offset: streamOffset + 8, size: streamChunkSize };
                                            addLog("        - Found video 'strf' chunk.");
                                        }
                                        streamOffset += 8 + streamChunkPaddedSize;
                                    }
                                }
                            }
                            hdrlOffset += 8 + subChunkPaddedSize;
                        }
                    } else if (listType === 'movi') {
                        moviListOffset = chunkDataOffset + 4;
                        moviListSize = chunkSize - 4;
                        addLog(`  - Found 'movi' list at offset ${moviListOffset}.`);
                    }
                }
                const chunkPaddedSize = (chunkSize + 1) & ~1;
                offset += 8 + chunkPaddedSize;
            }

            addLog("Finished scanning chunks. Verifying header data...");
            if (!avihData || !strhData || !strfData) {
                addLog(`Missing critical chunks: avih=${!!avihData}, strh=${!!strhData}, strf=${!!strfData}`);
                throw new Error("Missing critical AVI header chunks (avih, strh, or strf).");
            }
            addLog("All critical header chunks found.");

            let frameCount = view.getUint32(avihData.offset + 16, true);
            if (frameCount === 0) {
                frameCount = view.getUint32(strhData.offset + 32, true); // Fallback to dwLength from stream header
                addLog(`Frame count from avih was 0, using count from strh: ${frameCount}`);
            }

            const width = view.getUint32(strfData.offset + 4, true);
            const height = Math.abs(view.getInt32(strfData.offset + 8, true));
            const bpp = view.getUint16(strfData.offset + 14, true);

            const compression = readFourCC(view, strfData.offset + 16);
            const isCompressionNull = compression.charCodeAt(0) === 0 && compression.charCodeAt(1) === 0 && compression.charCodeAt(2) === 0 && compression.charCodeAt(3) === 0;
            let fourCC = isCompressionNull ? readFourCC(view, strhData.offset + 4) : compression;
            addLog(`Determined FourCC: '${fourCC}' (compression: '${compression}', handler: '${readFourCC(view, strhData.offset + 4)}')`);

            if (!width || !height || !frameCount || !fourCC || moviListOffset === -1) {
                addLog(`Incomplete header info: w=${width}, h=${height}, f=${frameCount}, fourCC='${fourCC}', movi=${moviListOffset}`);
                throw new Error(`Incomplete AVI header info`);
            }

            addLog("Header parsed successfully. Calculating frame data size...");
            let frameDataSize = 0;
            if (fourCC === 'DIB ' || fourCC === 'RGB ') {
                frameDataSize = width * height * (bpp / 8);
            } else if (fourCC === 'Y800') {
                frameDataSize = width * height;
            } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
                frameDataSize = width * height * 2;
            } else {
                // Unsupported FourCC - return header anyway so caller can decide to fallback
                addLog(`FourCC '${fourCC}' is compressed/unsupported for direct rendering.`);
                frameDataSize = -1; // Signal that frame size is unknown
            }
            if (frameDataSize > 0) {
                addLog(`Calculated frameDataSize: ${frameDataSize}`);
            }

            let bayerChoice = "MONO";
            if (fourCC === 'Y800' && (width % 2 === 0 && height % 2 === 0)) {
                bayerChoice = 'COLOR_BayerRG2RGB';
            }

            const result = { width, height, frameCount, fourCC, frameDataSize, bpp, bayerChoice, moviListOffset, moviListSize };
            addLog(`Final parsed header: ${JSON.stringify(result)}`);
            return result;

        } catch (e) {
            addLog(`[ERROR] in parseFullAviHeader: ${e.message}`);
            console.error("Error parsing full AVI header:", e);
            return null;
        }
    }


    async function readAviFile(file, maxFrames = -1, enableAutoCrop = false, preloadedBuffer = null) {
        emit('start-loading', 'Parsing AVI header...');
        emit('update-loading', 0);

        // Use preloaded buffer if provided, otherwise read from file
        let headerBuffer;
        if (preloadedBuffer) {
            const headerProbeSize = Math.min(preloadedBuffer.byteLength, 1024 * 1024 * 5);
            headerBuffer = preloadedBuffer.buffer.slice(0, headerProbeSize);
        } else {
            const headerProbeSize = Math.min(file.size, 1024 * 1024 * 5);
            headerBuffer = await file.slice(0, headerProbeSize).arrayBuffer();
        }
        const aviHeader = await parseFullAviHeader(headerBuffer);

        if (!aviHeader) {
            addLog(`Failed to parse AVI header for ${file.name}.`);
            emit('upload-error', `Failed to parse AVI header for ${file.name}. File may be corrupt.`);
            emit('stop-loading');
            return; // Stop processing
        }

        // Check format BEFORE initializing workers to avoid wasting memory on fallback
        if (!isEasyAviFourCC(aviHeader.fourCC)) {
            addLog(`AVI format '${aviHeader.fourCC || 'unknown'}' is not supported for direct processing.`);
            return 'fallback';
        }

        // Only initialize workers after we know we can process this format
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping AVI processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        addLog(`Easy AVI detected. Header: ${aviHeader.width}x${aviHeader.height}, ${aviHeader.frameCount} frames, FourCC: ${aviHeader.fourCC}, FrameSize: ${aviHeader.frameDataSize} bytes.`);

        const frameCount = (maxFrames === -1) ? aviHeader.frameCount : Math.min(aviHeader.frameCount, maxFrames);

        // Determine if we should auto-crop (only for frames larger than minimum)
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (enableAutoCrop && aviHeader.width >= MIN_SIZE_FOR_CROP && aviHeader.height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${aviHeader.width}x${aviHeader.height} qualifies for auto-crop`);
            cropRegion = await detectCropRegion(file, aviHeader, frameCount);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop) {
            addLog(`Frame size ${aviHeader.width}x${aviHeader.height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.floor(frameCount * 0.3);
        const bestFramesForStacking = []; // These will store {sharpness, blob} (8-bit PNG)
        let top4Frames = []; // These will store {sharpness, blob} (8-bit PNG)
        let worstFrame = null; // This will store {sharpness, blob} (8-bit PNG)

        function rankFrame(frame) { // frame is {sharpness, blob}
            // Higher Tenengrad sharpness = better (sharper edges)
            if (top4Frames.length < 4) {
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness); // Descending: highest first
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
        let skippedFrames = 0;
        let errorCount = 0;
        const maxConsecutiveErrors = 10;

        // Loop through frames from moviListOffset
        let currentMoviOffset = aviHeader.moviListOffset;
        for (let i = 0; i < frameCount; i++) {
            // Stop if too many errors
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors. Check console for details.`);
                break;
            }

            // In AVI, frames are often preceded by a 4-byte chunk type and 4-byte size.
            // For uncompressed, the chunk type is usually '00dc' or '01wb'.
            // For now, assume fixed frameDataSize, and skip chunk headers if present.
            // A robust parser would read the chunk header for each frame.
            const frameChunkHeaderSize = 8; // Assuming 4-byte type + 4-byte size for '00dc' or '01wb'
            const frameOffset = currentMoviOffset; // This is the start of the 'xxdb' or 'xxwb' chunk
            const frameDataStart = frameOffset + frameChunkHeaderSize; // Actual frame data starts after its chunk header
            const frameDataLength = aviHeader.frameDataSize; // Assuming fixed size from header

            if (frameDataStart + frameDataLength > file.size) {
                 addLog(`Stopping at frame ${i} due to reaching end of file.`);
                 break;
            }

            // Read the data part of the frame chunk
            const frameBuffer = await file.slice(frameDataStart, frameDataStart + frameDataLength).arrayBuffer();

            const workerIndex = i % numWorkers;
            const worker = unifiedAnalyzeWorkers[workerIndex];

            const headerForWorker = {
                width: aviHeader.width,
                height: aviHeader.height,
                fourCC: aviHeader.fourCC,
                bpp: aviHeader.bpp
            };

            // Use analyze-cropped type if we have a crop region, otherwise regular avi type
            const dataToWorker = {
                type: cropRegion ? 'analyze-cropped' : 'avi',
                frameBuffer: frameBuffer.slice(0), // Copy for transfer
                aviHeader: { ...aviHeader }, // Pass necessary header info (copy to be transferable)
                header: headerForWorker, // For analyze-cropped compatibility
                bayerChoice: aviHeader.bayerChoice, // For Y800 demosaicing
                cropRegion: cropRegion,
                index: i
            };

            const promise = processFrameWithWorker(worker, dataToWorker, [dataToWorker.frameBuffer])
                .then(async (result) => {
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

                    // Worker returns pngBlob directly
                    const currentFrame = { sharpness: result.sharpness, blob: result.pngBlob };
                    rankFrame(currentFrame);

                    completedFrames++;

                    if (result.index % 10 === 0 || result.index === frameCount - 1) {
                        emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
                        addLog(`Analyzed frame ${completedFrames}/${frameCount}`);

                        // Filter out any frames without valid blobs
                        const top4FrameBlobs = top4Frames.filter(f => f && f.blob).map(f => f.blob);
                        const worstFrameBlob = worstFrame?.blob || null;

                        emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
                    }
                })
                .catch(error => {
                    errorCount++;
                    addLog(`Error processing AVI frame ${i}: ${error}`);
                    console.error(`Error processing AVI frame ${i}:`, error);
                });
            workerPromises.push(promise);

            currentMoviOffset += frameChunkHeaderSize + frameDataLength; // Move to next chunk
            if (frameDataLength % 2 !== 0) currentMoviOffset++; // Pad if odd size
        }

        await Promise.all(workerPromises);

        const skippedMsg = skippedFrames > 0 ? ` (${skippedFrames} skipped - couldn't crop)` : '';
        addLog(`Finished analyzing ${frameCount} AVI frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, total: frameCount, done: true });

        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());

        emit('set-caption', 'Uploading best frames for stacking...');

        const pngBlobsForUpload = bestFramesForStacking.map(f => ({ pngFile: [f.blob] }));
        await uploadFrames(pngBlobsForUpload);
    }

    // Process FFmpeg-extracted PNG frames through the same pipeline as AVI
    async function processFFmpegFrames(ffmpeg, pngFilenames, enableAutoCrop = false) {
        await initializeWorkers();

        if (!workersReady) {
            addLog("Stopping FFmpeg processing due to worker initialization failure.");
            emit('stop-loading');
            return;
        }

        addLog(`Processing ${pngFilenames.length} FFmpeg-extracted frames`);
        emit('set-caption', 'Decoding frames...');

        // Decode first PNG to get dimensions
        const firstPngData = ffmpeg.FS('readFile', pngFilenames[0]);
        const firstBlob = new Blob([firstPngData], { type: 'image/png' });
        const firstBitmap = await createImageBitmap(firstBlob);
        const width = firstBitmap.width;
        const height = firstBitmap.height;
        firstBitmap.close();

        addLog(`Frame dimensions: ${width}x${height}`);

        // Create a virtual header for RGBA frames
        const header = {
            width,
            height,
            fourCC: 'RGBA',
            bpp: 32
        };

        const frameCount = pngFilenames.length;

        // Determine if we should auto-crop
        const MIN_SIZE_FOR_CROP = 300;
        let cropRegion = null;

        if (enableAutoCrop && width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
            addLog(`Frame size ${width}x${height} qualifies for auto-crop`);
            cropRegion = await detectCropRegionFromPngs(ffmpeg, pngFilenames, header);

            if (cropRegion) {
                addLog(`Will crop frames to ${cropRegion.size}x${cropRegion.size}`);
            }
        } else if (enableAutoCrop) {
            addLog(`Frame size ${width}x${height} too small for auto-crop (min ${MIN_SIZE_FOR_CROP}x${MIN_SIZE_FOR_CROP})`);
        }

        emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

        const bestFramesCapacity = Math.floor(frameCount * 0.3);
        const bestFramesForStacking = [];
        let top4Frames = [];
        let worstFrame = null;

        function rankFrame(frame, frameIndex) {
            // Store the frame index on the frame object for tracking
            frame.frameIndex = frameIndex;

            // Higher Tenengrad sharpness = better (sharper edges)
            if (top4Frames.length < 4) {
                top4Frames.push(frame);
                top4Frames.sort((a, b) => b.sharpness - a.sharpness); // Descending: highest first
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

        let completedFrames = 0;
        let skippedFrames = 0;
        let errorCount = 0;
        const maxConsecutiveErrors = 10;

        // Canvas for decoding PNGs to RGBA
        const decodeCanvas = document.createElement('canvas');
        decodeCanvas.width = width;
        decodeCanvas.height = height;
        const decodeCtx = decodeCanvas.getContext('2d');

        // Process in batches to limit memory usage
        const batchSize = numWorkers;

        for (let batchStart = 0; batchStart < frameCount; batchStart += batchSize) {
            if (errorCount >= maxConsecutiveErrors) {
                addLog(`Stopping due to ${errorCount} consecutive errors.`);
                break;
            }

            const batchEnd = Math.min(batchStart + batchSize, frameCount);
            const batchPromises = [];

            for (let i = batchStart; i < batchEnd; i++) {
                // Read and decode PNG to RGBA
                const pngData = ffmpeg.FS('readFile', pngFilenames[i]);
                ffmpeg.FS('unlink', pngFilenames[i]); // Free memory as we go

                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, width, height);
                const rgbaBuffer = imageData.data.buffer.slice(0); // Copy for transfer

                // Clear canvas to help GC
                decodeCtx.clearRect(0, 0, width, height);

                const workerIndex = i % numWorkers;
                const worker = unifiedAnalyzeWorkers[workerIndex];

                const dataToWorker = {
                    type: cropRegion ? 'analyze-cropped' : 'avi',
                    frameBuffer: rgbaBuffer,
                    aviHeader: header,
                    header: header,
                    bayerChoice: 'MONO',
                    cropRegion: cropRegion,
                    index: i
                };

                const promise = processFrameWithWorker(worker, dataToWorker, [rgbaBuffer])
                    .then(async (result) => {
                        errorCount = 0;

                        if (result.skipped) {
                            skippedFrames++;
                            completedFrames++;
                            return;
                        }

                        const currentFrame = { sharpness: result.sharpness, blob: result.pngBlob };
                        rankFrame(currentFrame, result.index);

                        completedFrames++;
                    })
                    .catch(error => {
                        errorCount++;
                        addLog(`Error processing frame ${i}: ${error}`);
                        console.error(`Error processing frame ${i}:`, error);
                    });
                batchPromises.push(promise);
            }

            // Wait for batch to complete before starting next
            await Promise.all(batchPromises);

            // Update UI after each batch
            emit('update-loading', { progress: (completedFrames / frameCount) * 100, current: completedFrames, total: frameCount });
            if (completedFrames % 50 === 0 || batchEnd === frameCount) {
                addLog(`Analyzed frame ${completedFrames}/${frameCount}`);
                emit('crop-stats-updated', { skipped: skippedFrames, total: completedFrames });

                const top4FrameBlobs = top4Frames.filter(f => f && f.blob).map(f => f.blob);
                const worstFrameBlob = worstFrame?.blob || null;
                emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
            }
        }

        const skippedMsg = skippedFrames > 0 ? ` (${skippedFrames} skipped - couldn't crop)` : '';
        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.${skippedMsg}`);
        emit('crop-stats-updated', { skipped: skippedFrames, total: frameCount, done: true });


        unifiedAnalyzeWorkers.forEach(worker => worker.terminate());

        emit('set-caption', 'Uploading best frames for stacking...');

        const pngBlobsForUpload = bestFramesForStacking.map(f => ({ pngFile: [f.blob] }));
        await uploadFrames(pngBlobsForUpload);
    }

    // Detect crop region from PNG frames
    async function detectCropRegionFromPngs(ffmpeg, pngFilenames, header) {
        emit('set-caption', 'Detecting planet position...');

        const frameCount = pngFilenames.length;
        // Sample fewer frames for large videos to save memory
        const maxSamples = 20;
        const sampleInterval = Math.max(1, Math.floor(frameCount / maxSamples));
        const sampleIndices = [];
        for (let i = 0; i < frameCount; i += sampleInterval) {
            sampleIndices.push(i);
        }

        addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);

        // Canvas for decoding
        const decodeCanvas = document.createElement('canvas');
        decodeCanvas.width = header.width;
        decodeCanvas.height = header.height;
        const decodeCtx = decodeCanvas.getContext('2d');

        let maxSize = 0;
        let canCropCount = 0;

        // Process sequentially to limit memory usage
        for (let idx = 0; idx < sampleIndices.length; idx++) {
            const i = sampleIndices[idx];

            try {
                // Read and decode PNG
                const pngData = ffmpeg.FS('readFile', pngFilenames[i]);
                const blob = new Blob([pngData], { type: 'image/png' });
                const bitmap = await createImageBitmap(blob);
                decodeCtx.drawImage(bitmap, 0, 0);
                bitmap.close();

                const imageData = decodeCtx.getImageData(0, 0, header.width, header.height);
                const rgbaBuffer = imageData.data.buffer.slice(0);

                const workerIndex = idx % numWorkers;
                const worker = unifiedAnalyzeWorkers[workerIndex];

                const dataToWorker = {
                    type: 'detect-bounds',
                    frameBuffer: rgbaBuffer,
                    header: header,
                    bayerChoice: 'MONO',
                    index: idx
                };

                // Wait for each frame to complete before moving to next (sequential processing)
                const result = await processFrameWithWorker(worker, dataToWorker, [rgbaBuffer]);

                if (result.bounds && result.bounds.canCrop) {
                    canCropCount++;
                    maxSize = Math.max(maxSize, result.bounds.size);
                } else if (result.bounds) {
                    console.log(`Frame ${i} can't crop: ${result.bounds.reason || 'unknown'}`);
                }

                // Clear canvas to help GC
                decodeCtx.clearRect(0, 0, header.width, header.height);

            } catch (error) {
                console.error(`Error detecting bounds for sample ${idx}:`, error);
            }

            emit('update-loading', { progress: ((idx + 1) / sampleIndices.length) * 100, current: idx + 1, total: sampleIndices.length });
        }

        // Only need 50% of frames to be croppable (was 80%, but too strict for videos where planet moves near edges)
        const cropThreshold = sampleIndices.length * 0.5;
        if (canCropCount < cropThreshold) {
            addLog(`Only ${canCropCount}/${sampleIndices.length} frames can be cropped. Skipping auto-crop.`);
            return null;
        }

        let finalSize = Math.ceil(maxSize * 1.1 / 2) * 2;

        const maxAllowedSize = Math.min(header.width, header.height);
        if (finalSize > maxAllowedSize) {
            addLog(`Crop size ${finalSize} exceeds frame size ${maxAllowedSize}, skipping auto-crop`);
            return null;
        }

        addLog(`Detected crop size: ${finalSize}x${finalSize} (${canCropCount}/${sampleIndices.length} frames croppable)`);

        return { size: finalSize };
    }

    // Quick format check - only parses header, doesn't initialize workers
    async function checkAviFormat(headerBuffer) {
        const aviHeader = await parseFullAviHeader(headerBuffer);

        if (!aviHeader) {
            return { isEasy: false, fourCC: 'unknown', error: 'Failed to parse header' };
        }

        const isEasy = isEasyAviFourCC(aviHeader.fourCC);
        return {
            isEasy,
            fourCC: aviHeader.fourCC,
            width: aviHeader.width,
            height: aviHeader.height,
            frameCount: aviHeader.frameCount
        };
    }

    return { readAviFile, processFFmpegFrames, checkAviFormat };
}
