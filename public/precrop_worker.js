/**
 * Pre-crop worker - extracts Bayer sub-regions in parallel with GPU work
 * Aligns to 2-pixel boundaries to preserve Bayer pattern
 */

self.onmessage = function(e) {
    const { frames, srcWidth, srcHeight, region, requestId } = e.data;

    // Align to 2-pixel boundaries for Bayer pattern
    let x = Math.floor(region.x / 2) * 2;
    let y = Math.floor(region.y / 2) * 2;
    let width = Math.ceil((region.x + region.width - x) / 2) * 2;
    let height = Math.ceil((region.y + region.height - y) / 2) * 2;

    // Clamp to source bounds
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.min(width, srcWidth - x);
    height = Math.min(height, srcHeight - y);

    // Ensure even dimensions
    width = Math.floor(width / 2) * 2;
    height = Math.floor(height / 2) * 2;

    const croppedFrames = [];
    const transferList = [];

    for (const frame of frames) {
        const src = frame.data;
        const ArrayType = src.constructor;
        const dst = new ArrayType(width * height);

        // Copy rows
        for (let row = 0; row < height; row++) {
            const srcOffset = (y + row) * srcWidth + x;
            const dstOffset = row * width;
            dst.set(src.subarray(srcOffset, srcOffset + width), dstOffset);
        }

        croppedFrames.push({ data: dst, index: frame.index });
        transferList.push(dst.buffer);
    }

    self.postMessage({
        requestId,
        frames: croppedFrames,
        offset: { x, y, width, height }
    }, transferList);
};
