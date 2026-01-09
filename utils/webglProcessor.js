// WebGL-accelerated image processing for real-time adjustments

let gl = null;
let program = null;
let texture = null;
let framebuffer = null;
let outputTexture = null;
let positionBuffer = null;
let texCoordBuffer = null;
let canvas = null;
let initialized = false;

const vertexShaderSource = `
	attribute vec2 a_position;
	attribute vec2 a_texCoord;
	varying vec2 v_texCoord;
	void main() {
		gl_Position = vec4(a_position, 0, 1);
		v_texCoord = a_texCoord;
	}
`;

const fragmentShaderSource = `
	precision mediump float;
	varying vec2 v_texCoord;
	uniform sampler2D u_image;
	uniform float u_gain;
	uniform float u_contrast;
	uniform float u_gamma;
	uniform float u_saturation;

	void main() {
		vec4 color = texture2D(u_image, v_texCoord);

		// Apply gain
		vec3 rgb = color.rgb * u_gain;

		// Apply contrast: (value - 0.5) * contrast + 0.5
		rgb = (rgb - 0.5) * u_contrast + 0.5;

		// Clamp before gamma
		rgb = clamp(rgb, 0.0, 1.0);

		// Apply gamma
		float invGamma = 1.0 / u_gamma;
		rgb = pow(rgb, vec3(invGamma));

		// Apply saturation
		// Luminance (Rec. 709)
		float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
		rgb = vec3(lum) + u_saturation * (rgb - vec3(lum));

		// Final clamp
		rgb = clamp(rgb, 0.0, 1.0);

		gl_FragColor = vec4(rgb, color.a);
	}
`;

function createShader(gl, type, source) {
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

function createProgram(gl, vertexShader, fragmentShader) {
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

export function initWebGL(width, height) {
	if (initialized && canvas && canvas.width === width && canvas.height === height) {
		return true;
	}

	// Create offscreen canvas for WebGL
	canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
	if (!gl) {
		console.warn('WebGL not available, falling back to CPU processing');
		return false;
	}

	// Create shaders and program
	const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
	const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
	if (!vertexShader || !fragmentShader) return false;

	program = createProgram(gl, vertexShader, fragmentShader);
	if (!program) return false;

	// Set up buffers
	// Position buffer (full-screen quad)
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

	// Create texture for input image
	texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

	initialized = true;
	return true;
}

export function processWithWebGL(imageData, gain, contrast, gamma, saturation) {
	if (!initialized || !gl) {
		return null;
	}

	const width = imageData.width;
	const height = imageData.height;

	// Resize canvas if needed
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
		gl.viewport(0, 0, width, height);
	}

	// Upload image data to texture
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);

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

	// Set uniforms
	gl.uniform1f(gl.getUniformLocation(program, 'u_gain'), gain);
	gl.uniform1f(gl.getUniformLocation(program, 'u_contrast'), contrast);
	gl.uniform1f(gl.getUniformLocation(program, 'u_gamma'), gamma);
	gl.uniform1f(gl.getUniformLocation(program, 'u_saturation'), saturation);

	// Draw
	gl.viewport(0, 0, width, height);
	gl.drawArrays(gl.TRIANGLES, 0, 6);

	// Read back pixels
	const pixels = new Uint8ClampedArray(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

	// WebGL has Y-axis flipped, need to flip it back
	const flippedPixels = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const srcRow = (height - 1 - y) * width * 4;
		const dstRow = y * width * 4;
		flippedPixels.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow);
	}

	return new ImageData(flippedPixels, width, height);
}

export function isWebGLAvailable() {
	if (typeof document === 'undefined') return false;
	const testCanvas = document.createElement('canvas');
	const testGl = testCanvas.getContext('webgl');
	return !!testGl;
}

export function disposeWebGL() {
	if (gl) {
		if (texture) gl.deleteTexture(texture);
		if (positionBuffer) gl.deleteBuffer(positionBuffer);
		if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
		if (program) gl.deleteProgram(program);
	}
	gl = null;
	program = null;
	texture = null;
	positionBuffer = null;
	texCoordBuffer = null;
	canvas = null;
	initialized = false;
}
