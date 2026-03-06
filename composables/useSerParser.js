/**
 * useSerParser.js - SER file format parsing
 *
 * Focused module that handles only SER format parsing and validation.
 * No file reading, processing, or GPU operations - just parsing logic.
 *
 * SER V3 format: https://www.grischa-hahn.homepage.t-online.de/astro/ser/
 */

// SER file constants
export const SER_HEADER_SIZE = 178;
export const SER_FILE_ID = 'LUCAM-RECORDER';

// SER ColorID values
export const SER_COLOR_MONO = 0;
export const SER_COLOR_RGGB = 8;
export const SER_COLOR_GRBG = 9;
export const SER_COLOR_GBRG = 10;
export const SER_COLOR_BGGR = 11;

// Map SER colorID to OpenCV Bayer patterns
// OpenCV uses inverted naming convention (see CLAUDE.md)
const COLOR_ID_TO_OPENCV = {
    [SER_COLOR_MONO]: 'MONO',
    [SER_COLOR_RGGB]: 'COLOR_BayerBG2RGB',  // Industry RGGB → OpenCV BG
    [SER_COLOR_GRBG]: 'COLOR_BayerGB2RGB',  // Industry GRBG → OpenCV GB
    [SER_COLOR_GBRG]: 'COLOR_BayerGR2RGB',  // Industry GBRG → OpenCV GR
    [SER_COLOR_BGGR]: 'COLOR_BayerRG2RGB',  // Industry BGGR → OpenCV RG
};

// Map SER colorID to GPU shader pattern indices
// GPU: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG, -1=MONO
const COLOR_ID_TO_GPU = {
    [SER_COLOR_MONO]: -1,
    [SER_COLOR_RGGB]: 0,
    [SER_COLOR_GRBG]: 2,
    [SER_COLOR_GBRG]: 3,
    [SER_COLOR_BGGR]: 1,
};

/**
 * Parse SER V3 header from buffer
 *
 * Standard SER V3 header layout (178 bytes):
 * 0-13:    FileID "LUCAM-RECORDER" (14 bytes)
 * 14-17:   LuID (4 bytes) - camera ID
 * 18-21:   ColorID (4 bytes) - 0=MONO, 8=RGGB, 9=GRBG, 10=GBRG, 11=BGGR
 * 22-25:   LittleEndian (4 bytes) - byte order indicator
 * 26-29:   ImageWidth (4 bytes)
 * 30-33:   ImageHeight (4 bytes)
 * 34-37:   PixelDepthPerPlane (4 bytes) - bits per pixel (8, 10, 12, 14, 16)
 * 38-41:   FrameCount (4 bytes)
 * 42-81:   Observer (40 bytes)
 * 82-121:  Instrument (40 bytes)
 * 122-161: Telescope (40 bytes)
 * 162-169: DateTime (8 bytes)
 * 170-177: DateTimeUTC (8 bytes)
 *
 * @param {ArrayBuffer} buffer - First 178 bytes of SER file
 * @returns {Object} Parsed header
 */
export function parseSerHeader(buffer) {
    console.log('[useSerParser] parseSerHeader called - using NEW parser module');

    if (buffer.byteLength < SER_HEADER_SIZE) {
        throw new Error(`Buffer too small for SER header: ${buffer.byteLength} < ${SER_HEADER_SIZE}`);
    }

    const view = new DataView(buffer);
    const le = true; // SER files are always little-endian for header

    const header = {
        fileId: decodeString(buffer, 0, 14),
        luId: view.getInt32(14, le),
        colorID: view.getInt32(18, le),
        littleEndian: view.getInt32(22, le),
        width: view.getInt32(26, le),
        height: view.getInt32(30, le),
        pixelDepth: view.getInt32(34, le),
        frameCount: view.getInt32(38, le),
        observer: decodeString(buffer, 42, 40),
        instrument: decodeString(buffer, 82, 40),
        telescope: decodeString(buffer, 122, 40),
        dateTime: view.getBigInt64(162, le),
        dateTimeUTC: view.getBigInt64(170, le),
    };

    // Validate header values
    if (header.width <= 0 || header.width > 10000 || header.height <= 0 || header.height > 10000) {
        console.warn('SER header values look invalid, file may be corrupted or non-standard');
    }

    // Ensure pixelDepth is sensible
    if (header.pixelDepth <= 0 || header.pixelDepth > 16) {
        console.warn(`Unusual pixelDepth ${header.pixelDepth}, defaulting to 8`);
        header.pixelDepth = 8;
    }

    return header;
}

/**
 * Decode a string from buffer, trimming null characters
 */
