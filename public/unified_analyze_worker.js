// public/unified_analyze_worker.js

let offscreen = null;
let ctx = null;

self.addEventListener('message', async (e) => {
    const { type, index } = e.data;
    //console.log(`Worker: Received message - Type: ${type}, Index: ${index}`);

    try {
        let imageData;
        let imgWidth, imgHeight;

        if (type === 'ffmpeg') {
            const { analyze } = e.data;
            //console.log(`Worker: FFMPEG path - analyze data byteLength: ${analyze.byteLength}`);
            const imageBlob = new Blob([analyze.buffer], { type: 'image/png' }); // Use analyze.buffer
            //console.log(`Worker: FFMPEG path - Created Blob size: ${imageBlob.size}`);
            const img = await createImageBitmap(imageBlob);
            imgWidth = img.width;
            imgHeight = img.height;

            if (offscreen === null || offscreen.width !== imgWidth || offscreen.height !== imgHeight) {
                offscreen = new OffscreenCanvas(imgWidth, imgHeight);
                ctx = offscreen.getContext('2d', { willReadFrequently: true });
            }
            ctx.drawImage(img, 0, 0);
            imageData = ctx.getImageData(0, 0, imgWidth, imgHeight);
            //console.log('Worker: FFMPEG path - ImageData obtained.');

        } else if (type === 'ser') {
            const { frameBuffer, header, bayerChoice } = e.data;
            //console.log(`Worker: SER path - frameBuffer size: ${frameBuffer.byteLength}`);
            imgWidth = header.width;
            imgHeight = header.height;
            imageData = convertSerFrameToImageData(frameBuffer, header, bayerChoice);
            //console.log('Worker: SER path - ImageData obtained.');

        } else {
            throw new Error('Unknown analysis type');
        }

        const sharpness = calculateSharpness(imageData);
        const { cog, boundingBox } = calculateCenterOfGravityAndBoundingBox(imageData);
        const is_cut_off = isImageCutOff(cog, boundingBox, imgWidth, imgHeight);

        const frameData = { sharpness, is_cut_off };
        
        //console.log(`Worker: Processing complete for index ${index}, sharpness: ${sharpness}`);
        self.postMessage({ frameData: frameData, index: index });

    } catch (error) {
        console.error('Error in unified_analyze_worker:', error);
        self.postMessage({ error: error.message, index: index });
    }
});

// Sobel algo - Copied from analyze_worker.js
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


function convertSerFrameToImageData(frameBuffer, header, bayerChoice) {
    const { width, height, pixelDepth } = header;
    const is16Bit = pixelDepth > 8;
    const frameData = is16Bit ? new Uint16Array(frameBuffer) : new Uint8Array(frameBuffer);

    const imageData = new ImageData(width, height);
    const outputData = imageData.data; // This is a Uint8ClampedArray (RGBA)

    if (bayerChoice === "MONO") {
        for (let i = 0; i < frameData.length; i++) {
            const pixelValue = is16Bit ? Math.floor(frameData[i] / 256) : frameData[i]; // Scale 16-bit to 8-bit
            const outputIndex = i * 4;
            outputData[outputIndex] = pixelValue;     // R
            outputData[outputIndex + 1] = pixelValue; // G
            outputData[outputIndex + 2] = pixelValue; // B
            outputData[outputIndex + 3] = 255;        // A
        }
    } else {
        // Simple bilinear demosaicing (example for RGGB)
        // This is a placeholder; a more advanced algorithm would be ideal.
        // Assumes bayerChoice (e.g., COLOR_BayerRG2RGB) is a string, not a cv constant
        // For simplicity and matching plain JS, we'll implement a basic one.

        const getPixel = (x, y) => {
            if (x < 0 || x >= width || y < 0 || y >= height) return 0;
            return is16Bit ? Math.floor(frameData[y * width + x] / 256) : frameData[y * width + x];
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const outputIndex = (y * width + x) * 4;
                let r, g, b;

                // Basic RGGB pattern
                // G B
                // R G
                if ((y % 2 === 0 && x % 2 === 0)) { // G position in RGGB top-left
                    g = getPixel(x, y);
                    b = (getPixel(x, y - 1) + getPixel(x, y + 1) + getPixel(x - 1, y) + getPixel(x + 1, y)) / 4; // Average of adjacent R/B
                    r = (getPixel(x - 1, y - 1) + getPixel(x - 1, y + 1) + getPixel(x + 1, y - 1) + getPixel(x + 1, y + 1)) / 4; // Average of diagonal G
                } else if ((y % 2 === 0 && x % 2 === 1)) { // B position in RGGB top-right
                    b = getPixel(x, y);
                    g = (getPixel(x, y - 1) + getPixel(x, y + 1) + getPixel(x - 1, y) + getPixel(x + 1, y)) / 4;
                    r = (getPixel(x - 1, y - 1) + getPixel(x + 1, y - 1)) / 2; // Average of horizontal R
                } else if ((y % 2 === 1 && x % 2 === 0)) { // R position in RGGB bottom-left
                    r = getPixel(x, y);
                    g = (getPixel(x, y - 1) + getPixel(x, y + 1) + getPixel(x - 1, y) + getPixel(x + 1, y)) / 4;
                    b = (getPixel(x - 1, y + 1) + getPixel(x + 1, y + 1)) / 2; // Average of vertical B
                } else { // G position in RGGB bottom-right
                    g = getPixel(x, y);
                    b = (getPixel(x, y - 1) + getPixel(x, y + 1) + getPixel(x - 1, y) + getPixel(x + 1, y)) / 4;
                    r = (getPixel(x - 1, y - 1) + getPixel(x - 1, y + 1) + getPixel(x + 1, y - 1) + getPixel(x + 1, y + 1)) / 4;
                }
                
                outputData[outputIndex] = Math.min(255, Math.max(0, r));
                outputData[outputIndex + 1] = Math.min(255, Math.max(0, g));
                outputData[outputIndex + 2] = Math.min(255, Math.max(0, b));
                outputData[outputIndex + 3] = 255;
            }
        }
    }
    return imageData;
}


