// WebGL-accelerated Richardson-Lucy deconvolution
// Uses GPU for massive speedup over CPU implementation

let gl = null;
let canvas = null;
let initialized = false;

// Shader programs
let convProgram = null;
let divideProgram = null;
let multiplyProgram = null;
let copyProgram = null;

// Buffers
let positionBuffer = null;
let texCoordBuffer = null;

// Textures and framebuffers for ping-pong
let observedTex = null;
let estimateTex = null;
let estimateTex2 = null;
let blurredTex = null;
let ratioTex = null;
let correctionTex = null;
let psfTex = null;
let psfFlippedTex = null;

let estimateFB = null;
let estimateFB2 = null;
let blurredFB = null;
let ratioFB = null;
let correctionFB = null;

let currentWidth = 0;
let currentHeight = 0;

// Vertex shader (shared)
const vertexShaderSource = `
	attribute vec2 a_position;
	attribute vec2 a_texCoord;
	varying vec2 v_texCoord;
	void main() {
		gl_Position = vec4(a_position, 0, 1);
		v_texCoord = a_texCoord;
	}
`;

// Convolution shader - applies PSF kernel
const convFragmentSource = `
	precision highp float;
	varying vec2 v_texCoord;
	uniform sampler2D u_image;
	uniform sampler2D u_kernel;
	uniform vec2 u_imageSize;
	uniform vec2 u_kernelSize;

	void main() {
		vec2 onePixel = 1.0 / u_imageSize;
		int kernelW = int(u_kernelSize.x);
		int kernelH = int(u_kernelSize.y);
		int halfW = kernelW / 2;
		int halfH = kernelH / 2;

		vec4 sum = vec4(0.0);

		for (int ky = 0; ky < 64; ky++) {
			if (ky >= kernelH) break;
			for (int kx = 0; kx < 64; kx++) {
				if (kx >= kernelW) break;

				vec2 offset = vec2(float(kx - halfW), float(ky - halfH)) * onePixel;
				vec2 kernelCoord = vec2(float(kx) + 0.5, float(ky) + 0.5) / u_kernelSize;

				vec4 pixel = texture2D(u_image, v_texCoord + offset);
				float weight = texture2D(u_kernel, kernelCoord).r;
				sum += pixel * weight;
			}
		}

		gl_FragColor = sum;
	}
`;

// Division shader: a / b (with epsilon to avoid div by zero)
const divideFragmentSource = `
	precision highp float;
	varying vec2 v_texCoord;
	uniform sampler2D u_texA;
	uniform sampler2D u_texB;

	void main() {
		vec4 a = texture2D(u_texA, v_texCoord);
		vec4 b = texture2D(u_texB, v_texCoord);
		vec4 result = a / max(b, vec4(0.0001));
		gl_FragColor = result;
	}
`;

// Multiplication shader: a * b
const multiplyFragmentSource = `
	precision highp float;
	varying vec2 v_texCoord;
	uniform sampler2D u_texA;
	uniform sampler2D u_texB;

	void main() {
		vec4 a = texture2D(u_texA, v_texCoord);
		vec4 b = texture2D(u_texB, v_texCoord);
		gl_FragColor = a * b;
	}
`;

// Simple copy shader
const copyFragmentSource = `
	precision highp float;
	varying vec2 v_texCoord;
	uniform sampler2D u_image;

	void main() {
		gl_FragColor = texture2D(u_image, v_texCoord);
	}
`;

function createShader(type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.error('Shader compile error:', gl.getShaderInfoLog(shader));
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function createProgram(fragSource) {
	const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
	const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragSource);
	if (!vertexShader || !fragmentShader) return null;

	const program = gl.createProgram();
	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);

	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		console.error('Program link error:', gl.getProgramInfoLog(program));
		gl.deleteProgram(program);
		return null;
	}
	return program;
}

function createFloatTexture(width, height, data = null) {
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	if (data) {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, data);
	} else {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
	}
	return tex;
}

function createFramebuffer(texture) {
	const fb = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
	return fb;
}

function createGaussianPSF(radius) {
	const size = Math.max(3, Math.ceil(radius * 6) | 1);
	const center = Math.floor(size / 2);
	const sigma = radius;
	const data = new Float32Array(size * size * 4);
	let sum = 0;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - center;
			const dy = y - center;
			const value = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
			const idx = (y * size + x) * 4;
			data[idx] = value;
			data[idx + 1] = value;
			data[idx + 2] = value;
			data[idx + 3] = 1;
			sum += value;
		}
	}

	// Normalize
	for (let i = 0; i < data.length; i += 4) {
		data[i] /= sum;
		data[i + 1] /= sum;
		data[i + 2] /= sum;
	}

	return { data, size };
}

