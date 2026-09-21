/**
 * useLibRawParser.js - camera RAW parser backed by LibRaw (WASM)
 *
 * Covers every RAW format LibRaw knows (CR2, CR3, NEF, ARW, ORF, RW2, PEF,
 * SRW, RAF, DNG) and exposes the same five-method interface as useSerParser /
 * useDngParser, so useDebayerReader drives the existing GPU debayer + analyze
 * + stack pipeline unchanged.
 *
 * We take the UNDEBAYERED mosaic (`rawImageData()`, 16-bit single channel) and
 * demosaic on the GPU ourselves. LibRaw's own demosaic is CPU-bound in WASM and
 * would cost seconds per frame on a 30-frame sequence; ours is milliseconds and
 * keeps the full sensor bit depth end to end.
 *
 * NOT for X-Trans (Fuji) or already-demosaiced files. Their mosaic is not a
 * Bayer grid our shaders can read, so probeRawFile() reports `cfaKind` and the
 * caller routes those to the RGB lane (useLibRawRgb) instead.
 *
 * Threading: libraw-wasm runs the decode in its own Web Worker. `open()` calls
 * recycle() first, so ONE instance streams every file in a sequence. That also
 * means instance state is global — every open+read pair has to hold the lock
 * below or two concurrent frame reads would interleave and return each other's
 * pixels.
 */

import { UserError } from './useSentryReporting';
import {
    SER_COLOR_MONO, SER_COLOR_RGGB, SER_COLOR_GRBG, SER_COLOR_GBRG, SER_COLOR_BGGR,
    getOpenCVBayerPattern, getGpuBayerPattern, needsDemosaic,
} from './useSerParser';
import { FILTERS_NONE, FILTERS_XTRANS, bayerPatternFromFilters } from './libRawCfa';
import { loadLibRawCtor } from './libRawLoader';

// Pattern name → SER colorID, the vocabulary the rest of the pipeline speaks.
const SER_COLOR_BY_PATTERN = {
    RGGB: SER_COLOR_RGGB,
    GRBG: SER_COLOR_GRBG,
    GBRG: SER_COLOR_GBRG,
    BGGR: SER_COLOR_BGGR,
};

// ---------------------------------------------------------------------------
// Shared instance + serialisation
// ---------------------------------------------------------------------------

let sharedInstance = null;
let loadPromise = null;
// Promise chain acting as a mutex. libraw-wasm serialises individual worker
// calls, but not our open()+read() pairs, which is the thing that must be atomic.
let lock = Promise.resolve();

async function getInstance() {
    if (sharedInstance) return sharedInstance;
    if (!loadPromise) {
        // Loaded from /libraw/ rather than bundled: see libRawLoader.js for why
        // letting Vite see this package blows up the production build. Still
        // lazy, so the ~1.4MB wasm only downloads once a RAW file is dropped.
        loadPromise = loadLibRawCtor().then((LibRaw) => {
            sharedInstance = new LibRaw();
            return sharedInstance;
        });
    }
    return await loadPromise;
}

/**
 * Run fn with exclusive access to the shared LibRaw instance.
 */
function withLock(fn) {
    const run = lock.then(fn, fn);
    // Keep the chain alive regardless of outcome, but don't swallow the result.
    lock = run.then(() => {}, () => {});
    return run;
}

/**
 * Release the worker. Call when a session is done with RAW files; the next
 * parse lazily spins a fresh instance.
 */
export function disposeLibRaw() {
    try { sharedInstance?.dispose?.(); } catch { /* already gone */ }
    sharedInstance = null;
    loadPromise = null;
}

async function openFile(file) {
    const raw = await getInstance();
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
        await raw.open(bytes);
    } catch (e) {
        throw new UserError(
            `"${file.name}" could not be read as a RAW file (${e?.message || e}).`
        );
    }
    return raw;
}

// ---------------------------------------------------------------------------
// CFA pattern derivation
// ---------------------------------------------------------------------------