function decodeString(buffer, offset, length) {
    return Array.from(new Uint8Array(buffer.slice(offset, offset + length)))
        .map(b => String.fromCharCode(b))
        .join('')
        .replace(/\0/g, '');
}

/**
 * Calculate bytes per pixel based on bit depth
 */
export function getBytesPerPixel(pixelDepth) {
    return pixelDepth > 8 ? 2 : 1;
}

/**
 * Calculate frame size in bytes
 */
export function getFrameSize(width, height, pixelDepth) {
    return width * height * getBytesPerPixel(pixelDepth);
}

/**
 * Calculate frame offset in file
 * SER frames are stored linearly after the 178-byte header
 */
export function getFrameOffset(frameIndex, frameSize) {
    return SER_HEADER_SIZE + frameIndex * frameSize;
}

/**
 * Get OpenCV Bayer pattern from SER colorID
 * @param {number} colorID - SER ColorID value
 * @returns {string} OpenCV demosaic constant name
 */
export function getOpenCVBayerPattern(colorID) {
    return COLOR_ID_TO_OPENCV[colorID] || 'COLOR_BayerBG2RGB';
}

/**
 * Get GPU shader Bayer pattern index from SER colorID
 * @param {number} colorID - SER ColorID value
 * @returns {number} GPU pattern index (0-3, or -1 for MONO)
 */
export function getGpuBayerPattern(colorID) {
    return COLOR_ID_TO_GPU[colorID] ?? -1;
}

/**
 * Check if colorID requires demosaicing
 */
export function needsDemosaic(colorID) {
    return colorID !== SER_COLOR_MONO;
}

/**
 * Detect and correct lying header about bit depth
 *
 * Some SER files have incorrect pixelDepth in header (says 16-bit but actually 8-bit).
 * This detects that situation by comparing expected frame counts.
 *
 * @param {Object} header - Parsed header (will be modified in place)
 * @param {number} fileSize - Total file size in bytes
 * @returns {Object} Object with corrected bpp and frameSize
 */
export function detectActualBitDepth(header, fileSize) {
    console.log('[useSerParser] detectActualBitDepth called - validating bit depth');
    let bpp = getBytesPerPixel(header.pixelDepth);
    let frameSize = getFrameSize(header.width, header.height, header.pixelDepth);

    if (header.pixelDepth > 8) {
        const frameSize16 = header.width * header.height * 2;
        const frameSize8 = header.width * header.height * 1;
        const dataSize = fileSize - SER_HEADER_SIZE;

        const frameCount16 = Math.floor(dataSize / frameSize16);
        const frameCount8 = Math.floor(dataSize / frameSize8);
        const headerFrames = header.frameCount;

        // If 8-bit calculation matches header frame count, it's actually 8-bit data
        if (frameCount8 === headerFrames && frameCount16 !== headerFrames) {
            header.pixelDepth = 8;
            bpp = 1;
            frameSize = frameSize8;
            return { corrected: true, bpp, frameSize, message: `Header says 16-bit but file size matches 8-bit (${headerFrames} frames). Treating as 8-bit.` };
        }
    }

    return { corrected: false, bpp, frameSize };
}

/**
 * Validate frame count against actual file size
 *
 * Header frameCount can be incorrect. This calculates actual frame count from file size.
 *
 * @param {Object} header - Parsed header (will be modified in place)
 * @param {number} fileSize - Total file size in bytes
 * @param {number} frameSize - Bytes per frame
 * @returns {Object} Object with validation info
 */
export function validateFrameCount(header, fileSize, frameSize) {
    const actualFrameCount = Math.floor((fileSize - SER_HEADER_SIZE) / frameSize);

    if (actualFrameCount !== header.frameCount) {
        const originalCount = header.frameCount;
        header.frameCount = actualFrameCount;
        return {
            corrected: true,
            originalCount,
            actualCount: actualFrameCount,
            message: `Header says ${originalCount} frames, but file size suggests ${actualFrameCount} frames. Using calculated value.`
        };
    }

    return { corrected: false, actualCount: actualFrameCount };
}

/**
 * Detect scale factor for sub-16-bit data in 16-bit container
 *
 * 16-bit SER files often contain 8/10/12/14-bit data. This samples pixels
 * to find the effective bit depth and calculates a scale factor.
 *
 * @param {Uint16Array} frameData - 16-bit frame data to sample
 * @returns {Object} Scale factor info
 */