function createFlippedPSF(psfData, size) {
	const flipped = new Float32Array(psfData.length);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const srcIdx = (y * size + x) * 4;
			const dstIdx = ((size - 1 - y) * size + (size - 1 - x)) * 4;
			flipped[dstIdx] = psfData[srcIdx];
			flipped[dstIdx + 1] = psfData[srcIdx + 1];
			flipped[dstIdx + 2] = psfData[srcIdx + 2];
			flipped[dstIdx + 3] = 1;
		}
	}
	return flipped;
}

export function initDeconvWebGL(width, height) {
	// Create offscreen canvas
	canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
	if (!gl) {
		console.warn('WebGL not available for deconvolution');
		return false;
	}

	// Check for float texture support
	const floatExt = gl.getExtension('OES_texture_float');
	if (!floatExt) {
		console.warn('OES_texture_float not available, deconv will fall back to CPU');
		return false;
	}

	// Also need float linear filtering for quality (optional but nice)
	gl.getExtension('OES_texture_float_linear');

	// Create shader programs
	convProgram = createProgram(convFragmentSource);
	divideProgram = createProgram(divideFragmentSource);
	multiplyProgram = createProgram(multiplyFragmentSource);
	copyProgram = createProgram(copyFragmentSource);

	if (!convProgram || !divideProgram || !multiplyProgram || !copyProgram) {
		console.error('Failed to create deconv shader programs');
		return false;
	}

	// Create position buffer
	positionBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		-1, -1, 1, -1, -1, 1,
		-1, 1, 1, -1, 1, 1,
	]), gl.STATIC_DRAW);

	// Create texcoord buffer
	texCoordBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		0, 0, 1, 0, 0, 1,
		0, 1, 1, 0, 1, 1,
	]), gl.STATIC_DRAW);

	currentWidth = width;
	currentHeight = height;
	initialized = true;

	return true;
}

function setupProgram(program) {
	gl.useProgram(program);

	const posLoc = gl.getAttribLocation(program, 'a_position');
	gl.enableVertexAttribArray(posLoc);
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

	const texLoc = gl.getAttribLocation(program, 'a_texCoord');
	gl.enableVertexAttribArray(texLoc);
	gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
	gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
}

function renderToFramebuffer(fb) {
	gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
	gl.viewport(0, 0, currentWidth, currentHeight);
	gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function convolve(inputTex, kernelTex, kernelSize, outputFB) {
	setupProgram(convProgram);

	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, inputTex);
	gl.uniform1i(gl.getUniformLocation(convProgram, 'u_image'), 0);

	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, kernelTex);
	gl.uniform1i(gl.getUniformLocation(convProgram, 'u_kernel'), 1);

	gl.uniform2f(gl.getUniformLocation(convProgram, 'u_imageSize'), currentWidth, currentHeight);
	gl.uniform2f(gl.getUniformLocation(convProgram, 'u_kernelSize'), kernelSize, kernelSize);

	renderToFramebuffer(outputFB);
}

function divide(texA, texB, outputFB) {
	setupProgram(divideProgram);

	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, texA);
	gl.uniform1i(gl.getUniformLocation(divideProgram, 'u_texA'), 0);

	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, texB);
	gl.uniform1i(gl.getUniformLocation(divideProgram, 'u_texB'), 1);

	renderToFramebuffer(outputFB);
}

function multiply(texA, texB, outputFB) {
	setupProgram(multiplyProgram);

	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, texA);
	gl.uniform1i(gl.getUniformLocation(multiplyProgram, 'u_texA'), 0);

	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, texB);
	gl.uniform1i(gl.getUniformLocation(multiplyProgram, 'u_texB'), 1);

	renderToFramebuffer(outputFB);
}

export async function deconvolveWebGL(imageData, psfRadius, iterations, onProgress = null) {
	const width = imageData.width;
	const height = imageData.height;

	// Convert imageData to float RGBA and use internal 16-bit function
	const floatData = new Float32Array(width * height * 4);
	for (let i = 0; i < imageData.data.length; i++) {
		floatData[i] = imageData.data[i] / 255.0;
	}

	const resultFloat = await deconvolveWebGL16(floatData, width, height, psfRadius, iterations, onProgress);
	if (!resultFloat) return null;

	// Convert back to Uint8
	const resultData = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < resultFloat.length; i++) {
		resultData[i] = Math.max(0, Math.min(255, Math.round(resultFloat[i] * 255)));
	}

	return new ImageData(resultData, width, height);
}

