/*
	Unsharp Mask Worker - High performance using separable Gaussian blur
	Separable blur is O(n*r) instead of O(n*r²) - much faster for larger radii

	Supports both 8-bit (Uint8ClampedArray) and 16-bit (Float32Array) modes.
	When is16bit=true: input and output are Float32Array in 0.0-1.0 range
	When is16bit=false (default): input and output are Uint8ClampedArray in 0-255 range
*/

self.addEventListener('message', (e) => {
	const { imageData, width, height, radius, amount, threshold, taskId, is16bit } = e.data;

	if (is16bit) {
		// 16-bit mode: Float32Array input/output (0.0-1.0 range)
		const result = unsharpMask16(imageData, width, height, radius, amount, threshold);
		self.postMessage({ imageData: result, taskId, is16bit: true });
	} else {
		// 8-bit mode: Uint8ClampedArray input/output (0-255 range)
		const result = unsharpMask(imageData, width, height, radius, amount, threshold);
		self.postMessage({ imageData: result, taskId }, [result.buffer]);
	}
});

function unsharpMask(data, width, height, radius, amount, threshold) {
	// If radius is invalid or amount is 0, return original
	if (!Number.isFinite(radius) || radius < 0.5 || amount === 0) {
		return new Uint8ClampedArray(data);
	}

	// Create Gaussian kernel
	const kernelRadius = Math.max(1, Math.ceil(radius * 2.5)); // 2.5 sigma covers 99% of Gaussian
	const kernel = createGaussianKernel(radius, kernelRadius);

	// Separate channels for processing (skip alpha)
	const pixelCount = width * height;
	const r = new Float32Array(pixelCount);
	const g = new Float32Array(pixelCount);
	const b = new Float32Array(pixelCount);

	// Extract channels
	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		r[i] = data[idx];
		g[i] = data[idx + 1];
		b[i] = data[idx + 2];
	}

	// Apply separable Gaussian blur to each channel
	const blurredR = separableBlur(r, width, height, kernel, kernelRadius);
	const blurredG = separableBlur(g, width, height, kernel, kernelRadius);
	const blurredB = separableBlur(b, width, height, kernel, kernelRadius);

	// Apply unsharp mask: result = original + amount * (original - blurred)
	const result = new Uint8ClampedArray(data.length);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;

		// Calculate difference (the "mask")
		const diffR = r[i] - blurredR[i];
		const diffG = g[i] - blurredG[i];
		const diffB = b[i] - blurredB[i];

		// Apply threshold - only sharpen if edge is strong enough
		const edgeStrength = Math.abs(diffR) + Math.abs(diffG) + Math.abs(diffB);

		if (edgeStrength > threshold) {
			result[idx] = clamp(r[i] + amount * diffR);
			result[idx + 1] = clamp(g[i] + amount * diffG);
			result[idx + 2] = clamp(b[i] + amount * diffB);
		} else {
			result[idx] = r[i];
			result[idx + 1] = g[i];
			result[idx + 2] = b[i];
		}

		// Preserve alpha
		result[idx + 3] = data[idx + 3];
	}

	return result;
}

function createGaussianKernel(sigma, radius) {
	// Guard against invalid radius (negative or NaN)
	if (radius < 0 || !Number.isFinite(radius)) {
		return new Float32Array([1.0]); // Return identity kernel
	}
	const kernel = new Float32Array(radius * 2 + 1);
	const sigma2 = sigma * sigma * 2;
	let sum = 0;

	for (let i = -radius; i <= radius; i++) {
		const value = Math.exp(-(i * i) / sigma2);
		kernel[i + radius] = value;
		sum += value;
	}

	// Normalize
	for (let i = 0; i < kernel.length; i++) {
		kernel[i] /= sum;
	}

	return kernel;
}

function separableBlur(channel, width, height, kernel, radius) {
	const temp = new Float32Array(channel.length);
	const result = new Float32Array(channel.length);

	// Horizontal pass
	for (let y = 0; y < height; y++) {
		const rowOffset = y * width;
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const sx = Math.min(Math.max(x + k, 0), width - 1);
				sum += channel[rowOffset + sx] * kernel[k + radius];
			}
			temp[rowOffset + x] = sum;
		}
	}

	// Vertical pass
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const sy = Math.min(Math.max(y + k, 0), height - 1);
				sum += temp[sy * width + x] * kernel[k + radius];
			}
			result[y * width + x] = sum;
		}
	}

	return result;
}

function clamp(value) {
	return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * 16-bit Unsharp Mask - operates entirely in float space (0.0-1.0)
 * @param {Float32Array} data - RGBA float data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} radius - Blur radius
 * @param {number} amount - Sharpening amount
 * @param {number} threshold - Edge threshold (0-255 scale, converted internally)
 * @returns {Float32Array} Processed RGBA data
 */
function unsharpMask16(data, width, height, radius, amount, threshold) {
	// If radius is invalid or amount is 0, return original
	if (!Number.isFinite(radius) || radius < 0.5 || amount === 0) {
		return new Float32Array(data);
	}

	// Convert threshold from 0-255 scale to 0-1 scale
	const thresholdNormalized = threshold / 255;

	// Create Gaussian kernel
	const kernelRadius = Math.max(1, Math.ceil(radius * 2.5));
	const kernel = createGaussianKernel(radius, kernelRadius);

	// Separate channels for processing (skip alpha)
	const pixelCount = width * height;
	const r = new Float32Array(pixelCount);
	const g = new Float32Array(pixelCount);
	const b = new Float32Array(pixelCount);

	// Extract channels (already in 0-1 range)
	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		r[i] = data[idx];
		g[i] = data[idx + 1];
		b[i] = data[idx + 2];
	}

	// Apply separable Gaussian blur to each channel
	const blurredR = separableBlur(r, width, height, kernel, kernelRadius);
	const blurredG = separableBlur(g, width, height, kernel, kernelRadius);
	const blurredB = separableBlur(b, width, height, kernel, kernelRadius);

	// Apply unsharp mask: result = original + amount * (original - blurred)
	const result = new Float32Array(data.length);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;

		// Calculate difference (the "mask")
		const diffR = r[i] - blurredR[i];
		const diffG = g[i] - blurredG[i];
		const diffB = b[i] - blurredB[i];

		// Apply threshold - only sharpen if edge is strong enough
		// Sum of absolute differences in 0-1 range (scale threshold accordingly)
		const edgeStrength = Math.abs(diffR) + Math.abs(diffG) + Math.abs(diffB);

		if (edgeStrength > thresholdNormalized * 3) {
			// Clamp to 0-1 range for float output
			result[idx] = Math.max(0, Math.min(1, r[i] + amount * diffR));
			result[idx + 1] = Math.max(0, Math.min(1, g[i] + amount * diffG));
			result[idx + 2] = Math.max(0, Math.min(1, b[i] + amount * diffB));
		} else {
			result[idx] = r[i];
			result[idx + 1] = g[i];
			result[idx + 2] = b[i];
		}

		// Preserve alpha
		result[idx + 3] = data[idx + 3];
	}

	return result;
}
