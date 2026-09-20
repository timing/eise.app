/**
 * useLibRawRgb.js - RGB lane for RAW files our GPU debayer cannot take.
 *
 * Two cases end up here:
 *   - Fuji X-Trans (filters == 9). The 6x6 mosaic is not a Bayer grid, and our
 *     shaders only know the four 2x2 layouts.
 *   - Already-demosaiced RAW (linear DNG, Foveon). There is no mosaic at all.
 *
 * For these, LibRaw does the demosaic itself (CPU, in its worker) and we hand
 * the result to the normal image pipeline as PNG. That costs the sensor bit
 * depth — PNG round-trips through the browser decoder at 8 bits — so it is the
 * fallback, never the default. Bayer files take useLibRawParser instead and
 * keep all 14 bits.
 *
 * Also used for a single RAW file dropped on its own, which is a post-processor
 * open rather than a stack.
 */

import { UserError } from './useSentryReporting';

// Camera RAW needs the as-shot white balance and the camera colour matrix, or
// it comes out green. Astro capture formats (SER/AVI) never need this, which is
// why the debayer path has no equivalent.
const RGB_SETTINGS = {
    useCameraWb: true,
    outputColor: 1,   // sRGB
    outputBps: 8,     // PNG round-trip is 8-bit regardless; asking for 16 only wastes memory
    userQual: 3,      // AHD for Bayer; LibRaw switches to its X-Trans interpolator automatically
    noAutoBright: false,
};

/**
 * Decode one RAW file to a PNG blob via LibRaw's own demosaic.
 */
export async function decodeRawToPngBlob(file) {
    const { default: LibRaw } = await import('libraw-wasm');
    const raw = new LibRaw();
    try {
        await raw.open(new Uint8Array(await file.arrayBuffer()), RGB_SETTINGS);
        const img = await raw.imageData();
        if (!img?.data || !img.width || !img.height) {
            throw new UserError(`"${file.name}" could not be decoded to an image.`);
        }
        return await rgbToPngBlob(img);
    } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError(`"${file.name}" could not be decoded (${e?.message || e}).`);
    } finally {
        // One instance per call here (unlike the parser, which streams a whole
        // sequence through a shared instance) because these decodes are one-offs.
        try { raw.dispose?.(); } catch { /* already gone */ }
    }
}

/**
 * Decode a RAW file and return it as a PNG File, named after the original so
 * logs and export filenames stay recognisable.
 */
export async function decodeRawToPngFile(file) {
    const blob = await decodeRawToPngBlob(file);
    const base = file.name.replace(/\.[^/.]+$/, '');
    return new File([blob], `${base}.png`, { type: 'image/png' });
}

/**
 * LibRaw hands back tightly packed channels (3 for RGB, 1 for mono). Canvas
 * wants RGBA, so widen before drawing.
 */
async function rgbToPngBlob({ width, height, colors, data }) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const px = width * height;

    if (colors === 1) {
        for (let i = 0; i < px; i++) {
            const v = data[i];
            const o = i * 4;
            rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
        }
    } else {
        for (let i = 0; i < px; i++) {
            const s = i * colors;
            const o = i * 4;
            rgba[o] = data[s]; rgba[o + 1] = data[s + 1]; rgba[o + 2] = data[s + 2]; rgba[o + 3] = 255;
        }
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
}
