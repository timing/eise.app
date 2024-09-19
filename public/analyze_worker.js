let offscreen = null;
let ctx = null;

self.addEventListener('message', async (e) => {
	const { analyze, index, exportFormat, width, height } = e.data;

	console.log('data', e.data);

	if (exportFormat === 'raw') {
		// Handle raw RGB24 data
		// Convert the raw RGB24 data into ImageData
		const imageData = rgb24ToImageData(new Uint8Array(analyze[0]), width, height);
		console.log(analyze, imageData);

		processImageData(imageData, index);
	} else {
		// Existing PNG handling code
		createImageBitmap(new Blob(analyze, {type: 'image/png'})).then(img => {
			// Your existing processing code
			processImageBitmap(img, index);
		}).catch(error => {
			console.error('Error creating ImageBitmap:', error);
			self.postMessage({error: error, index: index});
		});
	}
});

function rgb24ToImageData(rgbData, width, height) {
	let imageData = new ImageData(width, height);
	for (let i = 0, j = 0; i < rgbData.length; i += 3, j += 4) {
		imageData.data[j] = rgbData[i];	 // R
		imageData.data[j + 1] = rgbData[i + 1]; // G
		imageData.data[j + 2] = rgbData[i + 2]; // B
		imageData.data[j + 3] = 255; // A
	}
	return imageData;
}

function processImageData(imageData, index) {
	const frameData = { sharpness: calculateSharpness(imageData) };
	const { cog, boundingBox } = calculateCenterOfGravityAndBoundingBox(imageData);
	frameData.is_cut_off = isImageCutOff(cog, boundingBox, imageData.width, imageData.height);
	console.log('AnalyzeWorker', index, frameData, cog, boundingBox);
	self.postMessage({frameData: frameData, index: index});
}

function processImageBitmap(img, index) {
	if( offscreen === null ){
		offscreen = new OffscreenCanvas(img.width, img.height);
		ctx = offscreen.getContext('2d', {willReadFrequently: true});
	}

	ctx.drawImage(img, 0, 0);
	const imageData = ctx.getImageData(0, 0, img.width, img.height);
	processImageData(imageData, index);
}


self.addEventListener('old_message', async (e) => {

	createImageBitmap(new Blob(e.data.analyze, {type: 'image/png'})).then(img => {

		if( offscreen === null ){
			offscreen = new OffscreenCanvas(img.width, img.height);
			ctx = offscreen.getContext('2d', {willReadFrequently: true});
		}

		ctx.drawImage(img, 0, 0);

		const imageData = ctx.getImageData(0, 0, img.width, img.height)

		const frameData = { sharpness: calculateSharpness(imageData) };
	
		//frameData.center_of_gravity = calculateCenterOfGravity(imageData);
		const {cog, boundingBox} = calculateCenterOfGravityAndBoundingBox(imageData);

		frameData.is_cut_off = isImageCutOff(cog, boundingBox, img.width, img.height);

		/*if( !isImageCutOff(imageData) ){ 
			addFrameToBest(frameData);
			addLog('Frame ' + index + '. Sharpness:' + frameData.sharpness);
		} else {
			addLog('Frame skipped (cut off) ' + index + '. Sharpness:' + frameData.sharpness);
		}*/

		console.log('AnalyzeWorker', e.data.index, frameData, cog, boundingBox);

		/*	 + ', isCutOff:' + frameData.isCutOff + ', CoG: '
			// + frameData.center_of_gravity.x + ',' + frameData.center_of_gravity.x	
		);*/

		self.postMessage({frameData: frameData, index: e.data.index});
	}).catch(error => {
		console.error('Error creating ImageBitmap:', error);
		self.postMessage({error: error, index: e.data.index}); // Make sure to reject the promise if you are within a promise handler
	});

});

// Sobel algo
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
	// Define thresholds
	const centerThreshold = 0.25; // CoG must be within 25% of the center
	const boundingBoxSizeThreshold = 0.5; // Bounding box must be bigger than 50% of the image dimensions

	// Calculate center of the image
	const imageCenterX = imgWidth / 2;
	const imageCenterY = imgHeight / 2;

	// Calculate distances of CoG from the image center
	const distanceFromCenterX = Math.abs(cog.x - imageCenterX) / imageCenterX;
	const distanceFromCenterY = Math.abs(cog.y - imageCenterY) / imageCenterY;

	// Check if CoG is close to the center (within 25%)
	if (distanceFromCenterX < centerThreshold && distanceFromCenterY < centerThreshold) {
		return false; // Image is not cut off
	}

	// Calculate bounding box size as a fraction of the image size
	const boundingBoxWidthFraction = (boundingBox.right - boundingBox.left) / imgWidth;
	const boundingBoxHeightFraction = (boundingBox.bottom - boundingBox.top) / imgHeight;

	// Check if bounding box is fairly big (more than 50% of the image in both dimensions)
	if (boundingBoxWidthFraction > boundingBoxSizeThreshold && boundingBoxHeightFraction > boundingBoxSizeThreshold) {
		return false; // Image is not cut off
	}

	// Finally, check if CoG is outside the 25% center area and the bounding box hits the sides of the image
	if ((distanceFromCenterX > centerThreshold || distanceFromCenterY > centerThreshold) &&
		(boundingBox.left === 0 || boundingBox.right === imgWidth - 1 ||
		 boundingBox.top === 0 || boundingBox.bottom === imgHeight - 1)) {
		return true; // Image is cut off
	}

	// If none of the above conditions met, consider the image not cut off by default
	return false;
}
