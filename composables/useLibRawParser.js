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
import { FILTERS_NONE, FILTERS_XTRANS, bayerPatternFromFilters, fc } from './libRawCfa';
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
    let levelsNeedMeasuring = false;
    let levelsMeasured = false;
    let wbGain = null;   // Float32Array(4) of per-CFA-phase gains, or null

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

        // Both numbers above can be LibRaw defaults rather than measurements,
        // and a default looks exactly like a real answer. A Panasonic RW2 from
        // a DC-G9M2 reports black=0 and maximum=65535, so the normalisation
        // computes to precisely 1.0 and does nothing, while the actual mosaic
        // sits at min 1604 / median 2058 / max 35837: 3% of full scale, with a
        // black pedestal that is never removed. Measure the file instead when
        // the reported levels carry no information.
        // Scoped deliberately narrowly: measure ONLY when LibRaw has told us
        // nothing usable, meaning it reported the container maximum (its
        // default) or a maximum at or below black.
        //
        // NOTE: the white-balance block below widens this to every Bayer RAW
        // that gets WB applied, because WB invalidates LibRaw's white level.
        // This line alone is the narrow "LibRaw told us nothing" case.
        levelsNeedMeasuring = (maximum >= CONTAINER_MAX) || (maximum <= blackLevel);

        // Camera white balance.
        //
        // Why this lane needs it and SER does not: planetary capture software
        // writes SER with the red/blue gains already applied, so that data
        // arrives roughly balanced. A camera RAW stores the unbalanced sensor
        // readout and leaves the gains in metadata. Green sits about twice
        // red on this class of sensor, so a CORRECT demosaic of an untouched
        // RAW mosaic is bright green — which reads as "the Bayer pattern is
        // wrong" when the pattern is in fact right.
        //
        // The RGB lane has always done this (useLibRawRgb passes
        // useCameraWb), which is why a lone RAW looked neutral in the post
        // processor while the same file stacked green.
        //
        // Normalised so the LARGEST gain is 1, i.e. channels are attenuated,
        // never amplified. Scaling red up by 2.4x would clip every bright red
        // highlight; scaling the others down cannot clip anything, and the
        // brightness it costs is handed straight back by measureLevels, which
        // runs on the balanced data.
        const camMul = [].concat(colorData.cam_mul || []).map(Number);
        const preMul = [].concat(colorData.pre_mul || []).map(Number);
        const usable = (m) => m.length >= 3 && m[0] > 0 && m[1] > 0 && m[2] > 0;
        const mul = usable(camMul) ? camMul : (usable(preMul) ? preMul : null);

        wbGain = null;
        if (mul && cfaKind === 'bayer') {
            // dcraw channel order: 0=R, 1=G, 2=B, 3=second G (often 0, in
            // which case it shares the first green's gain).
            const g = [mul[0], mul[1], mul[2], mul[3] > 0 ? mul[3] : mul[1]];
            // g[3] MUST be in here. It is divided by maxG like the rest, so
            // leaving it out lets a camera reporting cam_mul[3] above the
            // other three produce a gain above 1 — and the store below is into
            // a Uint16Array, which wraps modulo 65536 instead of clamping. A
            // near-saturated second-green pixel would come back as near-black,
            // i.e. speckle on every other row and column.
            const maxG = Math.max(g[0], g[1], g[2], g[3]);
            const gains = new Float32Array(4);
            let anyChange = false;
            for (let p = 0; p < 4; p++) {
                // Phase index (x & 1) + 2 * (y & 1) in VISIBLE coordinates, so
                // the margins are folded in here exactly as they are for the
                // pattern itself. Odd margins shift the phase.
                const channel = fc(filters, topMargin + (p >> 1), leftMargin + (p & 1));
                gains[p] = g[channel] / maxG;
                if (Math.abs(gains[p] - 1) > 1e-3) anyChange = true;
            }
            if (anyChange) {
                wbGain = gains;
                console.log(
                    `[LibRaw] camera WB from ${usable(camMul) ? 'cam_mul' : 'pre_mul'} ` +
                    `[${g.slice(0, 3).map(v => v.toFixed(0)).join(', ')}] -> per-phase gains ` +
                    `[${Array.from(gains).map(v => v.toFixed(3)).join(', ')}] (attenuating only)`
                );
            }
        }

        // Applying WB invalidates LibRaw's white level, so re-derive it.
        //
        // scaleFactor above comes from `maximum`, which describes the mosaic
        // BEFORE white balance. Attenuating green to ~0.42 drops the brightest
        // channel of a typical subject by that much, and nothing gives it
        // back: a Canon CR2 reporting black=2048/maximum=16383 would come out
        // of readFrameScaled at under half the level it does today. That is
        // not cosmetic — Tenengrad frame ranking, the fractional crop-detect
        // threshold and the AP brightness floor all read absolute levels.
        //
        // So the rule is simply: if we changed the data, we measure the data.
        // Costs one extra decode per sequence (measureLevels caches, and
        // useMultiLibRawParser shares one measurement across files).
        if (wbGain) levelsNeedMeasuring = true;

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

        if (wbGain) {
            // Per-CFA-phase gain, all <= 1, so this can never clip. Kept as a
            // separate loop so files with no white balance to apply pay
            // nothing: this runs over every sensor pixel on the main thread.
            for (let y = 0; y < outH; y++) {
                const srcRow = (y + top) * rawW + left;
                const dstRow = y * outW;
                const gRow = (y & 1) << 1;
                for (let x = 0; x < outW; x++) {
                    const v = data[srcRow + x] - blackLevel;
                    out[dstRow + x] = v > 0 ? v * wbGain[gRow + (x & 1)] : 0;
                }
            }
        } else {
            for (let y = 0; y < outH; y++) {
                const srcRow = (y + top) * rawW + left;
                const dstRow = y * outW;
                for (let x = 0; x < outW; x++) {
                    const v = data[srcRow + x] - blackLevel;
                    out[dstRow + x] = v > 0 ? v : 0;
                }
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

    // Derive black and white levels from the mosaic itself.
    //
    // Percentiles, not min/max: one hot pixel must not set the white point and
    // one dead pixel must not set the black. Deliberately conservative on
    // black, taking a low percentile rather than the floor, so a frame that
    // genuinely reaches zero is left alone.
    const CONTAINER_MAX = 65535;
    const BLACK_PERCENTILE = 0.001;
    // White point is the Nth brightest sample, NOT a percentile.
    //
    // A percentile assumes the subject occupies a decent share of the frame,
    // and the whole point of this app is small bright things on large dark
    // ones. At 25 megapixels the 99.99th percentile is the 2500th brightest
    // sample, so a planet covering fewer pixels than that would put the white
    // point in the SKY and the stretch would blow the planet to flat white.
    // Counting from the top instead stays correct however small the subject.
    //
    // 50 absorbs a handful of hot pixels. Err high on purpose: under-stretching
    // merely leaves the image dim, over-stretching destroys the subject.
    const WHITE_RANK_FROM_TOP = 50;
    const MAX_DERIVED_STRETCH = 64;   // sanity bound on the amplification

    // In-flight guard, separate from the success flag below. Without it two
    // concurrent readFrameScaled calls would each start a measurement; with
    // it they await the same one.
    let measurePromise = null;

    function measureLevels() {
        if (levelsMeasured || !levelsNeedMeasuring) return Promise.resolve();
        if (!measurePromise) {
            measurePromise = doMeasureLevels().finally(() => { measurePromise = null; });
        }
        return measurePromise;
    }

    async function doMeasureLevels() {
        // readFrameRaw already subtracts the current blackLevel, so measure
        // with it at zero and fold the result in afterwards.
        const priorBlack = blackLevel;
        blackLevel = 0;
        let u16;
        try {
            u16 = new Uint16Array(await readFrameRaw());
        } catch {
            // Deliberately NOT marking this measured. A transient decode
            // failure used to latch the flag permanently, leaving the file
            // unnormalised at ~3% of full scale for the rest of the session —
            // the exact black-stack condition this function exists to stop.
            blackLevel = priorBlack;
            return;
        }

        // Full scan, no subsampling: the white point counts individual samples
        // from the top, so skipping any of them moves it.
        const hist = new Uint32Array(CONTAINER_MAX + 1);
        for (let i = 0; i < u16.length; i++) hist[u16[i]]++;
        const n = u16.length;
        if (!n) { blackLevel = priorBlack; return; }

        let acc = 0, black = 0;
        const blackTarget = n * BLACK_PERCENTILE;
        for (let v = 0; v <= CONTAINER_MAX; v++) { acc += hist[v]; if (acc >= blackTarget) { black = v; break; } }

        acc = 0;
        let white = CONTAINER_MAX;
        for (let v = CONTAINER_MAX; v >= 0; v--) { acc += hist[v]; if (acc >= WHITE_RANK_FROM_TOP) { white = v; break; } }
        if (!(white > black)) { blackLevel = priorBlack; return; }

        // Never weaken what LibRaw told us, only fill in what it did not.
        blackLevel = Math.max(priorBlack, black);
        scaleFactor = Math.min(MAX_DERIVED_STRETCH, CONTAINER_MAX / (white - blackLevel));
        levelsMeasured = true;   // only now: every early return above is a retry

        // State what the whole pipeline will actually be working with. Crop
        // detection, Tenengrad frame scoring, AP quality and the stack all read
        // the output of this function, so if it leaves the frame at 3% of full
        // scale every one of them is scoring noise — and silently. One line
        // here replaces guessing at the far end of the pipeline.
        let acc2 = 0, median = 0;
        for (let v = 0; v <= CONTAINER_MAX; v++) { acc2 += hist[v]; if (acc2 >= n / 2) { median = v; break; } }
        const after = (v) => Math.round(Math.max(0, v - blackLevel) * scaleFactor);
        const pct = (v) => `${((100 * after(v)) / CONTAINER_MAX).toFixed(1)}%`;
        console.log(
            `[LibRaw] levels measured for ${file?.name}: black=${blackLevel} white=${white} scale=${scaleFactor.toFixed(2)}x` +
            ` | median ${median}->${after(median)} (${pct(median)}), white point -> 100%`
        );
        if (after(median) > CONTAINER_MAX * 0.5) {
            console.warn(`[LibRaw] median lands at ${pct(median)} of full scale — the frame is mostly subject, or the black point is too low.`);
        }
    }

    // Lets a sequence share one measurement, so frames of the same take are
    // never scaled differently from each other.
    function getLevels() {
        return { blackLevel, scaleFactor, measured: levelsMeasured || !levelsNeedMeasuring };
    }

    function setLevels(levels) {
        if (!levels) return;
        blackLevel = levels.blackLevel;
        scaleFactor = levels.scaleFactor;
        levelsMeasured = true;
    }

    async function readFrameScaled(frameIndex) {
        await measureLevels();
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

    return { init, getMetadata, readFrame, readFrameTyped, readFrameScaled, measureLevels, getLevels, setLevels };
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
        // One measurement for the whole sequence. Measured per file, two frames
        // of the same take could get different black and white points and so
        // different brightness, which would show up as flicker in the stack and
        // as a bogus displacement signal at the alignment points.
        await shareLevels();
        return parsers[globalIndex].readFrameScaled(0);
    }

    // Cache the PROMISE, not a boolean.
    //
    // A boolean set before the await is only correct if callers arrive one at
    // a time, and they do not: useDebayerReader loads a batch with
    // `Promise.all(indices.map(readFrame))`, so callers 2..N would see the
    // flag already true, return immediately, and then each measure its own
    // file — producing exactly the per-file black/white points, brightness
    // flicker and bogus AP displacement this function exists to prevent, plus
    // one redundant full decode and 25M-sample histogram per file.
    let levelsSharedPromise = null;
    function shareLevels() {
        if (parsers.length < 1) return Promise.resolve();
        if (!levelsSharedPromise) levelsSharedPromise = doShareLevels();
        return levelsSharedPromise;
    }

    async function doShareLevels() {
        const first = parsers[0];
        if (!first.measureLevels) return;
        await first.measureLevels();
        const levels = first.getLevels();
        if (!levels.measured) {
            // Measurement failed; let a later batch retry rather than latching
            // the whole sequence into "shared" with nothing to share.
            levelsSharedPromise = null;
            return;
        }
        for (let i = 1; i < parsers.length; i++) {
            parsers[i].setLevels?.(levels);
        }
    }

    return { init, getMetadata, readFrame, readFrameTyped, readFrameScaled };
}

export default useLibRawParser;
