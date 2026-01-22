/**
 * WebGL2-accelerated image processing with 16-bit precision
 *
 * Uses RGBA16F textures (16-bit half-float) for high dynamic range processing.
 * Accepts Float32Array input (0.0-1.0 range) and outputs Float32Array.
 */

let gl = null;
let program = null;
let blurProgram = null;
let inputTexture = null;
let outputTexture = null;
let blurTempTexture = null;
let framebuffer = null;
let blurFramebuffer = null;
let positionBuffer = null;
let texCoordBuffer = null;
let canvas = null;
let initialized = false;
let currentWidth = 0;
let currentHeight = 0;

// WebGL2 ES 3.0 vertex shader
const vertexShaderSource = `#version 300 es
	in vec2 a_position;
	in vec2 a_texCoord;
	out vec2 v_texCoord;
	void main() {
		gl_Position = vec4(a_position, 0, 1);
		v_texCoord = a_texCoord;
	}
`;

// Separable Gaussian blur fragment shader
// Uses a 1D kernel in either horizontal or vertical direction
const blurFragmentShaderSource = `#version 300 es
	precision highp float;
	in vec2 v_texCoord;
	out vec4 fragColor;

	uniform sampler2D u_image;
	uniform vec2 u_direction; // (1/width, 0) for horizontal, (0, 1/height) for vertical
	uniform int u_kernelSize; // Must be odd (3, 5, 7, etc.)
	uniform float u_weights[64]; // Pre-computed Gaussian weights

	void main() {
		vec4 sum = vec4(0.0);
		int halfSize = u_kernelSize / 2;

		for (int i = 0; i < u_kernelSize; i++) {
			if (i >= 64) break; // Safety limit
			float offset = float(i - halfSize);
			vec2 sampleCoord = v_texCoord + u_direction * offset;
			sum += texture(u_image, sampleCoord) * u_weights[i];
		}

		fragColor = sum;
	}
`;

// WebGL2 ES 3.0 fragment shader with highp float precision
const fragmentShaderSource = `#version 300 es
	precision highp float;
	in vec2 v_texCoord;
	out vec4 fragColor;

	uniform sampler2D u_image;
	uniform float u_gain;
	uniform float u_contrast;
	uniform float u_gamma;
	uniform float u_saturation;
	uniform float u_vibrance;

	void main() {
		vec4 color = texture(u_image, v_texCoord);

		// Apply gain
		vec3 rgb = color.rgb * u_gain;

		// Apply contrast: (value - 0.5) * contrast + 0.5
		rgb = (rgb - 0.5) * u_contrast + 0.5;

		// Clamp before gamma (avoid negative values for pow)
		rgb = max(rgb, vec3(0.0));

		// Apply gamma
		float invGamma = 1.0 / u_gamma;
		rgb = pow(rgb, vec3(invGamma));

		// Apply saturation
		// Luminance (Rec. 709)
		float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
		rgb = vec3(lum) + u_saturation * (rgb - vec3(lum));

		// Apply vibrance (boosts less-saturated colors more)
		float maxC = max(max(rgb.r, rgb.g), rgb.b);
		float minC = min(min(rgb.r, rgb.g), rgb.b);
		float currentSat = maxC > 0.0 ? (maxC - minC) / maxC : 0.0;
		float vibranceAmount = u_vibrance * (1.0 - currentSat);
		float lum2 = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
		rgb = rgb + (rgb - vec3(lum2)) * vibranceAmount;

		// Final clamp (allow slight overshoot for HDR, clamp to 0-1 for display)
		rgb = clamp(rgb, 0.0, 1.0);

		fragColor = vec4(rgb, color.a);
	}
`;

function createShader(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.error('WebGL2 shader compile error:', gl.getShaderInfoLog(shader));
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
	const prog = gl.createProgram();
	gl.attachShader(prog, vertexShader);
	gl.attachShader(prog, fragmentShader);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		console.error('WebGL2 program link error:', gl.getProgramInfoLog(prog));
		gl.deleteProgram(prog);
		return null;
	}
	return prog;
}

