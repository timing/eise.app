// Takes ffmpeg.FS('readFile', file); as an image

export function calculateSharpness(imageData) {
	// sobel is faster than sobelWithOpenCV
	const sharpness = sobel(imageData);
	return sharpness;
}
export function stackFramesAverage(frames) {
	const width = frames[0].imageData.width;
	const height = frames[0].imageData.height;
	const stackedImageData = new ImageData(width, height);
	
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let totalR = 0, totalG = 0, totalB = 0;
			
			// Sum up pixel values from all frames
			frames.forEach(frame => {
				const index = (y * width + x) * 4;
				totalR += frame.imageData.data[index];
				totalG += frame.imageData.data[index + 1];
				totalB += frame.imageData.data[index + 2];
			});
			
			// Calculate average or median
			const avgIndex = (y * width + x) * 4;
			stackedImageData.data[avgIndex] = totalR / frames.length; // Average Red
			stackedImageData.data[avgIndex + 1] = totalG / frames.length; // Average Green
			stackedImageData.data[avgIndex + 2] = totalB / frames.length; // Average Blue
			stackedImageData.data[avgIndex + 3] = 255; // Alpha Channel
		}
	}
	
	return stackedImageData;
}

export function stackFramesMedian(frames) {
	const width = frames[0].imageData.width;
	const height = frames[0].imageData.height;
	const stackedImageData = new ImageData(width, height);
	
	const pixelValues = { r: [], g: [], b: [] };

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Reset arrays for new pixel
			pixelValues.r.length = 0;
			pixelValues.g.length = 0;
			pixelValues.b.length = 0;

			// Collect pixel values from all frames
			frames.forEach(frame => {
				const index = (y * width + x) * 4;
				pixelValues.r.push(frame.imageData.data[index]);
				pixelValues.g.push(frame.imageData.data[index + 1]);
				pixelValues.b.push(frame.imageData.data[index + 2]);
			});

			// Calculate median for each channel
			const medianIndex = (y * width + x) * 4;
			stackedImageData.data[medianIndex] = median(pixelValues.r); // Median Red
			stackedImageData.data[medianIndex + 1] = median(pixelValues.g); // Median Green
			stackedImageData.data[medianIndex + 2] = median(pixelValues.b); // Median Blue
			stackedImageData.data[medianIndex + 3] = 255; // Alpha Centauri Channel

			//console.log('stack done', x, y, pixelValues.r, pixelValues.g, pixelValues.b);
		}
	}

	console.log(stackedImageData);
	
	return stackedImageData;
}

// Utility function to calculate median
function median(values) {
	if (values.length === 0) throw new Error("No inputs");
	values.sort((a, b) => a - b);
	const half = Math.floor(values.length / 2);
	if (values.length % 2) {
		return values[half];
	}
	return (values[half - 1] + values[half]) / 2.0;
}


export function calculateCenterOfGravity(imageData) {
	let totalWeight = 0;
	let xWeight = 0;
	let yWeight = 0;
	const width = imageData.width;
	const height = imageData.height;
	const data = applyGaussianBlur(imageData).data;

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

function applyGaussianBlur(imageData) {
	// Ensure OpenCV has been loaded
	if (!cv || !cv.Mat || !cv.GaussianBlur) {
		console.error('OpenCV not loaded or cv.Mat / cv.GaussianBlur not available.');
		return;
	}

	console.log('0');

	// Convert ImageData to cv.Mat
	let srcMat = cv.matFromImageData(imageData);
	let dstMat = new cv.Mat();

	let grayMat = new cv.Mat();
	cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY, 0);
	
	let equalizedMat = new cv.Mat();

	//cv.equalizeHist(grayMat, equalizedMat); // Apply histogram equalization

	// Apply Gaussian Blur
	// You can adjust the kernel size (e.g., 5x5) and sigma values as needed
	let ksize = new cv.Size(5, 5);
	cv.GaussianBlur(grayMat, dstMat, ksize, 0, 0, cv.BORDER_DEFAULT);
	
	// Convert cv.Mat back to ImageData
	let blurredImageData = matToImageData(dstMat);

	// Cleanup
	srcMat.delete();
	dstMat.delete();
	grayMat.delete();
	equalizedMat.delete();

	return blurredImageData;
}

