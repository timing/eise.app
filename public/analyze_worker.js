let offscreen = null;
let ctx = null;

self.addEventListener('message', async (e) => {

	createImageBitmap(new Blob(e.data.analyze, {type: 'image/png'})).then(img => {

		if( offscreen === null ){
			offscreen = new OffscreenCanvas(img.width, img.height);
			ctx = offscreen.getContext('2d', {willReadFrequently: true});
		}

		ctx.drawImage(img, 0, 0);

		const imageData = ctx.getImageData(0, 0, img.width, img.height)

		const frameData = { sharpness: calculateSharpness(imageData), is_cut_off: isImageCutOff(imageData) };

		console.log('AnalyzeWorker', e.data.index, frameData);

		/*if( !isImageCutOff(imageData) ){ 
			addFrameToBest(frameData);
			addLog('Frame ' + index + '. Sharpness:' + frameData.sharpness);
		} else {
			addLog('Frame skipped (cut off) ' + index + '. Sharpness:' + frameData.sharpness);
		}*/
		//frameData.center_of_gravity = calculateCenterOfGravity(imageData);


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

// detect non black pixels.. should not be used at some point. Fix server side PSS instead
function isImageCutOff(imageData, border = 5, threshold = 30) {
	const { data, width, height } = imageData;

	// Helper function to check if a pixel is not black
	function isNotBlack(index) {
		return data[index] > threshold || data[index + 1] > threshold || data[index + 2] > threshold;
	}

	// Check top and bottom borders
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < border; y++) {
			if (isNotBlack((y * width + x) * 4) || isNotBlack(((height - 1 - y) * width + x) * 4)) {
				return true;
			}
		}
	}

	// Check left and right borders
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < border; x++) {
			if (isNotBlack((y * width + x) * 4) || isNotBlack((y * width + (width - 1 - x)) * 4)) {
				return true;
			}
		}
	}

	return false; // No cut-off detected
}

