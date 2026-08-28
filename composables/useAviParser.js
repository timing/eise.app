/**
 * useAviParser.js - AVI file format parsing
 *
 * Focused module that handles only AVI format parsing and validation.
 * No file reading for processing, worker management, or GPU operations - just parsing logic.
 *
 * Handles all AVI edge cases:
 * - DIB bottom-up vertical flip
 * - Headerless AVIs (pre-scan for frame count)
 * - OpenDML/AVI 2.0 large files (>2GB)
 * - strd chunk Bayer pattern detection
 * - Multiple FourCC formats
 */

// Supported FourCC codes for direct reading (uncompressed/raw)
export const EASY_FOURCCS = ['DIB ', 'Y800', 'YUY2', 'UYVY', 'RGB ', 'RAW '];
export const MJPEG_FOURCC = 'MJPG';

// Map industry Bayer patterns to OpenCV (inverted naming convention)
const BAYER_TO_OPENCV = {
    'RGGB': 'COLOR_BayerBG2RGB',
    'BGGR': 'COLOR_BayerRG2RGB',
    'GRBG': 'COLOR_BayerGB2RGB',
    'GBRG': 'COLOR_BayerGR2RGB',
    'MONO': 'MONO',
};

// Map industry Bayer patterns to GPU shader indices
// GPU: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG, -1=MONO
const BAYER_TO_GPU = {
    'RGGB': 0,
    'BGGR': 1,
    'GRBG': 2,
    'GBRG': 3,
    'MONO': -1,
};

// OpenCV to GPU mapping
const OPENCV_TO_GPU = {
    'COLOR_BayerBG2RGB': 0,  // RGGB
    'COLOR_BayerRG2RGB': 1,  // BGGR
    'COLOR_BayerGB2RGB': 2,  // GRBG
    'COLOR_BayerGR2RGB': 3,  // GBRG
    'MONO': -1,
};

/**
 * Check if FourCC represents an uncompressed/raw format we can read directly
 */