function serColorIdFromFilters(filters, topMargin, leftMargin) {
    const pattern = bayerPatternFromFilters(filters, topMargin, leftMargin);
    const colorID = pattern ? SER_COLOR_BY_PATTERN[pattern] : undefined;
    if (colorID === undefined) {
        throw new UserError('Unrecognised colour filter layout in this RAW file.');
    }
    return colorID;
}

/**
 * Classify a file without committing to a reader. Cheap-ish: open() only parses
 * headers (unpack happens later, on first pixel read).
 *
 * Returns { cfaKind, width, height, make, model, filters, colors }
 *   cfaKind 'bayer'  → useLibRawParser + GPU debayer
 *           'xtrans' → LibRaw's own demosaic (RGB lane)
 *           'none'   → already full-colour (linear DNG, Foveon) → RGB lane
 *           'mono'   → single-channel sensor, no demosaic needed
 */
export async function probeRawFile(file) {
    return await withLock(async () => {
        const raw = await openFile(file);
        // metadata(true) is required. libraw-wasm's metadata(flag) passes the
        // flag straight through to the worker, and the short form omits
        // `filters`, `colors` and most of `color_data`. Reading `filters` off
        // the short payload yields undefined -> 0 -> FILTERS_NONE, which sent
        // every Bayer camera RAW down the 8-bit RGB lane instead of this one.
        const meta = await raw.metadata(true);
        const filters = Number(meta?.filters ?? 0);
        const colors = Number(meta?.colors ?? 3);

        let cfaKind;
        if (filters === FILTERS_XTRANS) cfaKind = 'xtrans';
        else if (filters === FILTERS_NONE) cfaKind = 'none';
        else if (colors === 1) cfaKind = 'mono';
        else if (colors === 4) cfaKind = 'four_color';  // Sony RGBE and friends
        else cfaKind = 'bayer';

        return {
            cfaKind,
            filters,
            colors,
            width: Number(meta?.width ?? 0),
            height: Number(meta?.height ?? 0),
            make: meta?.camera_make || '',
            model: meta?.camera_model || '',
        };
    });
}

// ---------------------------------------------------------------------------
// Single-file parser
// ---------------------------------------------------------------------------