export function matToImageData(mat) {
	const cols = mat.cols;
	const rows = mat.rows;
	const imageData = new ImageData(cols, rows);
	const data = mat.data;
	const length = cols * rows;

	for (let i = 0; i < length; i++) {
		// Set R, G, and B channels to the grayscale value
		imageData.data[i * 4] = data[i];	 // R
		imageData.data[i * 4 + 1] = data[i]; // G
		imageData.data[i * 4 + 2] = data[i]; // B
		imageData.data[i * 4 + 3] = 255;	 // A
	}

	return imageData;
}


export function stackImagesWithOpenCV(frames) {
	// Ensure OpenCV has initialized
	if (!cv) {
		console.error('OpenCV.js is not ready.');
		return;
	}

	console.log('stack');

	// Step 1: Convert images (assumed to be ImageData objects) to cv.Mat and to grayscale
	let mats = frames.map(frame => cv.matFromImageData(frame.imageData));
	let grayMats = mats.map(mat => {
		let gray = new cv.Mat();
		cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY, 0);

		let equalizedMat = new cv.Mat();
		cv.equalizeHist(gray, equalizedMat); // Apply histogram equalization
		gray.delete();

		return equalizedMat;
	});
	
	// Use the first image as the reference/base
	let baseMat = grayMats[0];
	let alignedMats = [mats[0]]; // Include the base image as the first aligned image

	// Step 2 & 3: Feature detection, matching, and aligning subsequent images to the base
	let orb = new cv.ORB();
	let bfMatcher = new cv.BFMatcher(cv.NORM_HAMMING, true);

	for (let i = 1; i < grayMats.length; i++) {
		let keypoints1 = new cv.KeyPointVector();
		let descriptors1 = new cv.Mat();
		orb.detectAndCompute(baseMat, new cv.Mat(), keypoints1, descriptors1);

		let keypoints2 = new cv.KeyPointVector();
		let descriptors2 = new cv.Mat();
		orb.detectAndCompute(grayMats[i], new cv.Mat(), keypoints2, descriptors2);

		// Match descriptors
		let matches = new cv.DMatchVector();
		bfMatcher.match(descriptors1, descriptors2, matches);

		// Find warp perspective
		let srcPoints = new cv.Mat(matches.size(), 1, cv.CV_32FC2);
		let dstPoints = new cv.Mat(matches.size(), 1, cv.CV_32FC2);

		for (let i = 0; i < matches.size(); ++i) {
			let match = matches.get(i);
			let pt1 = keypoints1.get(match.queryIdx).pt;
			let pt2 = keypoints2.get(match.trainIdx).pt;
			
			// Set the point in srcPoints and dstPoints
			srcPoints.data32F[i * 2] = pt1.x;
			srcPoints.data32F[i * 2 + 1] = pt1.y;
			dstPoints.data32F[i * 2] = pt2.x;
			dstPoints.data32F[i * 2 + 1] = pt2.y;
		}	

		// Override because the upper generated values didn't work
		//srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [10, 10, 100, 100, 10, 100, 100, 10]);
		//dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [20, 20, 200, 200, 20, 200, 200, 20]);
	
		let H = cv.findHomography(srcPoints, dstPoints, cv.RANSAC);
		
		let alignedMat = new cv.Mat();

		cv.warpPerspective(mats[i], alignedMat, H, baseMat.size());

		alignedMats.push(alignedMat);
		
		// Cleanup
		keypoints1.delete(); descriptors1.delete();
		keypoints2.delete(); descriptors2.delete();
		matches.delete(); srcPoints.delete(); dstPoints.delete(); H.delete();

		console.log('stack 3.5');
	}

	// Step 4: Blend the aligned images (simple averaging for demonstration)
	let resultMat = new cv.Mat();
	console.log('stack addWeighted', alignedMats.length);

	//alignedMats = cropImagesToSmallestSize(alignedMats);	

	if (alignedMats[0].rows !== alignedMats[1].rows || alignedMats[0].cols !== alignedMats[1].cols || alignedMats[0].type() !== alignedMats[1].type()) {
		alignedMats.forEach((mat, index) => {
		if (index === 0) return; // Skip the first image

		const prevMat = alignedMats[index - 1];
		if (mat.rows !== prevMat.rows || mat.cols !== prevMat.cols || mat.type() !== prevMat.type()) {
			console.log(`Mismatch between images at indices ${index - 1} and ${index}:`);
			console.log(`Previous image: Size = ${prevMat.cols}x${prevMat.rows}, Type = ${prevMat.type()}`);
			console.log(`Current image: Size = ${mat.cols}x${mat.rows}, Type = ${mat.type()}`);
		}
	});	
		console.error('Source matrices must have the same size and type.');
		return;
	}
	cv.addWeighted(alignedMats[0], 1.0 / alignedMats.length, alignedMats[1], 1.0 / alignedMats.length, 0, resultMat);
	console.log('stack 6');
	for (let i = 2; i < alignedMats.length; i++) {
		cv.addWeighted(resultMat, 1, alignedMats[i], 1.0 / alignedMats.length, 0, resultMat);
	}


	// Convert resultMat back to ImageData (or another format as needed)
	let resultImageData = new ImageData(new Uint8ClampedArray(resultMat.data), resultMat.cols, resultMat.rows);

	// Cleanup
	// TODO, this cleanup happened to fast, client couldn't render
	/*mats.forEach(mat => mat.delete());
	grayMats.forEach(mat => mat.delete());
	alignedMats.forEach(mat => mat.delete());
	resultMat.delete();*/

	return resultImageData;
}

