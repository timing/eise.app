/**
 * Simple uncompressed AVI encoder for exporting debayered frames
 * Creates AVI with DIB (uncompressed RGB) video stream
 */

/**
 * Encode frames as uncompressed AVI file
 * @param {Array} frames - Array of {rgbaBuffer: ArrayBuffer, width: number, height: number}
 * @param {number} fps - Frames per second (default 25)
 * @returns {Blob} AVI file as Blob
 */
export function encodeAvi(frames, fps = 25) {
    if (!frames || frames.length === 0) {
        throw new Error('No frames to encode');
    }

    const width = frames[0].width;
    const height = frames[0].height;
    const frameCount = frames.length;

    // AVI uses BGR format, bottom-up orientation
    // Each frame is width * height * 3 bytes (24-bit BGR)
    const frameSize = width * height * 3;
    const paddedRowSize = Math.ceil(width * 3 / 4) * 4; // Rows padded to 4-byte boundary
    const paddedFrameSize = paddedRowSize * height;

    // Calculate sizes
    const moviSize = frameCount * (8 + paddedFrameSize); // 8 bytes per chunk header
    const idx1Size = frameCount * 16; // 16 bytes per index entry

    // RIFF AVI structure sizes
    const strlSize = 4 + 8 + 56 + 8 + 40; // 'strl' + strh chunk + strf chunk
    const hdrlSize = 4 + // 'hdrl'
        8 + 56 + // avih chunk (8 header + 56 data)
        8 + strlSize; // strl LIST

    const aviSize = 4 + // 'AVI '
        8 + hdrlSize + // hdrl list
        8 + 4 + moviSize + // movi list
        8 + idx1Size; // idx1 chunk

    const fileSize = 8 + aviSize; // RIFF header + content

    // Create buffer
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Helper functions
    function writeString(str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset++, str.charCodeAt(i));
        }
    }

    function writeUint32(val) {
        view.setUint32(offset, val, true); // Little-endian
        offset += 4;
    }

    function writeUint16(val) {
        view.setUint16(offset, val, true);
        offset += 2;
    }

    // RIFF header
    writeString('RIFF');
    writeUint32(aviSize);
    writeString('AVI ');

    // hdrl LIST
    writeString('LIST');
    writeUint32(hdrlSize);
    writeString('hdrl');

    // avih chunk (main AVI header)
    writeString('avih');
    writeUint32(56); // chunk size
    writeUint32(Math.round(1000000 / fps)); // microseconds per frame
    writeUint32(paddedFrameSize * fps); // max bytes per sec
    writeUint32(0); // padding granularity
    writeUint32(0x10); // flags (AVIF_HASINDEX)
    writeUint32(frameCount); // total frames
    writeUint32(0); // initial frames
    writeUint32(1); // number of streams
    writeUint32(paddedFrameSize); // suggested buffer size
    writeUint32(width); // width
    writeUint32(height); // height
    writeUint32(0); // reserved
    writeUint32(0);
    writeUint32(0);
    writeUint32(0);

    // strl LIST (stream list)
    writeString('LIST');
    writeUint32(strlSize);
    writeString('strl');

    // strh chunk (stream header)
    writeString('strh');
    writeUint32(56); // chunk size (AVISTREAMHEADER is 56 bytes)
    writeString('vids'); // stream type
    writeString('DIB '); // codec (uncompressed)
    writeUint32(0); // flags
    writeUint16(0); // priority
    writeUint16(0); // language
    writeUint32(0); // initial frames
    writeUint32(1); // scale
    writeUint32(fps); // rate
    writeUint32(0); // start
    writeUint32(frameCount); // length
    writeUint32(paddedFrameSize); // suggested buffer size
    writeUint32(0xFFFFFFFF); // quality (-1)
    writeUint32(0); // sample size
    writeUint16(0); // left
    writeUint16(0); // top
    writeUint16(width); // right
    writeUint16(height); // bottom

    // strf chunk (stream format - BITMAPINFOHEADER)
    writeString('strf');
    writeUint32(40); // chunk size
    writeUint32(40); // biSize
    writeUint32(width); // biWidth
    writeUint32(height); // biHeight (positive = bottom-up)
    writeUint16(1); // biPlanes
    writeUint16(24); // biBitCount
    writeUint32(0); // biCompression (BI_RGB)
    writeUint32(paddedFrameSize); // biSizeImage
    writeUint32(0); // biXPelsPerMeter
    writeUint32(0); // biYPelsPerMeter
    writeUint32(0); // biClrUsed
    writeUint32(0); // biClrImportant

    // movi LIST
    writeString('LIST');
    writeUint32(4 + moviSize);
    writeString('movi');

    const moviStart = offset - 4; // Position of 'movi' for index calculation
    const frameOffsets = [];

    // Write frame data
    for (let i = 0; i < frameCount; i++) {
        const frame = frames[i];
        frameOffsets.push(offset - moviStart);

        writeString('00dc'); // compressed video frame
        writeUint32(paddedFrameSize);

        // Convert RGBA to BGR, top-down
        const rgba = new Uint8Array(frame.rgbaBuffer);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = (y * width + x) * 4;
                view.setUint8(offset++, rgba[srcIdx + 2]); // B
                view.setUint8(offset++, rgba[srcIdx + 1]); // G
                view.setUint8(offset++, rgba[srcIdx]);     // R
            }
            // Pad row to 4-byte boundary
            const padding = paddedRowSize - width * 3;
            for (let p = 0; p < padding; p++) {
                view.setUint8(offset++, 0);
            }
        }
    }

    // idx1 chunk (index)
    writeString('idx1');
    writeUint32(idx1Size);

    for (let i = 0; i < frameCount; i++) {
        writeString('00dc');
        writeUint32(0x10); // AVIIF_KEYFRAME
        writeUint32(frameOffsets[i]);
        writeUint32(paddedFrameSize);
    }

    return new Blob([buffer], { type: 'video/avi' });
}
