/**
 * Image16 - Container class for 16-bit precision image data
 *
 * Uses Float32Array with values in 0.0-1.0 range internally because:
 * - WebGL shaders work naturally with normalized floats
 * - Mathematical operations (gamma, etc.) are more accurate
 * - No clamping issues during intermediate calculations
 */
export class Image16 {
	/**
	 * Create a new Image16 container
	 * @param {number} width - Image width in pixels
	 * @param {number} height - Image height in pixels
	 * @param {Float32Array} [data] - Optional RGBA data (0.0-1.0 range)
	 */
	constructor(width, height, data = null) {
		this.width = width;
		this.height = height;

		if (data) {
			if (data.length !== width * height * 4) {
				throw new Error(`Data length ${data.length} doesn't match dimensions ${width}x${height}x4 = ${width * height * 4}`);
			}
			this.data = data;
		} else {
			// Initialize with zeros (transparent black)
			this.data = new Float32Array(width * height * 4);
		}
	}

	/**
	 * Create Image16 from standard 8-bit ImageData
	 * @param {ImageData} imageData - Standard 8-bit RGBA ImageData
	 * @returns {Image16} New Image16 instance
	 */
	static fromImageData(imageData) {
		const { width, height, data } = imageData;
		const floatData = new Float32Array(data.length);

		// Convert 0-255 to 0.0-1.0
		const scale = 1 / 255;
		for (let i = 0; i < data.length; i++) {
			floatData[i] = data[i] * scale;
		}

		return new Image16(width, height, floatData);
	}

	/**
	 * Create Image16 from Float32Array data
	 * @param {Float32Array} data - RGBA data in 0.0-1.0 range
	 * @param {number} width - Image width
	 * @param {number} height - Image height
	 * @returns {Image16} New Image16 instance
	 */
	static fromFloat32Array(data, width, height) {
		return new Image16(width, height, data);
	}

	/**
	 * Convert to standard 8-bit ImageData for legacy compatibility
	 * @returns {ImageData} Standard 8-bit ImageData
	 */
	toImageData() {
		const data = new Uint8ClampedArray(this.data.length);

		// Convert 0.0-1.0 to 0-255 with proper clamping
		for (let i = 0; i < this.data.length; i++) {
			// Clamp to 0-1 range, then scale to 0-255
			data[i] = Math.round(Math.max(0, Math.min(1, this.data[i])) * 255);
		}

		return new ImageData(data, this.width, this.height);
	}

	/**
	 * Convert to Uint16Array for 16-bit PNG export
	 * Output is RGBA with values in 0-65535 range
	 * @returns {Uint16Array} 16-bit RGBA data
	 */
	toUint16Array() {
		const data = new Uint16Array(this.data.length);

		// Convert 0.0-1.0 to 0-65535
		const scale = 65535;
		for (let i = 0; i < this.data.length; i++) {
			data[i] = Math.round(Math.max(0, Math.min(1, this.data[i])) * scale);
		}

		return data;
	}

	/**
	 * Create a deep clone of this Image16
	 * @returns {Image16} New Image16 instance with copied data
	 */
	clone() {
		return new Image16(this.width, this.height, new Float32Array(this.data));
	}

	/**
	 * Get the underlying buffer for transferable operations (zero-copy to workers)
	 * WARNING: After transfer, this Image16 becomes unusable
	 * @returns {ArrayBuffer} The underlying ArrayBuffer
	 */
	getTransferable() {
		return this.data.buffer;
	}

	/**
	 * Create a copy of the data for transfer (preserves original)
	 * @returns {Float32Array} Copy of the data
	 */
	getDataCopy() {
		return new Float32Array(this.data);
	}

	/**
	 * Get pixel value at (x, y)
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @returns {{r: number, g: number, b: number, a: number}} RGBA values (0.0-1.0)
	 */
	getPixel(x, y) {
		const idx = (y * this.width + x) * 4;
		return {
			r: this.data[idx],
			g: this.data[idx + 1],
			b: this.data[idx + 2],
			a: this.data[idx + 3]
		};
	}

	/**
	 * Set pixel value at (x, y)
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @param {number} r - Red (0.0-1.0)
	 * @param {number} g - Green (0.0-1.0)
	 * @param {number} b - Blue (0.0-1.0)
	 * @param {number} [a=1.0] - Alpha (0.0-1.0)
	 */
	setPixel(x, y, r, g, b, a = 1.0) {
		const idx = (y * this.width + x) * 4;
		this.data[idx] = r;
		this.data[idx + 1] = g;
		this.data[idx + 2] = b;
		this.data[idx + 3] = a;
	}

	/**
	 * Rotate the image by the given angle (in degrees) around the center
	 * Uses bilinear interpolation to preserve quality
	 * @param {number} angleDegrees - Rotation angle in degrees (positive = counterclockwise)
	 * @returns {Image16} New rotated Image16 instance
	 */
	rotate(angleDegrees) {
		if (angleDegrees === 0) {
			return this.clone();
		}

		const angleRad = -angleDegrees * Math.PI / 180; // Negative for correct direction
		const cos = Math.cos(angleRad);
		const sin = Math.sin(angleRad);

		const { width, height, data: srcData } = this;
		const cx = width / 2;
		const cy = height / 2;

		// Output same size (corners will be clipped)
		const rotated = new Image16(width, height);
		const dstData = rotated.data;

		// For each output pixel, find the source position (inverse rotation)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// Translate to center, rotate, translate back
				const dx = x - cx;
				const dy = y - cy;
				const srcX = cos * dx - sin * dy + cx;
				const srcY = sin * dx + cos * dy + cy;

				const dstIdx = (y * width + x) * 4;

				// Check bounds
				if (srcX < 0 || srcX >= width - 1 || srcY < 0 || srcY >= height - 1) {
					// Out of bounds - fill with black
					dstData[dstIdx] = 0;
					dstData[dstIdx + 1] = 0;
					dstData[dstIdx + 2] = 0;
					dstData[dstIdx + 3] = 1; // Opaque black
					continue;
				}

				// Bilinear interpolation
				const x0 = Math.floor(srcX);
				const y0 = Math.floor(srcY);
				const x1 = x0 + 1;
				const y1 = y0 + 1;
				const fx = srcX - x0;
				const fy = srcY - y0;

				const idx00 = (y0 * width + x0) * 4;
				const idx10 = (y0 * width + x1) * 4;
				const idx01 = (y1 * width + x0) * 4;
				const idx11 = (y1 * width + x1) * 4;

				// Interpolate each channel
				for (let c = 0; c < 4; c++) {
					const v00 = srcData[idx00 + c];
					const v10 = srcData[idx10 + c];
					const v01 = srcData[idx01 + c];
					const v11 = srcData[idx11 + c];

					// Bilinear: lerp in x, then lerp in y
					const v0 = v00 + (v10 - v00) * fx;
					const v1 = v01 + (v11 - v01) * fx;
					dstData[dstIdx + c] = v0 + (v1 - v0) * fy;
				}
			}
		}

		return rotated;
	}
}