export function useLibRawParser() {
    let file = null;
    let width = 0, height = 0;
    let colorID = null;
    let bayerPattern = null;
    let blackLevel = 0;
    let scaleFactor = 1;
    let cfaKind = 'bayer';

    async function init(inputFile) {
        file = inputFile;

        const meta = await withLock(async () => {
            const raw = await openFile(file);
            // See probeRawFile: the short payload has no filters/colors/levels.
            return await raw.metadata(true);
        });

        const filters = Number(meta?.filters ?? 0);
        const colors = Number(meta?.colors ?? 3);
        if (filters === FILTERS_XTRANS) {
            throw new UserError(
                `"${file.name}" uses a Fuji X-Trans sensor, which needs the RGB path, not the Bayer one.`
            );
        }
        if (filters === FILTERS_NONE) {
            throw new UserError(
                `"${file.name}" holds already-demosaiced data, which needs the RGB path.`
            );
        }

        // metadata() reports the size the developed image will have AFTER the
        // orientation flag is applied, but rawImageData() hands back the mosaic
        // in sensor orientation, which is what this lane consumes. flip 5 (90
        // CCW) and 6 (90 CW) are the quarter turns, so undo the swap for them
        // or the size guard in readFrameRaw trips on every portrait phone DNG.
        const flip = Number(meta?.flip ?? 0);
        const quarterTurn = flip === 5 || flip === 6;
        width = Number((quarterTurn ? meta?.height : meta?.width) ?? 0);
        height = Number((quarterTurn ? meta?.width : meta?.height) ?? 0);
        if (!width || !height) {
            throw new UserError(`"${file.name}" reports no usable image size.`);
        }

        // Margins are needed for the pattern phase; rawImageData() returns them
        // again per frame, but metadata is what we have at init time.
        const topMargin = Number(meta?.top_margin ?? 0);
        const leftMargin = Number(meta?.left_margin ?? 0);

        if (colors === 4) {
            // Four-colour CFAs (Sony RGBE, a few CMY sensors) are not a
            // red/green/blue 2x2 grid, so our shaders cannot read them.
            throw new UserError(
                `"${file.name}" uses a four-colour filter array, which needs the RGB path.`
            );
        }

        // Mono sensors reuse the SER MONO colorID rather than a null, so the
        // rest of the pipeline (needsDemosaic, GPU pattern -1, the colour-picker
        // check) treats them exactly like a mono SER instead of hitting
        // undefined lookups and offering a Bayer picker for a file with no CFA.
        cfaKind = colors === 1 ? 'mono' : 'bayer';
        colorID = cfaKind === 'mono'
            ? SER_COLOR_MONO
            : serColorIdFromFilters(filters, topMargin, leftMargin);
        bayerPattern = {
            opencv: getOpenCVBayerPattern(colorID),
            gpu: getGpuBayerPattern(colorID),
        };

        // Black/white levels drive the same normalisation useDngParser does:
        // subtract black, then stretch what remains across the full 16-bit range
        // so the GPU shaders see a consistent scale whatever the sensor depth.
        // libraw-wasm puts these directly on color_data; there is no nested
        // ColorData object. Reading the nested path always produced undefined,
        // so scaleFactor fell through to 1 and the mosaic stayed at its sensor
        // range (e.g. 0-1023 for a 10-bit phone DNG) inside a 16-bit container,
        // leaving the image at ~1.5% of full scale for everything downstream.
        // The fallback keeps working if a future version does nest them.
        const colorData = meta?.color_data?.ColorData || meta?.color_data || {};
        blackLevel = Math.max(0, Math.round(Number(colorData.black ?? 0)));
        const maximum = Math.round(Number(colorData.maximum ?? 0));
        if (maximum > blackLevel) {
            scaleFactor = 65535 / (maximum - blackLevel);
        } else {
            // Unknown white level: leave the data alone rather than guess a
            // stretch that would clip highlights.
            scaleFactor = 1;
        }

        return getMetadata();
    }

    function getMetadata() {
        if (!file) throw new Error('Parser not initialized');
        return {
            width,
            height,
            frameCount: 1,
            pixelDepth: 16,
            bytesPerPixel: 2,
            channels: 1,
            frameSize: width * height * 2,
            colorID,
            bayerPattern,
            scaleFactor,
            needsDemosaic: needsDemosaic(colorID),
            isRgbPassthrough: false,
            isBgr: false,
            littleEndian: true,
            observer: '',
            instrument: '',
            telescope: '',
        };
    }

    /**
     * Decode one frame to a black-subtracted 16-bit mosaic, cropped to the
     * visible area. LibRaw hands back the full sensor including the masked
     * border used for black-level calibration; feeding that to the debayer
     * would offset every alignment point.
     */
    async function readFrameRaw() {
        const { data, raw_width, top_margin, left_margin, width: visW, height: visH } =
            await withLock(async () => {
                const raw = await openFile(file);
                const r = await raw.rawImageData();
                if (!r?.data) {
                    throw new UserError(`"${file.name}" could not be decoded (no sensor data returned).`);
                }
                return r;
            });

        // metadata() and rawImageData() report the visible size independently.
        // If they ever disagree, the debayer pipeline would read the frame with
        // the wrong stride and produce a sheared, silently wrong stack — so fail
        // loudly instead of guessing which one is right.
        if (visW && visH && (visW !== width || visH !== height)) {
            throw new UserError(
                `"${file.name}" reports ${width}×${height} in its header but ${visW}×${visH} of pixel data. ` +
                `Please share this file so the mismatch can be handled.`
            );
        }

        const outW = visW || width;
        const outH = visH || height;
        const rawW = raw_width || outW;
        const out = new Uint16Array(outW * outH);
        const top = top_margin || 0;
        const left = left_margin || 0;

        for (let y = 0; y < outH; y++) {
            const srcRow = (y + top) * rawW + left;
            const dstRow = y * outW;
            for (let x = 0; x < outW; x++) {
                const v = data[srcRow + x] - blackLevel;
                out[dstRow + x] = v > 0 ? v : 0;
            }
        }
        return out.buffer;
    }

    async function readFrame(frameIndex) {
        if (frameIndex !== 0) {
            throw new Error(`Frame index ${frameIndex} out of range (RAW files hold 1 frame)`);
        }
        return await readFrameRaw();
    }

    async function readFrameTyped(frameIndex) {
        return new Uint16Array(await readFrame(frameIndex));
    }

    async function readFrameScaled(frameIndex) {
        const buffer = await readFrame(frameIndex);
        if (scaleFactor > 1) {
            const u16 = new Uint16Array(buffer);
            for (let i = 0; i < u16.length; i++) {
                const v = Math.round(u16[i] * scaleFactor);
                u16[i] = v > 65535 ? 65535 : v;
            }
        }
        return buffer;
    }

    return { init, getMetadata, readFrame, readFrameTyped, readFrameScaled };
}

