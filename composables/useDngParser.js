/**
 * useDngParser.js - DNG (raw Bayer) parser
 *
 * Parses Adobe DNG files that contain un-demosaiced Bayer sensor data,
 * mirroring the useSerParser interface so useDebayerReader can drive
 * the same GPU debayer + analyze + stack pipeline.
 *
 * DNG is a TIFF container. The raw Bayer plane lives in a SubIFD whose
 * PhotometricInterpretation == 32803 (CFA). This parser walks the IFD
 * tree by hand rather than through utif2, because utif2 targets display
 * TIFFs (RGB/palette) and doesn't expose the CFA-specific tags we need.
 *
 * Scope v1: uncompressed strip-based DNG (Compression == 1). Covers
 * planetary raw-video apps that emit uncompressed 12/14/16-bit Bayer.
 * Lossless-JPEG (Compression == 7) is deferred until we have a sample.
 */

import { UserError } from './useSentryReporting';
import {
    SER_COLOR_RGGB, SER_COLOR_GRBG, SER_COLOR_GBRG, SER_COLOR_BGGR,
    getOpenCVBayerPattern, getGpuBayerPattern, needsDemosaic,
} from './useSerParser';

// TIFF tag numbers we care about
const TAG_NEW_SUBFILE_TYPE       = 254;
const TAG_IMAGE_WIDTH            = 256;
const TAG_IMAGE_LENGTH           = 257;
const TAG_BITS_PER_SAMPLE        = 258;
const TAG_COMPRESSION            = 259;
const TAG_PHOTOMETRIC            = 262;
const TAG_SAMPLES_PER_PIXEL      = 277;
const TAG_ROWS_PER_STRIP         = 278;
const TAG_STRIP_OFFSETS          = 273;
const TAG_STRIP_BYTE_COUNTS      = 279;
const TAG_PLANAR_CONFIG          = 284;
const TAG_TILE_WIDTH             = 322;
const TAG_TILE_LENGTH            = 323;
const TAG_TILE_OFFSETS           = 324;
const TAG_TILE_BYTE_COUNTS       = 325;
const TAG_SUB_IFDS               = 330;
const TAG_CFA_REPEAT_PATTERN_DIM = 33421;
const TAG_CFA_PATTERN            = 33422;
const TAG_BLACK_LEVEL            = 50714;
const TAG_WHITE_LEVEL            = 50717;
const TAG_DNG_VERSION            = 50706;

// Photometric interpretation values
const PHOTOMETRIC_CFA         = 32803;  // raw Bayer
const PHOTOMETRIC_LINEAR_RAW  = 34892;  // already-demosaiced linear
const PHOTOMETRIC_RGB         = 2;

// TIFF type byte sizes (indexed by type code 1..12)
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/**
 * Parse the TIFF header and return byte order + first IFD offset.
 */
function parseTiffHeader(view) {
    const b0 = view.getUint8(0), b1 = view.getUint8(1);
    let littleEndian;
    if (b0 === 0x49 && b1 === 0x49) littleEndian = true;       // "II"
    else if (b0 === 0x4D && b1 === 0x4D) littleEndian = false;  // "MM"
    else throw new UserError('Not a valid TIFF/DNG file (bad byte-order mark)');

    const magic = view.getUint16(2, littleEndian);
    if (magic !== 42) {
        throw new UserError(`Not a valid TIFF/DNG file (magic ${magic} != 42)`);
    }
    const firstIfdOffset = view.getUint32(4, littleEndian);
    return { littleEndian, firstIfdOffset };
}

/**
 * Read a single value (or array) from a TIFF IFD entry.
 * For values that don't fit inline, the entry stores an offset into the file.
 */
function readTagValue(view, entryOffset, littleEndian) {
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const size = TYPE_SIZES[type] || 0;
    const totalBytes = size * count;
    const valueOffset = totalBytes <= 4
        ? entryOffset + 8                                // inline
        : view.getUint32(entryOffset + 8, littleEndian);  // pointer

    const values = new Array(count);
    for (let i = 0; i < count; i++) {
        const off = valueOffset + i * size;
        switch (type) {
            case 1:  values[i] = view.getUint8(off); break;                              // BYTE
            case 2:  values[i] = view.getUint8(off); break;                              // ASCII (byte)
            case 3:  values[i] = view.getUint16(off, littleEndian); break;               // SHORT
            case 4:  values[i] = view.getUint32(off, littleEndian); break;               // LONG
            case 5: {                                                                     // RATIONAL
                const num = view.getUint32(off, littleEndian);
                const den = view.getUint32(off + 4, littleEndian);
                values[i] = den === 0 ? 0 : num / den;
                break;
            }
            case 6:  values[i] = view.getInt8(off); break;                               // SBYTE
            case 7:  values[i] = view.getUint8(off); break;                              // UNDEFINED
            case 8:  values[i] = view.getInt16(off, littleEndian); break;                // SSHORT
            case 9:  values[i] = view.getInt32(off, littleEndian); break;                // SLONG
            case 10: {                                                                    // SRATIONAL
                const num = view.getInt32(off, littleEndian);
                const den = view.getInt32(off + 4, littleEndian);
                values[i] = den === 0 ? 0 : num / den;
                break;
            }
            case 11: values[i] = view.getFloat32(off, littleEndian); break;              // FLOAT
            case 12: values[i] = view.getFloat64(off, littleEndian); break;              // DOUBLE
            default: values[i] = 0;
        }
    }
    return count === 1 ? values[0] : values;
}