/**
 * Initialize WebGL2 context with RGBA16F texture support
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {boolean} True if WebGL2 with float textures is available
 */
export function initWebGL2(width, height) {
	if (initialized && canvas && currentWidth === width && currentHeight === height) {
		return true;
	}

	// Clean up previous context if dimensions changed
	if (initialized) {
		disposeWebGL2();
	}

	// Create offscreen canvas for WebGL2
	canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
	if (!gl) {
		console.warn('WebGL2 not available');
		return false;
	}

	// Check for EXT_color_buffer_float extension (required for rendering to float textures)
	const floatExt = gl.getExtension('EXT_color_buffer_float');
	if (!floatExt) {
		console.warn('EXT_color_buffer_float not available, cannot use RGBA16F framebuffer');
		// We can still use RGBA16F textures for input, but can't render to them
		// Fall back to RGBA8 output
	}

	// Create shaders and program
	const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
	const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
	if (!vertexShader || !fragmentShader) {
		disposeWebGL2();
		return false;
	}

	program = createProgram(gl, vertexShader, fragmentShader);
	if (!program) {
		disposeWebGL2();
		return false;
	}

	// Clean up shaders (they're linked to program now)
	gl.deleteShader(vertexShader);
	gl.deleteShader(fragmentShader);

	// Create blur shaders and program
	const blurVertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
	const blurFragmentShader = createShader(gl, gl.FRAGMENT_SHADER, blurFragmentShaderSource);
	if (blurVertexShader && blurFragmentShader) {
		blurProgram = createProgram(gl, blurVertexShader, blurFragmentShader);
		gl.deleteShader(blurVertexShader);
		gl.deleteShader(blurFragmentShader);
	}

	// Set up position buffer (full-screen quad)
	positionBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		-1, -1,
		 1, -1,
		-1,  1,
		-1,  1,
		 1, -1,
		 1,  1,
	]), gl.STATIC_DRAW);

	// Texture coordinate buffer
	texCoordBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		0, 1,
		1, 1,
		0, 0,
		0, 0,
		1, 1,
		1, 0,
	]), gl.STATIC_DRAW);

	// Create input texture (RGBA16F for 16-bit precision)
	inputTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	// Allocate RGBA16F texture
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);

	// Create output texture and framebuffer for render-to-texture
	outputTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, outputTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);

	// Create framebuffer and attach output texture
	framebuffer = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);

	// Create temp texture for blur (intermediate horizontal pass result)
	blurTempTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, blurTempTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);

	// Create blur framebuffer for intermediate pass
	blurFramebuffer = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, blurFramebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blurTempTexture, 0);

	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

	// Check framebuffer status
	const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
	if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
		console.warn('WebGL2 framebuffer not complete:', fbStatus);
		// Fall back to default framebuffer (screen)
		gl.deleteFramebuffer(framebuffer);
		framebuffer = null;
	}

	// Unbind framebuffer
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	currentWidth = width;
	currentHeight = height;
	initialized = true;
	return true;
}

/**
 * Upload Float32Array image data to WebGL2 RGBA16F texture
 * @param {Float32Array} data - RGBA float data (0.0-1.0 range)
 * @param {number} width - Image width
 * @param {number} height - Image height
 */
export function uploadFloat32Data(data, width, height) {
	if (!initialized || !gl) return false;

	// Reinitialize if dimensions changed
	if (width !== currentWidth || height !== currentHeight) {
		initWebGL2(width, height);
	}

	// Upload to input texture
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data);
	return true;
}

/**
 * Process image with WebGL2 color adjustments
 * @param {Float32Array} data - RGBA float data (0.0-1.0 range)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} gain - Gain multiplier
 * @param {number} contrast - Contrast multiplier
 * @param {number} gamma - Gamma value
 * @param {number} saturation - Saturation multiplier
 * @param {number} vibrance - Vibrance amount
 * @returns {Float32Array|null} Processed RGBA float data, or null on failure
 */