export function isEasyAviFourCC(fourCC) {
    if (!fourCC) return false;
    // Null fourCC (\0\0\0\0) is used by FFmpeg rawvideo for uncompressed BGR
    if (fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00') return true;
    return EASY_FOURCCS.includes(fourCC.toUpperCase());
}

/**
 * Check if FourCC is MJPEG (Motion JPEG)
 */
export function isMjpegFourCC(fourCC) {
    if (!fourCC) return false;
    return fourCC.toUpperCase() === MJPEG_FOURCC;
}

/**
 * Check if FourCC is uncompressed BGR (DIB, RGB, or null FourCC)
 */
export function isUncompressedBGR(fourCC) {
    if (!fourCC) return true; // Null FourCC from FFmpeg rawvideo
    if (fourCC === '\u0000\u0000\u0000\u0000' || fourCC === '\x00\x00\x00\x00') return true;
    return fourCC === 'DIB ' || fourCC === 'RGB ';
}

/**
 * Check if this is 8-bit raw format (needs demosaicing)
 */
export function is8bitRawFormat(fourCC, bpp) {
    console.log('[useAviParser] is8bitRawFormat called - using NEW parser module');
    return fourCC === 'Y800' || (isUncompressedBGR(fourCC) && bpp === 8);
}

/**
 * Calculate frame data size based on FourCC and dimensions
 * @returns {number} Frame size in bytes, or -1 if variable/unknown
 */
export function calculateFrameDataSize(fourCC, width, height, bpp) {
    if (isUncompressedBGR(fourCC)) {
        return width * height * (bpp / 8);
    } else if (fourCC === 'Y800') {
        return width * height;
    } else if (fourCC === 'YUY2' || fourCC === 'UYVY') {
        return width * height * 2;
    }
    // MJPEG and other compressed formats have variable frame sizes
    return -1;
}

/**
 * Get GPU Bayer pattern index from OpenCV pattern name
 */
export function opencvToGpuPattern(opencvPattern) {
    return OPENCV_TO_GPU[opencvPattern] ?? -1;
}

/**
 * Flip a raw frame buffer vertically (for DIB bottom-up storage)
 * DIB format stores frames bottom-up (positive biHeight in header).
 *
 * @param {ArrayBuffer|Uint8Array} buffer - Raw frame data
 * @param {number} width - Frame width in pixels
 * @param {number} height - Frame height in pixels
 * @param {number} bytesPerPixel - Bytes per pixel (1 for 8-bit, 3 for 24-bit)
 * @returns {Uint8Array} - Flipped frame data (new buffer)
 */
export function flipFrameVertically(buffer, width, height, bytesPerPixel = 1) {
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const rowBytes = width * bytesPerPixel;
    const expectedSize = height * rowBytes;
    const dst = new Uint8Array(expectedSize);
    const availableRows = Math.min(height, Math.floor(src.length / rowBytes));

    if (availableRows < height) {
        console.warn(`[AVI] Truncated frame: got ${src.length} bytes, expected ${expectedSize} (${availableRows}/${height} rows)`);
    }

    for (let y = 0; y < availableRows; y++) {
        const srcOffset = y * rowBytes;
        const dstOffset = (height - 1 - y) * rowBytes;
        dst.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }

    return dst;
}

/**
 * Parse AVI frame index from file - builds array of {offset, size} for each video frame
 * Scans chunk headers to find actual video frames, skipping audio and other chunks.
 * Handles OpenDML/AVI 2.0 large files that split data across multiple RIFF chunks.
 *
 * @param {File|Blob} file - AVI file to scan
 * @param {number} moviListOffset - Offset to movi list data start
 * @param {number} moviListSize - Size of movi list
 * @param {number} maxFrames - Maximum frames to index (-1 for all)
 * @returns {Array<{offset: number, size: number}>} Frame index array
 */
export async function parseAviFrameIndex(file, moviListOffset, moviListSize, maxFrames = -1) {
    const frameIndex = [];
    const chunkHeaderSize = 8; // 4 bytes FourCC + 4 bytes size
    const fileSize = file.size;

    // For large AVI files with AVIX extension, scan entire file instead of just first movi chunk
    // This handles OpenDML/AVI 2.0 files that split data across multiple RIFF chunks
    const scanWholeFile = fileSize > moviListOffset + moviListSize + 1024;

    let position = moviListOffset;
    const scanEnd = scanWholeFile ? fileSize : moviListOffset + moviListSize;

    while (position < scanEnd - chunkHeaderSize) {
        if (maxFrames > 0 && frameIndex.length >= maxFrames) break;

        // Read chunk header
        const headerSlice = await file.slice(position, position + chunkHeaderSize).arrayBuffer();
        const headerView = new DataView(headerSlice);

        const chunkId = String.fromCharCode(
            headerView.getUint8(0),
            headerView.getUint8(1),
            headerView.getUint8(2),
            headerView.getUint8(3)
        );
        const chunkSize = headerView.getUint32(4, true);

        // Sanity check chunk size
        if (chunkSize > fileSize - position || chunkSize > 100 * 1024 * 1024) {
            // Invalid chunk size - might be RIFF/LIST header, skip appropriately
            if (chunkId === 'RIFF' || chunkId === 'LIST') {
                // Skip RIFF/LIST type field (4 bytes after size)
                position += 12;
                continue;
            }
            // Unknown large chunk, skip to next position
            position += 4;
            continue;
        }

        // Video chunks are typically '00dc', '01dc', etc. (compressed video)
        // or '00db', '01db' (uncompressed video)
        if (chunkId.match(/^\d\ddc$/i) || chunkId.match(/^\d\ddb$/i)) {
            frameIndex.push({
                offset: position + chunkHeaderSize,
                size: chunkSize
            });
        }

        // Move to next chunk (size is padded to word boundary)
        const paddedSize = (chunkSize + 1) & ~1;
        position += chunkHeaderSize + paddedSize;
    }

    return frameIndex;
}

/**
 * Detect Bayer pattern from strd chunk content
 * @param {ArrayBuffer} buffer - File buffer containing strd data
 * @param {number} offset - Start offset of strd data
 * @param {number} size - Size of strd chunk
 * @returns {string|null} OpenCV Bayer pattern name, or null if not found
 */
export function detectBayerFromStrd(buffer, offset, size) {
    if (!buffer || size === 0) return null;

    try {
        // Read strd content as text to search for Bayer pattern strings
        const strdBytes = new Uint8Array(buffer, offset, Math.min(size, 256));
        const strdText = String.fromCharCode(...strdBytes).toUpperCase();

        // Search for common Bayer pattern identifiers
        if (strdText.includes('RGGB')) {
            return 'COLOR_BayerBG2RGB'; // OpenCV inverted naming
        } else if (strdText.includes('BGGR')) {
            return 'COLOR_BayerRG2RGB';
        } else if (strdText.includes('GRBG')) {
            return 'COLOR_BayerGB2RGB';
        } else if (strdText.includes('GBRG')) {
            return 'COLOR_BayerGR2RGB';
        } else if (strdText.includes('MONO') || strdText.includes('GREY') || strdText.includes('GRAY')) {
            return 'MONO';
        }
    } catch (e) {
        console.warn('Failed to parse strd chunk:', e.message);
    }

    return null;
}

/**
 * Safe FourCC read helper
 */
function safeReadFourCC(view, offset) {
    if (offset + 4 > view.byteLength) return '';
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
}

/**
 * Parse full AVI header from buffer
 * Extracts all metadata needed for frame reading.
 *
 * @param {ArrayBuffer} buffer - First ~5MB of file (enough for header)
 * @param {number} actualFileSize - Total file size (for frame count validation)
 * @returns {Object|null} Parsed header or null on error
 */
export function parseAviHeader(buffer, actualFileSize = 0) {
    const view = new DataView(buffer);
    const fileEnd = buffer.byteLength;

    // Helper functions
    const safeGetUint32 = (v, o, le = true) => {
        if (o + 4 > fileEnd) throw new Error(`Cannot read Uint32 at offset ${o}`);
        return v.getUint32(o, le);
    };

    const safeGetInt32 = (v, o, le = true) => {
        if (o + 4 > fileEnd) throw new Error(`Cannot read Int32 at offset ${o}`);
        return v.getInt32(o, le);
    };

    const safeGetUint16 = (v, o, le = true) => {
        if (o + 2 > fileEnd) throw new Error(`Cannot read Uint16 at offset ${o}`);
        return v.getUint16(o, le);
    };

    try {
        // Minimum AVI file size check (RIFF header + AVI signature)
        if (fileEnd < 12) {
            throw new Error('File too small to be a valid AVI file');
        }

        if (safeReadFourCC(view, 0) !== 'RIFF' || safeReadFourCC(view, 8) !== 'AVI ') {
            throw new Error('Not a valid AVI file');
        }

        let offset = 12;
        let avihData = null;
        let strhData = null;
        let strfData = null;
        let strdData = null;
        let moviListOffset = -1;
        let moviListSize = -1;

        // Scan for RIFF chunks
        while (offset < fileEnd - 8) {
            if (offset + 8 > fileEnd) break;

            const chunkId = safeReadFourCC(view, offset);
            let chunkSize = safeGetUint32(view, offset + 4, true);
            const chunkDataOffset = offset + 8;

            // Sanity check chunk size
            if (chunkSize > fileEnd - chunkDataOffset) {
                chunkSize = fileEnd - chunkDataOffset;
            }

            if (chunkId === 'LIST') {
                if (chunkDataOffset + 4 > fileEnd) break;
                const listType = safeReadFourCC(view, chunkDataOffset);

                if (listType === 'hdrl') {
                    // Parse header list
                    let hdrlOffset = chunkDataOffset + 4;
                    let videoStreamFound = false;

                    while (hdrlOffset < chunkDataOffset + chunkSize - 4 && hdrlOffset + 8 <= fileEnd) {
                        const subChunkId = safeReadFourCC(view, hdrlOffset);
                        const subChunkSize = safeGetUint32(view, hdrlOffset + 4, true);
                        const subChunkPaddedSize = (subChunkSize + 1) & ~1;

                        if (subChunkId === 'avih') {
                            avihData = { offset: hdrlOffset + 8, size: subChunkSize };
                        } else if (subChunkId === 'LIST' && hdrlOffset + 12 <= fileEnd && safeReadFourCC(view, hdrlOffset + 8) === 'strl') {
                            // Stream list
                            if (!videoStreamFound) {
                                let streamOffset = hdrlOffset + 12;
                                while (streamOffset < hdrlOffset + 8 + subChunkSize && streamOffset + 8 <= fileEnd) {
                                    const streamChunkId = safeReadFourCC(view, streamOffset);
                                    const streamChunkSize = safeGetUint32(view, streamOffset + 4, true);
                                    const streamChunkPaddedSize = (streamChunkSize + 1) & ~1;

                                    if (streamChunkId === 'strh' && streamOffset + 12 <= fileEnd && safeReadFourCC(view, streamOffset + 8) === 'vids') {
                                        videoStreamFound = true;
                                        strhData = { offset: streamOffset + 8, size: streamChunkSize };
                                    } else if (streamChunkId === 'strf' && videoStreamFound && !strfData) {
                                        strfData = { offset: streamOffset + 8, size: streamChunkSize };
                                    } else if (streamChunkId === 'strd' && videoStreamFound) {
                                        strdData = { offset: streamOffset + 8, size: streamChunkSize };
                                    }
                                    streamOffset += 8 + streamChunkPaddedSize;
                                }
                            }
                        }
                        hdrlOffset += 8 + subChunkPaddedSize;
                    }
                } else if (listType === 'movi') {
                    moviListOffset = chunkDataOffset + 4;
                    moviListSize = chunkSize - 4;
                }
            }

            const chunkPaddedSize = (chunkSize + 1) & ~1;
            offset += 8 + chunkPaddedSize;
        }

        // Verify critical chunks
        if (!avihData || !strhData || !strfData) {
            throw new Error('Missing critical AVI header chunks (avih, strh, or strf)');
        }

        // Verify chunk data bounds
        if (avihData.offset + 20 > fileEnd) {
            throw new Error('avih chunk data extends beyond buffer');
        }
        if (strhData.offset + 36 > fileEnd) {
            throw new Error('strh chunk data extends beyond buffer');
        }
        if (strfData.offset + 20 > fileEnd) {
            throw new Error('strf chunk data extends beyond buffer');
        }

        // Extract header values
        let frameCount = safeGetUint32(view, avihData.offset + 16, true);
        if (frameCount === 0) {
            frameCount = safeGetUint32(view, strhData.offset + 32, true); // Fallback to dwLength
        }

        const width = safeGetUint32(view, strfData.offset + 4, true);
        const rawBiHeight = safeGetInt32(view, strfData.offset + 8, true);
        const height = Math.abs(rawBiHeight);
        const needsVerticalFlip = rawBiHeight > 0; // Positive biHeight = bottom-up storage
        const bpp = safeGetUint16(view, strfData.offset + 14, true);

        // Determine FourCC
        const compression = safeReadFourCC(view, strfData.offset + 16);
        const isCompressionNull = compression.charCodeAt(0) === 0 && compression.charCodeAt(1) === 0 &&
                                   compression.charCodeAt(2) === 0 && compression.charCodeAt(3) === 0;
        const fourCC = isCompressionNull ? safeReadFourCC(view, strhData.offset + 4) : compression;

        if (!width || !height || !frameCount || moviListOffset === -1) {
            throw new Error('Incomplete AVI header info');
        }

        // Calculate frame size
        const frameDataSize = calculateFrameDataSize(fourCC, width, height, bpp);

        // Sanity check frame count from file size (some capture software writes incorrect frameCount)
        if (frameDataSize > 0 && actualFileSize > 0) {
            const estimatedFrames = Math.floor((actualFileSize - moviListOffset) / frameDataSize);
            if (frameCount <= 10 && estimatedFrames > 100) {
                // Will need to scan for actual frame count later
                frameCount = 0; // Signal that pre-scan is needed
            }
        }

        // Detect Bayer pattern from strd chunk
        let bayerChoice = 'MONO';
        if (strdData && strdData.size > 0) {
            const detectedPattern = detectBayerFromStrd(buffer, strdData.offset, strdData.size);
            if (detectedPattern) {
                bayerChoice = detectedPattern;
            }
        }

        // Default Bayer pattern for 8-bit raw formats with even dimensions
        if (bayerChoice === 'MONO' && is8bitRawFormat(fourCC, bpp) && width % 2 === 0 && height % 2 === 0) {
            bayerChoice = 'COLOR_BayerBG2RGB'; // Default to RGGB (most common for planetary cameras)
        }

        return {
            width,
            height,
            frameCount,
            fourCC,
            frameDataSize,
            bpp,
            bayerChoice,
            moviListOffset,
            moviListSize,
            needsVerticalFlip,
            needsDemosaic: is8bitRawFormat(fourCC, bpp),
            isEasyFormat: isEasyAviFourCC(fourCC),
            isMjpeg: isMjpegFourCC(fourCC),
        };

    } catch (e) {
        console.error('Error parsing AVI header:', e);
        return null;
    }
}

/**
 * Create a complete AVI file parser with all validation
 */
export function useAviParser() {
    let file = null;
    let header = null;
    let frameIndex = null;

    /**
     * Initialize parser with file
     */
    async function init(aviFile) {
        file = aviFile;

        // Read enough of the file for header parsing (~5MB)
        const headerProbeSize = Math.min(file.size, 1024 * 1024 * 5);
        const headerBuffer = await file.slice(0, headerProbeSize).arrayBuffer();

        // Parse header
        header = parseAviHeader(headerBuffer, file.size);
        if (!header) {
            throw new Error('Failed to parse AVI header');
        }

        // Build frame index if needed (for variable frame sizes or header issues)
        // Also build for raw formats to detect truncation (more reliable frame count)
        const needsFrameIndex = header.frameCount === 0 ||
                                header.frameDataSize === -1 ||
                                header.isMjpeg ||
                                header.isEasyFormat;  // Raw formats like Y800 - verify count for truncated files
        if (needsFrameIndex) {
            frameIndex = await parseAviFrameIndex(file, header.moviListOffset, header.moviListSize);
            if (frameIndex.length !== header.frameCount) {
                console.warn(`[AVI] Frame count mismatch: header=${header.frameCount}, actual=${frameIndex.length}`);
            }
            header.frameCount = frameIndex.length;
        }

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
            fourCC: header.fourCC,
            frameDataSize: header.frameDataSize,
            bpp: header.bpp,
            bayerPattern: {
                opencv: header.bayerChoice,
                gpu: opencvToGpuPattern(header.bayerChoice),
            },
            needsVerticalFlip: header.needsVerticalFlip,
            needsDemosaic: header.needsDemosaic,
            isEasyFormat: header.isEasyFormat,
            isMjpeg: header.isMjpeg,
            moviListOffset: header.moviListOffset,
            moviListSize: header.moviListSize,
        };
    }

    /**
     * Get frame index (built on demand if not already built)
     */
    async function getFrameIndex() {
        if (!header) throw new Error('Parser not initialized');

        if (!frameIndex) {
            frameIndex = await parseAviFrameIndex(file, header.moviListOffset, header.moviListSize);
            // Update header.frameCount to match actual frames (handles truncated files)
            if (frameIndex.length !== header.frameCount) {
                console.warn(`[AVI] Frame count mismatch: header says ${header.frameCount}, found ${frameIndex.length} frames`);
                header.frameCount = frameIndex.length;
            }
        }
        return frameIndex;
    }

    /**
     * Read raw frame data
     * @param {number} frameIdx - Frame index (0-based)
     * @returns {ArrayBuffer} Raw frame data (may need vertical flip)
     */
    async function readFrame(frameIdx) {
        if (!header) throw new Error('Parser not initialized');
        if (frameIdx < 0 || frameIdx >= header.frameCount) {
            throw new Error(`Frame index ${frameIdx} out of range (0-${header.frameCount - 1})`);
        }

        let offset, size;

        if (frameIndex) {
            // Use frame index for variable-size frames
            const frame = frameIndex[frameIdx];
            if (!frame) {
                throw new Error(`Frame ${frameIdx} not found in index (only ${frameIndex.length} frames available)`);
            }
            offset = frame.offset;
            size = frame.size;
        } else {
            // Calculate offset for fixed-size frames
            // For easy formats, we can still use frame index scanning
            const idx = await getFrameIndex();
            const frame = idx[frameIdx];
            if (!frame) {
                throw new Error(`Frame ${frameIdx} not found in index (only ${idx.length} frames available)`);
            }
            offset = frame.offset;
            size = frame.size;
        }

        return await file.slice(offset, offset + size).arrayBuffer();
    }

    /**
     * Read frame with vertical flip applied if needed
     */
    async function readFrameFlipped(frameIdx) {
        const buffer = await readFrame(frameIdx);

        if (header.needsVerticalFlip && header.frameDataSize > 0) {
            const bytesPerPixel = header.bpp / 8;
            return flipFrameVertically(buffer, header.width, header.height, bytesPerPixel);
        }

        return new Uint8Array(buffer);
    }

    return {
        init,
        getMetadata,
        getFrameIndex,
        readFrame,
        readFrameFlipped,
    };
}

export default useAviParser;