/**
 * Parse one IFD at the given offset. Returns { tags, nextIfdOffset }.
 * `tags` is an object keyed by tag number.
 */
function parseIfd(view, offset, littleEndian) {
    const numEntries = view.getUint16(offset, littleEndian);
    const tags = {};
    for (let i = 0; i < numEntries; i++) {
        const entryOffset = offset + 2 + i * 12;
        const tag = view.getUint16(entryOffset, littleEndian);
        tags[tag] = readTagValue(view, entryOffset, littleEndian);
    }
    const nextIfdOffset = view.getUint32(offset + 2 + numEntries * 12, littleEndian);
    return { tags, nextIfdOffset };
}

/**
 * Walk the IFD tree (top-level chain + all SubIFDs) and return the first
 * IFD whose PhotometricInterpretation == 32803 (CFA). Falls back to null.
 */
function findCfaIfd(view, firstOffset, littleEndian) {
    const visited = new Set();
    const queue = [firstOffset];
    while (queue.length) {
        const off = queue.shift();
        if (!off || visited.has(off)) continue;
        visited.add(off);
        const { tags, nextIfdOffset } = parseIfd(view, off, littleEndian);
        if (tags[TAG_PHOTOMETRIC] === PHOTOMETRIC_CFA) {
            return tags;
        }
        // SubIFDs (offset or array of offsets)
        const subs = tags[TAG_SUB_IFDS];
        if (subs != null) {
            if (Array.isArray(subs)) subs.forEach(o => queue.push(o));
            else queue.push(subs);
        }
        if (nextIfdOffset) queue.push(nextIfdOffset);
    }
    return null;
}

/**
 * Map a DNG CFAPattern byte array (row-major 2×2, {0=R, 1=G, 2=B}) to the
 * SER colorID that the rest of the pipeline understands.
 *
 * DNG top-left 2x2 → industry standard name → SER constant.
 */
function cfaPatternToSerColorId(cfa) {
    if (!Array.isArray(cfa) || cfa.length < 4) return SER_COLOR_RGGB;
    const key = `${cfa[0]}${cfa[1]}${cfa[2]}${cfa[3]}`;
    switch (key) {
        case '0112': return SER_COLOR_RGGB;
        case '1021': return SER_COLOR_GRBG;
        case '1201': return SER_COLOR_GBRG;
        case '2110': return SER_COLOR_BGGR;
        default:     return SER_COLOR_RGGB;
    }
}

/**
 * Take the strip data as bytes and produce a Uint16Array of raw Bayer
 * samples, one 16-bit LE word per pixel, black-level subtracted.
 */
function unpackBayerToUint16(stripBytes, width, height, bitsPerSample, blackLevel, littleEndian) {
    const pixelCount = width * height;
    const out = new Uint16Array(pixelCount);

    if (bitsPerSample === 16 || bitsPerSample === 12 || bitsPerSample === 14 || bitsPerSample === 10) {
        // Common DNG layout: samples padded to 16-bit words.
        const strideBytes = pixelCount * 2;
        if (stripBytes.byteLength >= strideBytes) {
            const src = new DataView(stripBytes.buffer, stripBytes.byteOffset, stripBytes.byteLength);
            for (let i = 0; i < pixelCount; i++) {
                const raw = src.getUint16(i * 2, littleEndian);
                out[i] = raw > blackLevel ? raw - blackLevel : 0;
            }
            return out;
        }
        // Tightly packed variant — supported for the two common bit depths.
        if (bitsPerSample === 12) {
            // Two 12-bit pixels every 3 bytes: [AAAAAAAA][AAAABBBB][BBBBBBBB]
            for (let i = 0, o = 0; o < pixelCount; i += 3, o += 2) {
                const a = (stripBytes[i] << 4) | (stripBytes[i + 1] >> 4);
                const b = ((stripBytes[i + 1] & 0x0F) << 8) | stripBytes[i + 2];
                out[o] = a > blackLevel ? a - blackLevel : 0;
                if (o + 1 < pixelCount) out[o + 1] = b > blackLevel ? b - blackLevel : 0;
            }
            return out;
        }
        if (bitsPerSample === 14) {
            // Four 14-bit pixels every 7 bytes. Rare; fall through if we hit it.
            throw new UserError('Packed 14-bit DNG layout is not yet supported. Please share the sample file.');
        }
    }
    if (bitsPerSample === 8) {
        for (let i = 0; i < pixelCount; i++) {
            const raw = stripBytes[i];
            out[i] = raw > blackLevel ? raw - blackLevel : 0;
        }
        return out;
    }
    throw new UserError(`Unsupported DNG bit depth: ${bitsPerSample}`);
}