export function cvMatToImageData(mat){
	return new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
}

export function adjustGainMultiply(srcMat, gainValue) {
	gainValue = parseFloat(gainValue);

	// Convert the gain value to a suitable format for multiplication
	let gainMat = new cv.Mat(srcMat.rows, srcMat.cols, srcMat.type());
	gainMat.setTo(new cv.Scalar(gainValue, gainValue, gainValue));

	let gainedMat = new cv.Mat();
	cv.multiply(srcMat, gainMat, gainedMat, 1, -1); // -1 to keep the same data type as srcMat

	gainMat.delete(); // Clean up
	return gainedMat;
}

export function adjustGain(srcMat, gainValue) {
	// Clone the source Mat to keep the original image unchanged
	gainValue = parseFloat(gainValue);

	console.log(gainValue);

	// Access the data buffer of the dstMat
	let dstData = new Uint8Array(srcMat.data);

	// Calculate the number of channels in the image
	let channels = srcMat.channels();

	// Iterate over the image data
	for (let i = 0; i < srcMat.rows; i++) {
		for (let j = 0; j < srcMat.cols; j++) {
			for (let c = 0; c < channels-1; c++) { // channels -1 to jsut skip alfa channel?
				const index = (i * srcMat.cols + j) * channels + c;
				srcMat.data[index] = Math.min(255, srcMat.data[index] * gainValue);
			}
		}
	}

	return srcMat;
}


function cropImagesToSmallestSize(images) {
	// Assuming 'images' is an array of cv.Mat objects
	// Step 1: Find the minimum width and height
	let minWidth = Math.min(...images.map(image => image.cols));
	let minHeight = Math.min(...images.map(image => image.rows));

	// Step 2: Crop images to the minimum width and height, centered
	let croppedImages = images.map(image => {
		let offsetX = Math.floor((image.cols - minWidth) / 2);
		let offsetY = Math.floor((image.rows - minHeight) / 2);

		// Define the rectangle for cropping
		let rect = new cv.Rect(offsetX, offsetY, minWidth, minHeight);

		// Crop the image
		let croppedImage = image.roi(rect);
		return croppedImage;
	});

	return croppedImages;
}



function sobelWithOpenCV(imageData) {
	// Ensure OpenCV.js is loaded
	if (typeof cv === 'undefined' || !cv.Mat) {
		console.error('OpenCV.js is not loaded');
		return 0;
	}

	// Convert ImageData to OpenCV Mat
	let src = cv.matFromImageData(imageData);
	let srcGray = new cv.Mat();
	cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY, 0);

	// Apply Sobel operator in x and y directions
	let gradX = new cv.Mat();
	let gradY = new cv.Mat();
	cv.Sobel(srcGray, gradX, cv.CV_32F, 1, 0);
	cv.Sobel(srcGray, gradY, cv.CV_32F, 0, 1);

	// Compute gradient magnitude
	let magnitude = new cv.Mat();
	cv.magnitude(gradX, gradY, magnitude);

	// Calculate average gradient magnitude
	let sum = 0;
	let totalPixels = magnitude.rows * magnitude.cols;
	for (let i = 0; i < totalPixels; i++) {
		sum += magnitude.data32F[i];
	}
	const avgGradient = sum / totalPixels;

	// Cleanup
	src.delete();
	srcGray.delete();
	gradX.delete();
	gradY.delete();
	magnitude.delete();

	return avgGradient;
}


function sobel(imageData) {
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

