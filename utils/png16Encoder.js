/**
 * 16-bit PNG encoder using UPNG.js
 *
 * Exports Float32Array image data as 16-bit PNG files.
 * UPNG.js is dynamically imported to avoid bundling overhead when not used.
 */

let UPNG = null;

/**
 * Load UPNG.js library
 * @returns {Promise<Object>} UPNG module
 */
async function loadUPNG() {
	if (UPNG) return UPNG;

	// Dynamic import of UPNG.js
	const module = await import('upng-js');
	UPNG = module.default || module;
	return UPNG;
}

/**
 * Encode Float32Array image data as 16-bit PNG
 * @param {Float32Array} data - RGBA data in 0.0-1.0 range
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Promise<Blob>} PNG blob
 */
export async function encode16BitPNG(data, width, height) {
	const upng = await loadUPNG();

	// Convert Float32Array (0.0-1.0) to Uint16Array (0-65535)
	// UPNG expects RGBA16 data in Uint16Array or Uint8Array view of the same buffer
	const uint16Data = new Uint16Array(data.length);
	const scale = 65535;

	for (let i = 0; i < data.length; i++) {
		// Clamp to 0-1 range and scale to 16-bit
		uint16Data[i] = Math.round(Math.max(0, Math.min(1, data[i])) * scale);
	}

	// UPNG.encode expects the buffer and interprets it based on the depth parameter
	// For 16-bit, pass ctype=6 (RGBA), depth=16
	// Note: UPNG.encode signature: encode(imgs, w, h, cnum, dels, forbidPlte)
	// For a single image: encode([buffer], w, h, 0)
	// But for 16-bit we need to use encodeLL which gives more control

	// Convert to ArrayBuffer view that UPNG can use
	const buffer = uint16Data.buffer;

	// UPNG.encodeLL(width, height, cnum, depth, ctype, rgba, dels)
	// ctype: 0=grayscale, 2=RGB, 4=grayscale+alpha, 6=RGBA
	// depth: 8 or 16
	const pngBuffer = upng.encodeLL([buffer], width, height, 4, 1, 16, [0]);

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
	const upng = await loadUPNG();

	const pngBuffer = upng.encodeLL([uint16Data.buffer], width, height, 4, 1, 16, [0]);

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