// ---------------------------------------------------------------------------
// Sequence adapter
// ---------------------------------------------------------------------------

/**
 * N RAW files → one virtual multi-frame parser. Mirrors useMultiDngParser so
 * useDebayerReader consumes it unchanged.
 *
 * Unlike the DNG version this cannot hold N open parsers: the LibRaw instance
 * is shared and recycles on every open(), so each file is re-opened on demand.
 * The up-front pass therefore costs one header parse per file (the pixel decode
 * stays lazy), which is what buys us the early mismatch check.
 */
export function useMultiLibRawParser() {
    let parsers = [];
    let files = [];
    let combinedMetadata = null;

    async function init(inputFiles) {
        files = Array.from(inputFiles);
        parsers = [];

        for (const f of files) {
            const parser = useLibRawParser();
            await parser.init(f);
            parsers.push(parser);
        }

        const firstMeta = parsers[0].getMetadata();
        const firstName = files[0].name;
        const mismatches = [];
        for (let i = 1; i < parsers.length; i++) {
            const meta = parsers[i].getMetadata();
            const reasons = [];
            if (meta.width !== firstMeta.width || meta.height !== firstMeta.height) {
                reasons.push(`${meta.width}×${meta.height} vs ${firstMeta.width}×${firstMeta.height}`);
            }
            if (meta.colorID !== firstMeta.colorID) {
                reasons.push('different CFA pattern');
            }
            if (reasons.length) mismatches.push({ name: files[i].name, reasons });
        }
        if (mismatches.length) {
            const names = mismatches.map(m => `"${m.name}" (${m.reasons.join(', ')})`).join(', ');
            const noun = mismatches.length === 1 ? 'file' : 'files';
            throw new UserError(
                `${mismatches.length} ${noun} don't match the reference "${firstName}" (${firstMeta.width}×${firstMeta.height}): ${names}.`,
                { mismatchedFileNames: mismatches.map(m => m.name) }
            );
        }

        combinedMetadata = {
            ...firstMeta,
            frameCount: files.length,
            fileCount: files.length,
            fileNames: files.map(f => f.name),
        };
        return combinedMetadata;
    }

    function getMetadata() {
        return combinedMetadata;
    }

    async function readFrame(globalIndex) {
        return parsers[globalIndex].readFrame(0);
    }
    async function readFrameTyped(globalIndex) {
        return parsers[globalIndex].readFrameTyped(0);
    }
    async function readFrameScaled(globalIndex) {
        return parsers[globalIndex].readFrameScaled(0);
    }

    return { init, getMetadata, readFrame, readFrameTyped, readFrameScaled };
}

export default useLibRawParser;
