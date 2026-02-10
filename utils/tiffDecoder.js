/**
 * TIFF decoder using utif2
 *
 * Decodes TIFF files and converts to Float32Array (0.0-1.0 range).
 * utif2 is dynamically imported to avoid bundling overhead when not used.
 * Always outputs 16-bit precision (Float32Array) even for 8-bit source images.
 */

let utif = null;

/**
 * Load utif2 library
 * @returns {Promise<Object>} utif2 module
 */
async function loadUtif() {
	if (utif) return utif;

	const module = await import('utif2');
	utif = module.default || module;
	return utif;
}

/**
 * Decode TIFF file to Float32Array
 * @param {ArrayBuffer} buffer - TIFF file data
 * @returns {Promise<Object>} { width, height, depth, float32Data }
 */
export async function decodeTIFF(buffer) {
	const UTIF = await loadUtif();

	// Parse TIFF structure
	const ifds = UTIF.decode(buffer);
	if (!ifds || ifds.length === 0) {
		throw new Error('No images found in TIFF file');
	}

	// Decode first image
	const ifd = ifds[0];
	UTIF.decodeImage(buffer, ifd);

	const width = ifd.width;
	const height = ifd.height;
	const data = ifd.data; // Uint8Array of raw pixel data

	// Get bit depth and samples per pixel from TIFF tags
	const bitsPerSample = ifd.t258 || [8]; // Tag 258: BitsPerSample
	const samplesPerPixel = ifd.t277 || 1; // Tag 277: SamplesPerPixel
	const depth = Array.isArray(bitsPerSample) ? bitsPerSample[0] : bitsPerSample;
	const isLittleEndian = ifd.isLE !== false; // Default to little endian

	const pixelCount = width * height;
	const float32Data = new Float32Array(pixelCount * 4);

	if (depth === 16) {
		// 16-bit TIFF
		const scale = 1 / 65535;

		if (samplesPerPixel >= 3) {
			// RGB or RGBA
			const hasAlpha = samplesPerPixel >= 4;
			const bytesPerPixel = samplesPerPixel * 2;

			for (let i = 0; i < pixelCount; i++) {
				const offset = i * bytesPerPixel;

				// Read 16-bit values respecting endianness
				let r, g, b, a;
				if (isLittleEndian) {
					r = data[offset] | (data[offset + 1] << 8);
					g = data[offset + 2] | (data[offset + 3] << 8);
					b = data[offset + 4] | (data[offset + 5] << 8);
					a = hasAlpha ? (data[offset + 6] | (data[offset + 7] << 8)) : 65535;
				} else {
					r = (data[offset] << 8) | data[offset + 1];
					g = (data[offset + 2] << 8) | data[offset + 3];
					b = (data[offset + 4] << 8) | data[offset + 5];
					a = hasAlpha ? ((data[offset + 6] << 8) | data[offset + 7]) : 65535;
				}

				float32Data[i * 4] = r * scale;
				float32Data[i * 4 + 1] = g * scale;
				float32Data[i * 4 + 2] = b * scale;
				float32Data[i * 4 + 3] = a * scale;
			}
		} else {
			// Grayscale (1 or 2 samples)
			const hasAlpha = samplesPerPixel === 2;
			const bytesPerPixel = samplesPerPixel * 2;

			for (let i = 0; i < pixelCount; i++) {
				const offset = i * bytesPerPixel;

				let v, a;
				if (isLittleEndian) {
					v = data[offset] | (data[offset + 1] << 8);
					a = hasAlpha ? (data[offset + 2] | (data[offset + 3] << 8)) : 65535;
				} else {
					v = (data[offset] << 8) | data[offset + 1];
					a = hasAlpha ? ((data[offset + 2] << 8) | data[offset + 3]) : 65535;
				}

				const vf = v * scale;
				float32Data[i * 4] = vf;
				float32Data[i * 4 + 1] = vf;
				float32Data[i * 4 + 2] = vf;
				float32Data[i * 4 + 3] = a * scale;
			}
		}
	} else {
		// 8-bit TIFF - use UTIF's toRGBA8 for proper color space handling
		const rgba8 = UTIF.toRGBA8(ifd);
		const scale = 1 / 255;

		for (let i = 0; i < pixelCount; i++) {
			float32Data[i * 4] = rgba8[i * 4] * scale;
			float32Data[i * 4 + 1] = rgba8[i * 4 + 1] * scale;
			float32Data[i * 4 + 2] = rgba8[i * 4 + 2] * scale;
			float32Data[i * 4 + 3] = rgba8[i * 4 + 3] * scale;
		}
	}

	return {
		width,
		height,
		depth,
		channels: samplesPerPixel,
		float32Data
	};
}
