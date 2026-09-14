/**
 * Estimate how strongly an image is oversampled by measuring edge transition
 * widths. If the sharpest edges span more than ~2 pixels (Nyquist), the image
 * is oversampled and downsizing can restore apparent sharpness at 1:1 view.
 *
 * @param {Float32Array} rgba - Source RGBA data (0.0-1.0)
 * @param {number} width
 * @param {number} height
 * @returns {{ suggestedPercent: number, edgeWidth: number|null, sampleCount: number, strongestEdge: {x:number,y:number}|null, suggestions: {aggressive:number,balanced:number,conservative:number}|null }}
 */
export function estimateOversampling(rgba, width, height) {
	if (width < 32 || height < 32) {
		return { suggestedPercent: 100, edgeWidth: null, sampleCount: 0, strongestEdge: null, suggestions: null };
	}

	const N = width * height;
	const lum = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const j = i * 4;
		lum[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
	}

	const gx = new Float32Array(N);
	const gy = new Float32Array(N);
	const mag = new Float32Array(N);
	let maxMag = 0;
	let maxIdx = -1;

	for (let y = 1; y < height - 1; y++) {
		let idx = y * width + 1;
		for (let x = 1; x < width - 1; x++, idx++) {
			const tl = lum[idx - width - 1], tc = lum[idx - width], tr = lum[idx - width + 1];
			const ml = lum[idx - 1], mr = lum[idx + 1];
			const bl = lum[idx + width - 1], bc = lum[idx + width], br = lum[idx + width + 1];
			const sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
			const sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
			gx[idx] = sx;
			gy[idx] = sy;
			const m = Math.hypot(sx, sy);
			mag[idx] = m;
			if (m > maxMag) { maxMag = m; maxIdx = idx; }
		}
	}

	if (maxMag < 0.01) {
		return { suggestedPercent: 100, edgeWidth: null, sampleCount: 0, strongestEdge: null, suggestions: null };
	}

	const strongestEdge = maxIdx >= 0
		? { x: maxIdx % width, y: Math.floor(maxIdx / width) }
		: null;

	// Histogram-based percentile threshold (top 0.5% of gradient magnitudes)
	const bins = 512;
	const hist = new Uint32Array(bins);
	const invMax = (bins - 1) / maxMag;
	for (let i = 0; i < N; i++) {
		if (mag[i] > 0) hist[Math.floor(mag[i] * invMax)]++;
	}
	const target = Math.max(200, Math.floor(N * 0.005));
	let cum = 0;
	let threshold = maxMag;
	for (let b = bins - 1; b >= 0; b--) {
		cum += hist[b];
		if (cum >= target) {
			threshold = (b / (bins - 1)) * maxMag;
			break;
		}
	}

	const widths = [];
	const border = 8;
	const step = 3;
	const R = 4;

	for (let y = border; y < height - border; y += step) {
		for (let x = border; x < width - border; x += step) {
			const idx = y * width + x;
			if (mag[idx] < threshold) continue;

			const g = mag[idx];
			const dx = gx[idx] / g;
			const dy = gy[idx] / g;

			const samples = new Float32Array(2 * R + 1);
			let ok = true;
			for (let k = -R; k <= R; k++) {
				const sx = x + k * dx;
				const sy = y + k * dy;
				if (sx < 0 || sx >= width - 1 || sy < 0 || sy >= height - 1) { ok = false; break; }
				samples[k + R] = bilinearSample(lum, width, sx, sy);
			}
			if (!ok) continue;

			const w = transitionWidth10to90(samples);
			if (w !== null && w >= 0.6 && w <= 8) widths.push(w);
		}
	}

	if (widths.length < 10) {
		return { suggestedPercent: 100, edgeWidth: null, sampleCount: widths.length, strongestEdge, suggestions: null };
	}

	widths.sort((a, b) => a - b);
	const median = widths[Math.floor(widths.length / 2)];

	// Three targets for 10-90% edge width in px. Aggressive = tight Nyquist,
	// conservative = comfortable oversampling headroom. Below target*1.2 we
	// consider the image already well sampled for that target.
	const percentFor = (target) => {
		if (median < target * 1.2) return 100;
		const scale = Math.max(0.3, Math.min(1.0, target / median));
		return Math.round(scale * 20) * 5;
	};
	const suggestions = {
		aggressive: percentFor(2.0),
		balanced: percentFor(2.5),
		conservative: percentFor(3.0)
	};

	return {
		suggestedPercent: suggestions.aggressive,
		edgeWidth: median,
		sampleCount: widths.length,
		strongestEdge,
		suggestions
	};
}

function bilinearSample(data, width, x, y) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const idx = y0 * width + x0;
	const v00 = data[idx];
	const v10 = data[idx + 1];
	const v01 = data[idx + width];
	const v11 = data[idx + width + 1];
	const v0 = v00 + (v10 - v00) * fx;
	const v1 = v01 + (v11 - v01) * fx;
	return v0 + (v1 - v0) * fy;
}

function transitionWidth10to90(samples) {
	const n = samples.length;
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < n; i++) {
		if (samples[i] < lo) lo = samples[i];
		if (samples[i] > hi) hi = samples[i];
	}
	const range = hi - lo;
	if (range < 0.02) return null;

	// Samples run along the gradient direction so the profile is monotonic
	// from lo → hi. Find first crossings of the 10% and 90% levels.
	const t10 = lo + 0.1 * range;
	const t90 = lo + 0.9 * range;
	let p10 = null, p90 = null;
	for (let i = 0; i < n - 1; i++) {
		const a = samples[i], b = samples[i + 1];
		if (p10 === null && ((a <= t10 && b >= t10) || (a >= t10 && b <= t10))) {
			const denom = b - a;
			p10 = denom === 0 ? i : i + (t10 - a) / denom;
		}
		if (p90 === null && ((a <= t90 && b >= t90) || (a >= t90 && b <= t90))) {
			const denom = b - a;
			p90 = denom === 0 ? i : i + (t90 - a) / denom;
		}
	}
	if (p10 === null || p90 === null) return null;
	return Math.abs(p90 - p10);
}
