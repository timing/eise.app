// Shared helpers for the two single-image "direct load into post-processor"
// entry points (FileUploader on the homepage, "Load another image" inside the
// post-processor). Kept in one place so format detection, HEIC decoding, and
// the post_open / post_failed telemetry stay symmetric between callers.
//
// Not used by the stacking pipeline — batch-image stacking has its own reader
// (useImageReader) that reuses only RAW_EXTENSIONS from here.

import { useTracking } from './useTracking';

export const RAW_EXTENSIONS = ['.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf'];

export function isRawFile(file) {
    const name = file?.name?.toLowerCase() || '';
    return RAW_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function detectImageFormat(file) {
    const name = file?.name || '';
    const fileName = name.toLowerCase();
    const dot = name.lastIndexOf('.');
    const extRaw = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    const ext = (extRaw || file?.type || 'unknown').slice(0, 40);
    return {
        ext,
        isRaw: isRawFile(file),
        isTiff: file?.type === 'image/tiff' || fileName.endsWith('.tif') || fileName.endsWith('.tiff'),
        isHeic: file?.type === 'image/heic' || file?.type === 'image/heif'
            || fileName.endsWith('.heic') || fileName.endsWith('.heif'),
        isNativeFormat: ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file?.type),
    };
}

// FFmpeg-WASM doesn't ship libheif, so both callers try the browser-native
// decoder instead. Succeeds on Safari (macOS/iOS); throws elsewhere.
export async function decodeHeicToBlob(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await canvas.convertToBlob({ type: 'image/png' });
}

export function useDirectImageLoad() {
    const { track } = useTracking();

    function trackPostOpen(file, extra = null) {
        const { ext } = detectImageFormat(file);
        track('post_open', {
            filename: file?.name ? String(file.name).slice(0, 200) : null,
            format: ext,
            ...(extra || {}),
        });
    }

    function trackPostFailed(file, reason, extra = null) {
        const { ext } = detectImageFormat(file);
        track('post_failed', {
            filename: file?.name ? String(file.name).slice(0, 200) : null,
            format: ext,
            reason: String(reason || 'unknown').slice(0, 200),
            ...(extra || {}),
        });
    }

    return { trackPostOpen, trackPostFailed };
}