/**
 * 16-bit deconvolution - accepts and returns Float32Array (0.0-1.0 range)
 */
export async function deconvolveWebGL16(floatData, width, height, psfRadius, iterations, onProgress = null) {
	// Initialize or reinitialize if size changed
	if (!initialized || width !== currentWidth || height !== currentHeight) {
		disposeDeconvWebGL();
		if (!initDeconvWebGL(width, height)) {
			return null; // Fall back to CPU
		}
	}

	// Create PSF textures
	const psf = createGaussianPSF(psfRadius);
	const psfFlipped = createFlippedPSF(psf.data, psf.size);

	psfTex = createFloatTexture(psf.size, psf.size, psf.data);
	psfFlippedTex = createFloatTexture(psf.size, psf.size, psfFlipped);

	// Create working textures
	observedTex = createFloatTexture(width, height, floatData);
	estimateTex = createFloatTexture(width, height, floatData); // Start with observed
	estimateTex2 = createFloatTexture(width, height);
	blurredTex = createFloatTexture(width, height);
	ratioTex = createFloatTexture(width, height);
	correctionTex = createFloatTexture(width, height);

	// Create framebuffers
	estimateFB = createFramebuffer(estimateTex);
	estimateFB2 = createFramebuffer(estimateTex2);
	blurredFB = createFramebuffer(blurredTex);
	ratioFB = createFramebuffer(ratioTex);
	correctionFB = createFramebuffer(correctionTex);

	// Richardson-Lucy iterations
	let currentEstimate = estimateTex;
	let currentEstimateFB = estimateFB;
	let nextEstimate = estimateTex2;
	let nextEstimateFB = estimateFB2;

	for (let i = 0; i < iterations; i++) {
		// blurred = convolve(estimate, PSF)
		convolve(currentEstimate, psfTex, psf.size, blurredFB);

		// ratio = observed / blurred
		divide(observedTex, blurredTex, ratioFB);

		// correction = convolve(ratio, PSF_flipped)
		convolve(ratioTex, psfFlippedTex, psf.size, correctionFB);

		// estimate = estimate * correction
		multiply(currentEstimate, correctionTex, nextEstimateFB);

		// Swap buffers
		[currentEstimate, nextEstimate] = [nextEstimate, currentEstimate];
		[currentEstimateFB, nextEstimateFB] = [nextEstimateFB, currentEstimateFB];

		// Report progress every 10 iterations
		if (onProgress && i % 10 === 0) {
			onProgress(i / iterations);
			// Yield to UI thread
			await new Promise(r => setTimeout(r, 0));
		}
	}

	// Read back result
	gl.bindFramebuffer(gl.FRAMEBUFFER, currentEstimateFB);
	const resultFloat = new Float32Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, resultFloat);

	// Cleanup working textures (keep context for reuse)
	gl.deleteTexture(observedTex);
	gl.deleteTexture(estimateTex);
	gl.deleteTexture(estimateTex2);
	gl.deleteTexture(blurredTex);
	gl.deleteTexture(ratioTex);
	gl.deleteTexture(correctionTex);
	gl.deleteTexture(psfTex);
	gl.deleteTexture(psfFlippedTex);
	gl.deleteFramebuffer(estimateFB);
	gl.deleteFramebuffer(estimateFB2);
	gl.deleteFramebuffer(blurredFB);
	gl.deleteFramebuffer(ratioFB);
	gl.deleteFramebuffer(correctionFB);

	if (onProgress) onProgress(1);

	return resultFloat;
}

export function disposeDeconvWebGL() {
	if (gl) {
		if (convProgram) gl.deleteProgram(convProgram);
		if (divideProgram) gl.deleteProgram(divideProgram);
		if (multiplyProgram) gl.deleteProgram(multiplyProgram);
		if (copyProgram) gl.deleteProgram(copyProgram);
		if (positionBuffer) gl.deleteBuffer(positionBuffer);
		if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
	}
	gl = null;
	canvas = null;
	convProgram = null;
	divideProgram = null;
	multiplyProgram = null;
	copyProgram = null;
	positionBuffer = null;
	texCoordBuffer = null;
	initialized = false;
	currentWidth = 0;
	currentHeight = 0;
}

export function isDeconvWebGLAvailable() {
	if (typeof document === 'undefined') return false;
	const testCanvas = document.createElement('canvas');
	const testGl = testCanvas.getContext('webgl');
	if (!testGl) return false;
	const floatExt = testGl.getExtension('OES_texture_float');
	return !!floatExt;
}
