/**
 * 16-bit PNG encoder using fast-png
 *
 * Exports Float32Array image data as 16-bit PNG files.
 * fast-png is dynamically imported to avoid bundling overhead when not used.
 */

let fastPng = null;

/**
 * Load fast-png library
 * @returns {Promise<Object>} fast-png module
 */
async function loadFastPng() {
	if (fastPng) return fastPng;

	// Dynamic import of fast-png
	const module = await import('fast-png');
	fastPng = module;
	return fastPng;
}

/**
 * Encode Float32Array image data as 16-bit PNG
 * @param {Float32Array} data - RGBA data in 0.0-1.0 range
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Promise<Blob>} PNG blob
 */
export async function encode16BitPNG(data, width, height) {
	const { encode } = await loadFastPng();

	// Convert Float32Array (0.0-1.0) to Uint16Array (0-65535)
	const uint16Data = new Uint16Array(data.length);
	const scale = 65535;

	for (let i = 0; i < data.length; i++) {
		// Clamp to 0-1 range and scale to 16-bit
		uint16Data[i] = Math.round(Math.max(0, Math.min(1, data[i])) * scale);
	}

	// fast-png encode with 16-bit depth
	const pngBuffer = encode({
		width,
		height,
		data: uint16Data,
		depth: 16,
		channels: 4  // RGBA
	});

	return new Blob([pngBuffer], { type: 'image/png' });
}

/**
 * Encode Uint16Array image data as 16-bit PNG
 * @param {Uint16Array} uint16Data - RGBA data in 0-65535 range
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Promise<Blob>} PNG blob
 */
export async function encode16BitPNGFromUint16(uint16Data, width, height) {
	const { encode } = await loadFastPng();

	const pngBuffer = encode({
		width,
		height,
		data: uint16Data,
		depth: 16,
		channels: 4
	});

	return new Blob([pngBuffer], { type: 'image/png' });
}

/**
 * Encode Image16 object as 16-bit PNG
 * @param {import('./Image16.js').Image16} image16 - Image16 object
 * @returns {Promise<Blob>} PNG blob
 */
export async function encode16BitPNGFromImage16(image16) {
	return encode16BitPNG(image16.data, image16.width, image16.height);
}

/**
 * Download Float32Array image as 16-bit PNG
 * @param {Float32Array} data - RGBA data in 0.0-1.0 range
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} filename - Download filename
 */
export async function download16BitPNG(data, width, height, filename = 'image_16bit.png') {
	const blob = await encode16BitPNG(data, width, height);
	const url = URL.createObjectURL(blob);

	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);

	URL.revokeObjectURL(url);
}

/**
 * Download Image16 object as 16-bit PNG
 * @param {import('./Image16.js').Image16} image16 - Image16 object
 * @param {string} filename - Download filename
 */
export async function download16BitPNGFromImage16(image16, filename = 'image_16bit.png') {
	return download16BitPNG(image16.data, image16.width, image16.height, filename);
}

/**
 * Decode a PNG file and return info about its bit depth
 * @param {ArrayBuffer} buffer - PNG file data
 * @returns {Promise<{width: number, height: number, depth: number, channels: number, data: Uint8Array|Uint16Array, float32Data: Float32Array|null}>}
 */
export async function decodePNG(buffer) {
	const { decode } = await loadFastPng();
	const result = decode(new Uint8Array(buffer));

	// If 16-bit, convert to Float32Array (0.0-1.0 range)
	let float32Data = null;
	if (result.depth === 16) {
		const uint16Data = result.data instanceof Uint16Array
			? result.data
			: new Uint16Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 2);

		// Convert to float based on channel count
		const pixelCount = result.width * result.height;
		const scale = 1 / 65535;

		if (result.channels === 4) {
			// RGBA - direct conversion
			float32Data = new Float32Array(uint16Data.length);
			for (let i = 0; i < uint16Data.length; i++) {
				float32Data[i] = uint16Data[i] * scale;
			}
		} else if (result.channels === 3) {
			// RGB to RGBA
			float32Data = new Float32Array(pixelCount * 4);
			for (let i = 0; i < pixelCount; i++) {
				float32Data[i * 4] = uint16Data[i * 3] * scale;
				float32Data[i * 4 + 1] = uint16Data[i * 3 + 1] * scale;
				float32Data[i * 4 + 2] = uint16Data[i * 3 + 2] * scale;
				float32Data[i * 4 + 3] = 1.0;
			}
		} else if (result.channels === 2) {
			// Grayscale+Alpha to RGBA
			float32Data = new Float32Array(pixelCount * 4);
			for (let i = 0; i < pixelCount; i++) {
				const v = uint16Data[i * 2] * scale;
				float32Data[i * 4] = v;
				float32Data[i * 4 + 1] = v;
				float32Data[i * 4 + 2] = v;
				float32Data[i * 4 + 3] = uint16Data[i * 2 + 1] * scale;
			}
		} else if (result.channels === 1) {
			// Grayscale to RGBA
			float32Data = new Float32Array(pixelCount * 4);
			for (let i = 0; i < pixelCount; i++) {
				const v = uint16Data[i] * scale;
				float32Data[i * 4] = v;
				float32Data[i * 4 + 1] = v;
				float32Data[i * 4 + 2] = v;
				float32Data[i * 4 + 3] = 1.0;
			}
		}
	}

	return {
		width: result.width,
		height: result.height,
		depth: result.depth,
		channels: result.channels,
		data: result.data,
		float32Data
	};
}