export function detectScaleFactor(frameData) {
    // Sample pixels across the frame for reliable max detection
    const sampleSize = Math.min(5000, frameData.length);
    const step = Math.max(1, Math.floor(frameData.length / sampleSize));
    let maxVal = 0;

    for (let i = 0; i < frameData.length && i < sampleSize * step; i += step) {
        if (frameData[i] > maxVal) maxVal = frameData[i];
    }

    // Already full range or minimal data
    if (maxVal === 0 || maxVal >= 32768) {
        return { scaleFactor: 1, effectiveBits: 16, maxSampledValue: maxVal };
    }

    // Determine effective bit depth
    let effectiveBits;
    if (maxVal <= 255) effectiveBits = 8;
    else if (maxVal <= 1023) effectiveBits = 10;
    else if (maxVal <= 4095) effectiveBits = 12;
    else if (maxVal <= 16383) effectiveBits = 14;
    else effectiveBits = 16;

    let scaleFactor = 1;
    if (effectiveBits < 16) {
        const maxForBits = (1 << effectiveBits) - 1;
        scaleFactor = 65535 / maxForBits;
    }

    return { scaleFactor, effectiveBits, maxSampledValue: maxVal };
}

/**
 * Apply scale factor to 16-bit data buffer
 * Modifies buffer in place.
 *
 * @param {ArrayBuffer} buffer - Buffer containing 16-bit data
 * @param {number} scaleFactor - Scale factor to apply
 * @returns {ArrayBuffer} Same buffer (modified in place)
 */
export function scale16bitData(buffer, scaleFactor) {
    if (scaleFactor === 1) return buffer;

    const u16 = new Uint16Array(buffer);
    for (let i = 0; i < u16.length; i++) {
        u16[i] = Math.min(65535, Math.round(u16[i] * scaleFactor));
    }
    return buffer;
}

/**
 * Create a complete SER file parser with all validation
 *
 * @param {File|Blob} file - SER file to parse
 * @returns {Object} Parser object with metadata and read methods
 */
export function useSerParser() {
    let file = null;
    let header = null;
    let frameSize = 0;
    let bpp = 0;
    let scaleFactor = 1;
    let bayerPattern = { opencv: 'MONO', gpu: -1 };

    /**
     * Initialize parser with file
     */
    async function init(serFile) {
        file = serFile;

        // Read and parse header
        const headerBuf = await file.slice(0, SER_HEADER_SIZE).arrayBuffer();
        header = parseSerHeader(headerBuf);

        // Detect actual bit depth (handles lying headers)
        const bitDepthResult = detectActualBitDepth(header, file.size);
        bpp = bitDepthResult.bpp;
        frameSize = bitDepthResult.frameSize;

        // Validate frame count
        validateFrameCount(header, file.size, frameSize);

        // Detect scale factor for 16-bit data
        if (header.pixelDepth > 8) {
            const firstFrameBuffer = await file.slice(SER_HEADER_SIZE, SER_HEADER_SIZE + frameSize).arrayBuffer();
            const scaleResult = detectScaleFactor(new Uint16Array(firstFrameBuffer));
            scaleFactor = scaleResult.scaleFactor;
        }

        // Get Bayer patterns
        bayerPattern = {
            opencv: getOpenCVBayerPattern(header.colorID),
            gpu: getGpuBayerPattern(header.colorID),
        };

        return getMetadata();
    }

    /**
     * Get parsed metadata
     */
    function getMetadata() {
        if (!header) throw new Error('Parser not initialized');

        return {
            width: header.width,
            height: header.height,
            frameCount: header.frameCount,
            pixelDepth: header.pixelDepth,
            bytesPerPixel: bpp,
            frameSize,
            colorID: header.colorID,
            bayerPattern,
            scaleFactor,
            needsDemosaic: needsDemosaic(header.colorID),
            littleEndian: header.littleEndian !== 0,
            observer: header.observer,
            instrument: header.instrument,
            telescope: header.telescope,
        };
    }

    /**
     * Read raw frame data
     * @param {number} frameIndex - Frame index (0-based)
     * @returns {ArrayBuffer} Raw frame data
     */
    async function readFrame(frameIndex) {
        if (!header) throw new Error('Parser not initialized');
        if (frameIndex < 0 || frameIndex >= header.frameCount) {
            throw new Error(`Frame index ${frameIndex} out of range (0-${header.frameCount - 1})`);
        }

        const offset = getFrameOffset(frameIndex, frameSize);
        return await file.slice(offset, offset + frameSize).arrayBuffer();
    }

    /**
     * Read frame as typed array
     */
    async function readFrameTyped(frameIndex) {
        const buffer = await readFrame(frameIndex);
        return header.pixelDepth > 8 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    }

    /**
     * Read frame with scale factor applied (for 16-bit data)
     */
    async function readFrameScaled(frameIndex) {
        const buffer = await readFrame(frameIndex);
        if (scaleFactor > 1 && header.pixelDepth > 8) {
            scale16bitData(buffer, scaleFactor);
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

export default useSerParser;