export function processWithWebGL2(data, width, height, gain, contrast, gamma, saturation, vibrance) {
	if (!initialized || !gl) {
		return null;
	}

	// Reinitialize if dimensions changed
	if (width !== currentWidth || height !== currentHeight) {
		if (!initWebGL2(width, height)) {
			return null;
		}
	}

	// Upload input data
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data);

	// Render to framebuffer (or screen if framebuffer unavailable)
	if (framebuffer) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	} else {
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	// Use program
	gl.useProgram(program);

	// Set up position attribute
	const positionLocation = gl.getAttribLocation(program, 'a_position');
	gl.enableVertexAttribArray(positionLocation);
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

	// Set up texCoord attribute
	const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
	gl.enableVertexAttribArray(texCoordLocation);
	gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
	gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

	// Bind input texture
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);

	// Set uniforms
	gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
	gl.uniform1f(gl.getUniformLocation(program, 'u_gain'), gain);
	gl.uniform1f(gl.getUniformLocation(program, 'u_contrast'), contrast);
	gl.uniform1f(gl.getUniformLocation(program, 'u_gamma'), gamma);
	gl.uniform1f(gl.getUniformLocation(program, 'u_saturation'), saturation);
	gl.uniform1f(gl.getUniformLocation(program, 'u_vibrance'), vibrance);

	// Draw
	gl.viewport(0, 0, width, height);
	gl.drawArrays(gl.TRIANGLES, 0, 6);

	// Read back pixels as float
	const pixels = new Float32Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);

	// WebGL has Y-axis flipped, need to flip it back
	const flippedPixels = new Float32Array(width * height * 4);
	const rowSize = width * 4;
	for (let y = 0; y < height; y++) {
		const srcRow = (height - 1 - y) * rowSize;
		const dstRow = y * rowSize;
		flippedPixels.set(pixels.subarray(srcRow, srcRow + rowSize), dstRow);
	}

	// Unbind framebuffer
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	return flippedPixels;
}

/**
 * Process image and return 8-bit ImageData (for display compatibility)
 * @param {Float32Array} data - RGBA float data (0.0-1.0 range)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} gain - Gain multiplier
 * @param {number} contrast - Contrast multiplier
 * @param {number} gamma - Gamma value
 * @param {number} saturation - Saturation multiplier
 * @param {number} vibrance - Vibrance amount
 * @returns {ImageData|null} 8-bit ImageData, or null on failure
 */
export function processWithWebGL2ToImageData(data, width, height, gain, contrast, gamma, saturation, vibrance) {
	const floatResult = processWithWebGL2(data, width, height, gain, contrast, gamma, saturation, vibrance);
	if (!floatResult) return null;

	// Convert float (0.0-1.0) to 8-bit (0-255)
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < floatResult.length; i++) {
		pixels[i] = Math.round(Math.max(0, Math.min(1, floatResult[i])) * 255);
	}

	return new ImageData(pixels, width, height);
}

/**
 * Compute Gaussian weights for a 1D kernel
 * @param {number} kernelSize - Kernel size (must be odd)
 * @returns {Float32Array} Normalized Gaussian weights
 */