/**
 * Read a scalar from a possibly-array tag value (BlackLevel can be per-channel).
 */
function firstNumeric(v, fallback = 0) {
    if (v == null) return fallback;
    if (Array.isArray(v)) return v.length ? Number(v[0]) || 0 : fallback;
    return Number(v) || fallback;
}

/**
 * Parse a single DNG file.
 */
export function useDngParser() {
    let file = null;
    let littleEndian = true;
    let cfaTags = null;
    let width = 0, height = 0, bitsPerSample = 16;
    let blackLevel = 0;
    let stripOffset = 0, stripByteCount = 0;
    let colorID = SER_COLOR_RGGB;
    let bayerPattern = { opencv: 'MONO', gpu: -1 };
    let scaleFactor = 1;

    async function init(inputFile) {
        file = inputFile;

        // Load enough of the front of the file to cover the IFD chain,
        // SubIFDs, and any tag values referenced by pointer. Strip data itself
        // is fetched separately via readFrameRaw(). 1MB is generous — most
        // DNGs put metadata well within the first 100KB — but the slice is
        // cheap and shields us from unusual layouts.
        const headerSize = Math.min(file.size, 1024 * 1024);
        const headerBuf = await file.slice(0, headerSize).arrayBuffer();
        const view = new DataView(headerBuf);

        const { littleEndian: le, firstIfdOffset } = parseTiffHeader(view);
        littleEndian = le;

        cfaTags = findCfaIfd(view, firstIfdOffset, littleEndian);
        if (!cfaTags) {
            // Detect linear-DNG case so we can give a clear error rather than crashing.
            const ifd0 = parseIfd(view, firstIfdOffset, littleEndian).tags;
            if (ifd0[TAG_PHOTOMETRIC] === PHOTOMETRIC_LINEAR_RAW || ifd0[TAG_PHOTOMETRIC] === PHOTOMETRIC_RGB) {
                throw new UserError('This DNG is already demosaiced (Linear DNG). Open it as a regular image instead.');
            }
            throw new UserError('No raw Bayer plane found in this DNG file.');
        }

        width = firstNumeric(cfaTags[TAG_IMAGE_WIDTH]);
        height = firstNumeric(cfaTags[TAG_IMAGE_LENGTH]);
        const bps = cfaTags[TAG_BITS_PER_SAMPLE];
        bitsPerSample = Array.isArray(bps) ? bps[0] : (bps || 16);
        const compression = firstNumeric(cfaTags[TAG_COMPRESSION], 1);
        const samplesPerPixel = firstNumeric(cfaTags[TAG_SAMPLES_PER_PIXEL], 1);

        if (compression !== 1) {
            throw new UserError(`Compressed DNGs (compression=${compression}) are not yet supported. Please share the sample so support can be added.`);
        }
        if (samplesPerPixel !== 1) {
            throw new UserError(`DNG has ${samplesPerPixel} samples per pixel; expected 1 for raw Bayer.`);
        }
        if (cfaTags[TAG_TILE_OFFSETS] != null) {
            throw new UserError('Tiled DNGs are not yet supported. Please share the sample so support can be added.');
        }

        // Strip offsets/counts. Uncompressed Bayer is almost always a single strip.
        const stripOffsets = cfaTags[TAG_STRIP_OFFSETS];
        const stripByteCounts = cfaTags[TAG_STRIP_BYTE_COUNTS];
        if (stripOffsets == null) {
            throw new UserError('DNG has no StripOffsets tag; layout unsupported.');
        }
        stripOffset = Array.isArray(stripOffsets) ? stripOffsets[0] : stripOffsets;
        stripByteCount = Array.isArray(stripByteCounts) ? stripByteCounts[0] : stripByteCounts;
        // For multi-strip DNGs, read the whole contiguous span.
        if (Array.isArray(stripOffsets) && stripOffsets.length > 1) {
            const lastOff = stripOffsets[stripOffsets.length - 1];
            const lastLen = Array.isArray(stripByteCounts)
                ? stripByteCounts[stripByteCounts.length - 1] : stripByteCount;
            stripByteCount = (lastOff + lastLen) - stripOffset;
        }

        // CFA pattern → SER colorID → OpenCV / GPU indices
        const cfa = cfaTags[TAG_CFA_PATTERN];
        colorID = cfaPatternToSerColorId(Array.isArray(cfa) ? cfa : [cfa]);
        bayerPattern = {
            opencv: getOpenCVBayerPattern(colorID),
            gpu: getGpuBayerPattern(colorID),
        };

        // Black level (fall back to 0 if absent)
        blackLevel = Math.round(firstNumeric(cfaTags[TAG_BLACK_LEVEL], 0));

        // Compute scale factor from BitsPerSample directly — DNG tells us the
        // effective bit depth exactly, so we don't need to sample a frame like
        // useSerParser does. Prefer WhiteLevel when present, otherwise fall
        // back to (2^bits - 1). This skips a full frame read per file, which
        // matters when a folder holds hundreds of DNGs.
        if (bitsPerSample > 8) {
            const whiteLevel = Math.round(firstNumeric(cfaTags[TAG_WHITE_LEVEL], (1 << bitsPerSample) - 1));
            const range = Math.max(1, whiteLevel - blackLevel);
            scaleFactor = 65535 / range;
        } else {
            scaleFactor = 1;
        }

        return getMetadata();
    }

    function getMetadata() {
        if (!cfaTags) throw new Error('Parser not initialized');
        // Output is always Uint16 (unpackBayerToUint16 normalizes 8/10/12/14-bit
        // sources into 16-bit words), so report 16-bit metadata regardless of
        // source bit depth. Keeps useDebayerReader on one code path.
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

    // Internal: fetch strip bytes and unpack to a 16-bit LE ArrayBuffer.
    async function readFrameRaw() {
        const stripBytes = new Uint8Array(
            await file.slice(stripOffset, stripOffset + stripByteCount).arrayBuffer()
        );
        const out = unpackBayerToUint16(stripBytes, width, height, bitsPerSample, blackLevel, littleEndian);
        return out.buffer;
    }

    async function readFrame(frameIndex) {
        if (frameIndex !== 0) {
            throw new Error(`Frame index ${frameIndex} out of range (DNG holds 1 frame)`);
        }
        return await readFrameRaw();
    }

    async function readFrameTyped(frameIndex) {
        const buffer = await readFrame(frameIndex);
        return new Uint16Array(buffer);
    }

    async function readFrameScaled(frameIndex) {
        const buffer = await readFrame(frameIndex);
        if (scaleFactor > 1) {
            const u16 = new Uint16Array(buffer);
            for (let i = 0; i < u16.length; i++) {
                u16[i] = Math.min(65535, Math.round(u16[i] * scaleFactor));
            }
        }
        return buffer;
    }

    return {
        init,
        getMetadata,
        readFrame,
        readFrameTyped,
        readFrameScaled,
    };
}

/**
 * Sequence adapter: N DNG files → one virtual multi-frame parser.
 * Mirrors useMultiSerParser so useDebayerReader can consume it unchanged.
 */
export function useMultiDngParser() {
    let parsers = [];
    let files = [];
    let combinedMetadata = null;

    async function init(inputFiles) {
        files = inputFiles;
        parsers = [];

        // Parse every DNG header up front so we can (a) surface bad files
        // early and (b) verify homogeneity — a mid-session dimension or
        // CFA change would corrupt the stack silently.
        for (const file of inputFiles) {
            const parser = useDngParser();
            await parser.init(file);
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
            if (meta.pixelDepth !== firstMeta.pixelDepth) {
                reasons.push(`${meta.pixelDepth}-bit vs ${firstMeta.pixelDepth}-bit`);
            }
            if (reasons.length) mismatches.push({ name: files[i].name, reasons });
        }
        if (mismatches.length) {
            const names = mismatches.map(m => `"${m.name}" (${m.reasons.join(', ')})`).join(', ');
            const noun = mismatches.length === 1 ? 'file' : 'files';
            throw new UserError(
                `${mismatches.length} ${noun} don't match the reference "${firstName}" (${firstMeta.width}×${firstMeta.height}, ${firstMeta.pixelDepth}-bit): ${names}.`,
                { mismatchedFileNames: mismatches.map(m => m.name) }
            );
        }

        combinedMetadata = {
            ...firstMeta,
            frameCount: inputFiles.length,
            fileCount: inputFiles.length,
            fileNames: inputFiles.map(f => f.name),
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

    return {
        init,
        getMetadata,
        readFrame,
        readFrameTyped,
        readFrameScaled,
    };
}

export default useDngParser;
