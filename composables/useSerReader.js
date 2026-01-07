
import { useEventBus } from '@/composables/eventBus';
import { useUploader } from '@/composables/useUploader';

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

function calculateSharpness(imageData) {
	const width = imageData.width;
	const height = imageData.height;
	const grey = new Uint8ClampedArray(width * height);
	const kernelX = [
		[-1, 0, 1],
		[-2, 0, 2],
		[-1, 0, 1],
	];
	const kernelY = [
		[-1, -2, -1],
		[0, 0, 0],
		[1, 2, 1],
	];

	// Convert to greyscale
	for (let i = 0; i < grey.length; i++) {
		const offset = i * 4;
		grey[i] = 0.3 * imageData.data[offset] + 0.59 * imageData.data[offset + 1] + 0.11 * imageData.data[offset + 2];
	}

	// Apply Sobel kernel
	const gradX = new Float32Array(width * height);
	const gradY = new Float32Array(width * height);
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			let sumX = 0;
			let sumY = 0;
			for (let ky = -1; ky <= 1; ky++) {
				for (let kx = -1; kx <= 1; kx++) {
					const pixel = grey[(y + ky) * width + (x + kx)];
					sumX += pixel * kernelX[ky + 1][kx + 1];
					sumY += pixel * kernelY[ky + 1][kx + 1];
				}
			}
			gradX[y * width + x] = sumX;
			gradY[y * width + x] = sumY;
		}
	}

	// Calculate gradient magnitude
	let sum = 0;
	for (let i = 0; i < gradX.length; i++) {
		sum += Math.sqrt(gradX[i] ** 2 + gradY[i] ** 2);
	}
	const avgGradient = sum / gradX.length;

	return avgGradient;
}

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

    async function readSerFile(file, maxFrames = -1, bayerPattern = 'AUTO') {
        emit('start-loading', 'Importing and analyzing frames');

        const headerBuf = await file.slice(0, 178).arrayBuffer();
        const header = parseSerHeader(headerBuf);
        
        addLog(`SER Header: ${header.width}x${header.height}, ${header.frameCount} frames, ${header.pixelDepth}-bit`);

        let bayerChoice;
        if (bayerPattern === 'AUTO') {
            const bayerMap = { 0: "MONO", 8: "COLOR_BayerRG2RGB", 9: "COLOR_BayerGR2RGB", 10: "COLOR_BayerGB2RGB", 11: "COLOR_BayerBG2RGB" };
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

        const canvas = document.createElement('canvas');
        canvas.width = header.width;
        canvas.height = header.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const frameCount = (maxFrames === -1) ? header.frameCount : Math.min(header.frameCount, maxFrames);

        const bestFramesCapacity = Math.floor(frameCount * 0.3);
	    const bestFramesForStacking = [];
        let top4Frames = [];
        let worstFrame = null;

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

        for (let i = 0; i < frameCount; i++) {
            const offset = 178 + (i * frameSize);
            if (offset + frameSize > file.size) {
                addLog(`Stopping at frame ${i} due to reaching end of file.`);
                break;
            }

            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
            
            const type = header.pixelDepth > 8 ? cv.CV_16UC1 : cv.CV_8UC1;
            const data = header.pixelDepth > 8 ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);
            let mat = cv.matFromArray(header.height, header.width, type, data);
            let temp8u = new cv.Mat();
            mat.convertTo(temp8u, cv.CV_8U, header.pixelDepth > 8 ? 1/256 : 1);
            cv.imshow(canvas, temp8u);
            const imageData = ctx.getImageData(0, 0, header.width, header.height);
            const sharpness = calculateSharpness(imageData);

            const currentFrame = { sharpness: sharpness, frameBuffer: frameBuffer };
            rankFrame(currentFrame);

            mat.delete();
            temp8u.delete();

            // Emit updated frames for preview
            if (i % 10 === 0 || i === frameCount - 1) { // Emit every 10 frames and on the last frame
                const top4FrameBlobs = await Promise.all(top4Frames.map(f => renderFrameToBlob(canvas, f.frameBuffer, header, bayerChoice)));
                const worstFrameBlob = worstFrame ? await renderFrameToBlob(canvas, worstFrame.frameBuffer, header, bayerChoice) : null;
                emit('ser-frames-updated', { top: top4FrameBlobs, worst: worstFrameBlob });
            }

            emit('update-loading', (i / frameCount) * 100);
            addLog(`Processed frame ${i}/${frameCount}, sharpness: ${sharpness.toFixed(2)}`);
        }
        
        addLog(`Finished analyzing ${frameCount} frames. Kept ${bestFramesForStacking.length} best frames.`);
        
        // Now, convert the best frames to PNG blobs with color
        const pngBlobs = [];
        for (let i = 0; i < bestFramesForStacking.length; i++) {
            const frame = bestFramesForStacking[i];
            const blob = await renderFrameToBlob(canvas, frame.frameBuffer, header, bayerChoice);
            pngBlobs.push({ pngFile: [blob] });
        }

        await uploadFrames(pngBlobs);
    }

    return { readSerFile };
}