function computeGaussianWeights(kernelSize) {
	const sigma = kernelSize / 6.0; // Standard approximation
	const halfSize = Math.floor(kernelSize / 2);
	const weights = new Float32Array(kernelSize);
	let sum = 0;

	for (let i = 0; i < kernelSize; i++) {
		const x = i - halfSize;
		weights[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
		sum += weights[i];
	}

	// Normalize
	for (let i = 0; i < kernelSize; i++) {
		weights[i] /= sum;
	}

	return weights;
}

/**
 * Apply Gaussian blur using WebGL2 (separable - horizontal then vertical pass)
 * @param {Float32Array} data - RGBA float data (0.0-1.0 range)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} kernelSize - Blur kernel size (will be made odd if even)
 * @returns {Float32Array|null} Blurred RGBA float data, or null on failure
 */
export function blurWithWebGL2(data, width, height, kernelSize) {
	if (!initialized || !gl || !blurProgram) {
		return null;
	}

	// Ensure kernel size is odd and within limits
	kernelSize = Math.max(3, Math.min(63, kernelSize | 1));

	// Reinitialize if dimensions changed
	if (width !== currentWidth || height !== currentHeight) {
		if (!initWebGL2(width, height)) {
			return null;
		}
	}

	const weights = computeGaussianWeights(kernelSize);

	// Upload input data
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data);

	// Use blur program
	gl.useProgram(blurProgram);

	// Set up position attribute
	const positionLocation = gl.getAttribLocation(blurProgram, 'a_position');
	gl.enableVertexAttribArray(positionLocation);
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

	// Set up texCoord attribute
	const texCoordLocation = gl.getAttribLocation(blurProgram, 'a_texCoord');
	gl.enableVertexAttribArray(texCoordLocation);
	gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
	gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

	// Get uniform locations
	const imageLocation = gl.getUniformLocation(blurProgram, 'u_image');
	const directionLocation = gl.getUniformLocation(blurProgram, 'u_direction');
	const kernelSizeLocation = gl.getUniformLocation(blurProgram, 'u_kernelSize');
	const weightsLocation = gl.getUniformLocation(blurProgram, 'u_weights');

	gl.uniform1i(imageLocation, 0);
	gl.uniform1i(kernelSizeLocation, kernelSize);
	gl.uniform1fv(weightsLocation, weights);

	gl.viewport(0, 0, width, height);

	// === PASS 1: Horizontal blur (input -> blurTemp) ===
	gl.bindFramebuffer(gl.FRAMEBUFFER, blurFramebuffer);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, inputTexture);
	gl.uniform2f(directionLocation, 1.0 / width, 0.0);
	gl.drawArrays(gl.TRIANGLES, 0, 6);

	// === PASS 2: Vertical blur (blurTemp -> output) ===
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.bindTexture(gl.TEXTURE_2D, blurTempTexture);
	gl.uniform2f(directionLocation, 0.0, 1.0 / height);
	gl.drawArrays(gl.TRIANGLES, 0, 6);

	// Read back pixels as float
	const pixels = new Float32Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);

	// Note: With two passes, the texture coordinate Y-flip happens twice,
	// canceling out. So the result is already in correct orientation.
	// No flip needed here (unlike single-pass processWithWebGL2).

	// Unbind framebuffer
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	return pixels;
}

/**
 * Check if WebGL2 with float textures is available
 * @returns {boolean} True if WebGL2 with required extensions is available
 */
export function isWebGL2Available() {
	if (typeof document === 'undefined') return false;

	const testCanvas = document.createElement('canvas');
	const testGl = testCanvas.getContext('webgl2');
	if (!testGl) return false;

	// Check for float texture extension
	const floatExt = testGl.getExtension('EXT_color_buffer_float');
	return !!floatExt;
}

/**
 * Clean up WebGL2 resources
 */
export function disposeWebGL2() {
	if (gl) {
		if (inputTexture) gl.deleteTexture(inputTexture);
		if (outputTexture) gl.deleteTexture(outputTexture);
		if (blurTempTexture) gl.deleteTexture(blurTempTexture);
		if (framebuffer) gl.deleteFramebuffer(framebuffer);
		if (blurFramebuffer) gl.deleteFramebuffer(blurFramebuffer);
		if (positionBuffer) gl.deleteBuffer(positionBuffer);
		if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
		if (program) gl.deleteProgram(program);
		if (blurProgram) gl.deleteProgram(blurProgram);
	}
	gl = null;
	program = null;
	blurProgram = null;
	inputTexture = null;
	outputTexture = null;
	blurTempTexture = null;
	framebuffer = null;
	blurFramebuffer = null;
	positionBuffer = null;
	texCoordBuffer = null;
	canvas = null;
	initialized = false;
	currentWidth = 0;
	currentHeight = 0;
}

/**
 * Get the WebGL2 context (for advanced usage)
 * @returns {WebGL2RenderingContext|null} The WebGL2 context
 */
export function getWebGL2Context() {
	return gl;
}