function calculateCenterOfGravity(imageData) {
    let totalWeight = 0;
    let xWeight = 0;
    let yWeight = 0;
    const width = imageData.width;
    const height = imageData.height;
    const data = gaussianBlur(imageData).data;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
            totalWeight += brightness;
            xWeight += x * brightness;
            yWeight += y * brightness;
        }
    }

    const cog = {
        x: xWeight / totalWeight,
        y: yWeight / totalWeight,
    };

    return cog;
}

function calculateCenterOfGravityAndBoundingBox(imageData) {
    let totalWeight = 0;
    let xWeight = 0;
    let yWeight = 0;
    let minX = Infinity;
    let maxX = 0;
    let minY = Infinity;
    let maxY = 0;
    const width = imageData.width;
    const height = imageData.height;
    const data = gaussianBlur(imageData).data;
    const brightnessThreshold = 10; // Example threshold, adjust based on your image characteristics

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
            if (brightness > brightnessThreshold) {
                totalWeight += brightness;
                xWeight += x * brightness;
                yWeight += y * brightness;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
    }

    const cog = {
        x: xWeight / totalWeight,
        y: yWeight / totalWeight,
    };

    const boundingBox = {
        left: minX,
        right: maxX,
        top: minY,
        bottom: maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
    };

    return { cog, boundingBox };
}

function gaussianBlur(imageData) {
    const kernel = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
    const width = imageData.width;
    const height = imageData.height;
    const data = new Uint8ClampedArray(imageData.data);
    const blurredData = new Uint8ClampedArray(data.length);

    // Horizontal pass
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -2; k <= 2; k++) {
                const xk = Math.max(0, Math.min(width - 1, x + k));
                const i = (y * width + xk) * 4;
                r += data[i] * kernel[k + 2];
                g += data[i + 1] * kernel[k + 2];
                b += data[i + 2] * kernel[k + 2];
                a += data[i + 3] * kernel[k + 2];
            }
            const index = (y * width + x) * 4;
            blurredData[index] = r;
            blurredData[index + 1] = g;
            blurredData[index + 2] = b;
            blurredData[index + 3] = a;
        }
    }

    // Vertical pass
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -2; k <= 2; k++) {
                const yk = Math.max(0, Math.min(height - 1, y + k));
                const i = (yk * width + x) * 4;
                r += blurredData[i] * kernel[k + 2];
                g += blurredData[i + 1] * kernel[k + 2];
                b += blurredData[i + 2] * kernel[k + 2];
                a += blurredData[i + 3] * kernel[k + 2];
            }
            const index = (y * width + x) * 4;
            data[index] = r;
            data[index + 1] = g;
            data[index + 2] = b;
            data[index + 3] = a;
        }
    }

    return new ImageData(data, width, height);
}


function isImageCutOff(cog, boundingBox, imgWidth, imgHeight) {
    const centerThreshold = 0.25;
    const boundingBoxSizeThreshold = 0.5;

    const imageCenterX = imgWidth / 2;
    const imageCenterY = imgHeight / 2;

    const distanceFromCenterX = Math.abs(cog.x - imageCenterX) / imageCenterX;
    const distanceFromCenterY = Math.abs(cog.y - imageCenterY) / imageCenterY;

    if (distanceFromCenterX < centerThreshold && distanceFromCenterY < centerThreshold) {
        return false;
    }

    const boundingBoxWidthFraction = (boundingBox.right - boundingBox.left) / imgWidth;
    const boundingBoxHeightFraction = (boundingBox.bottom - boundingBox.top) / imgHeight;

    if (boundingBoxWidthFraction > boundingBoxSizeThreshold && boundingBoxHeightFraction > boundingBoxSizeThreshold) {
        return false;
    }

    if ((distanceFromCenterX > centerThreshold || distanceFromCenterY > centerThreshold) &&
        (boundingBox.left === 0 || boundingBox.right === imgWidth - 1 ||
         boundingBox.top === 0 || boundingBox.bottom === imgHeight - 1)) {
        return true;
    }

    return false;
}
