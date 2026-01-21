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
