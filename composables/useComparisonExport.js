// composables/useComparisonExport.js
// Handles capturing frames during processing and exporting a 2x2 comparison video

import { ref } from 'vue';

// Shared state for captured frames
const preCropFrames = ref([]);       // Frames before cropping (full frame, shows wobble)
const postCropFrames = ref([]);      // Frames after cropping (centered on planet)
const unstackedImage = ref(null);    // Raw stack before post-processing
const processedImage = ref(null);    // Final processed image

const MAX_COMPARISON_FRAMES = 10;

export function useComparisonExport() {
    /**
     * Store a pre-crop frame (full frame before cropping)
     * Called during frame analysis before crop is applied
     */
    function capturePreCropFrame(rgbaBuffer, width, height, index, totalFrames) {
        // Sample evenly across all frames
        const sampleInterval = Math.max(1, Math.floor(totalFrames / MAX_COMPARISON_FRAMES));

        if (index % sampleInterval === 0 && preCropFrames.value.length < MAX_COMPARISON_FRAMES) {
            // Clone the buffer since it may be transferred
            const clonedBuffer = rgbaBuffer.slice(0);
            preCropFrames.value.push({
                rgbaBuffer: clonedBuffer,
                width,
                height,
                index
            });
        }
    }

    /**
     * Store a post-crop frame (cropped and centered on planet)
     * Called during frame analysis after crop is applied
     */
    function capturePostCropFrame(rgbaBuffer, width, height, index, totalFrames) {
        // Sample evenly across all frames
        const sampleInterval = Math.max(1, Math.floor(totalFrames / MAX_COMPARISON_FRAMES));

        if (index % sampleInterval === 0 && postCropFrames.value.length < MAX_COMPARISON_FRAMES) {
            // Clone the buffer
            const clonedBuffer = rgbaBuffer.slice(0);
            postCropFrames.value.push({
                rgbaBuffer: clonedBuffer,
                width,
                height,
                index
            });
        }
    }

    /**
     * Store the unstacked (raw stack) image
     */
    function captureUnstackedImage(blob) {
        unstackedImage.value = blob;
    }

    /**
     * Store the processed image
     */
    function captureProcessedImage(blob) {
        processedImage.value = blob;
    }

    /**
     * Reset all captured data (call when starting new processing)
     */
    function resetCaptures() {
        preCropFrames.value = [];
        postCropFrames.value = [];
        unstackedImage.value = null;
        processedImage.value = null;
    }

    /**
     * Check if we have enough data to generate a comparison
     * Requires at least post-crop frames and unstacked image
     * Pre-crop frames are optional (shown if available)
     * Processed image is captured at download time from the canvas
     */
    function canExport() {
        return postCropFrames.value.length > 0 &&
               unstackedImage.value !== null;
    }

    /**
     * Get export status for UI
     */
    function getExportStatus() {
        return {
            preCropFrames: preCropFrames.value.length,
            postCropFrames: postCropFrames.value.length,
            hasUnstacked: unstackedImage.value !== null,
            hasProcessed: processedImage.value !== null,
            canExport: canExport()
        };
    }

    /**
     * Generate a 2x2 grid comparison video
     * Layout: [Original/Frames]  [Cropped/Centered]
     *         [Stacked]          [Processed]
     *
     * If pre-crop frames are available, shows original vs cropped animation.
     * Otherwise, shows single frame source animation.
     */
    async function generateComparisonVideo(ffmpeg, loadFFmpeg, onProgress) {
        if (!canExport()) {
            throw new Error('Not enough data captured for comparison video');
        }

        onProgress?.('Loading FFmpeg...');
        await loadFFmpeg();

        const gridSize = 512;  // Each quadrant is 256x256, total 512x512
        const quadrantSize = 256;
        const hasPreCrop = preCropFrames.value.length > 0;
        const frameCount = hasPreCrop
            ? Math.min(preCropFrames.value.length, postCropFrames.value.length)
            : postCropFrames.value.length;
        const fps = 10;

        onProgress?.('Preparing frames...');

        // Load static images (unstacked and processed)
        const unstackedImg = await blobToImageData(unstackedImage.value, quadrantSize, quadrantSize);
        const processedImg = await blobToImageData(processedImage.value, quadrantSize, quadrantSize);

        // Create canvas for compositing
        const canvas = document.createElement('canvas');
        canvas.width = gridSize;
        canvas.height = gridSize;
        const ctx = canvas.getContext('2d');

        // Generate each frame
        for (let i = 0; i < frameCount; i++) {
            onProgress?.(`Compositing frame ${i + 1}/${frameCount}...`);

            // Clear canvas
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, gridSize, gridSize);

            // Draw labels background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, gridSize, 20);
            ctx.fillRect(0, quadrantSize, gridSize, 20);

            // Top-left: Pre-crop frame if available, otherwise first post-crop frame (static)
            if (hasPreCrop) {
                const preCropFrame = preCropFrames.value[i % preCropFrames.value.length];
                drawScaledFrame(ctx, preCropFrame.rgbaBuffer, preCropFrame.width, preCropFrame.height, 0, 0, quadrantSize, quadrantSize);
            } else {
                // Show first frame as static "original"
                const firstFrame = postCropFrames.value[0];
                drawScaledFrame(ctx, firstFrame.rgbaBuffer, firstFrame.width, firstFrame.height, 0, 0, quadrantSize, quadrantSize);
            }

            // Top-right: Post-crop frame (animated, centered on planet)
            const postCropFrame = postCropFrames.value[i % postCropFrames.value.length];
            drawScaledFrame(ctx, postCropFrame.rgbaBuffer, postCropFrame.width, postCropFrame.height, quadrantSize, 0, quadrantSize, quadrantSize);

            // Bottom-left: Unstacked (static)
            ctx.drawImage(unstackedImg, 0, quadrantSize);

            // Bottom-right: Processed (static)
            ctx.drawImage(processedImg, quadrantSize, quadrantSize);

            // Draw labels
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(hasPreCrop ? 'Original' : 'Frame', 8, 14);
            ctx.fillText('Cropped', quadrantSize + 8, 14);
            ctx.fillText('Stacked', 8, quadrantSize + 14);
            ctx.fillText('Processed', quadrantSize + 8, quadrantSize + 14);

            // Convert canvas to PNG and write to FFmpeg
            const frameBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const frameData = new Uint8Array(await frameBlob.arrayBuffer());
            const frameName = `frame${String(i).padStart(4, '0')}.png`;
            ffmpeg.FS('writeFile', frameName, frameData);
        }

        onProgress?.('Encoding MP4...');

        // Encode to MP4 using FFmpeg
        await ffmpeg.run(
            '-framerate', String(fps),
            '-i', 'frame%04d.png',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-crf', '23',
            '-preset', 'fast',
            '-movflags', '+faststart',
            'comparison.mp4'
        );

        // Read the output
        const mp4Data = ffmpeg.FS('readFile', 'comparison.mp4');

        // Cleanup
        for (let i = 0; i < frameCount; i++) {
            const frameName = `frame${String(i).padStart(4, '0')}.png`;
            try { ffmpeg.FS('unlink', frameName); } catch (e) {}
        }
        try { ffmpeg.FS('unlink', 'comparison.mp4'); } catch (e) {}

        onProgress?.('Done!');

        return new Blob([mp4Data.buffer], { type: 'video/mp4' });
    }

    /**
     * Helper: Convert blob to canvas ImageData scaled to target size
     */
    async function blobToImageData(blob, targetWidth, targetHeight) {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        URL.revokeObjectURL(url);

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');

        // Scale to fit while maintaining aspect ratio
        const scale = Math.min(targetWidth / img.width, targetHeight / img.height);
        const drawWidth = img.width * scale;
        const drawHeight = img.height * scale;
        const offsetX = (targetWidth - drawWidth) / 2;
        const offsetY = (targetHeight - drawHeight) / 2;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

        return canvas;
    }

    /**
     * Helper: Draw RGBA buffer scaled to target area
     */
    function drawScaledFrame(ctx, rgbaBuffer, srcWidth, srcHeight, destX, destY, destWidth, destHeight) {
        // Create temporary canvas for the source frame
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const tempCtx = tempCanvas.getContext('2d');

        const imageData = new ImageData(
            new Uint8ClampedArray(rgbaBuffer),
            srcWidth,
            srcHeight
        );
        tempCtx.putImageData(imageData, 0, 0);

        // Scale to fit while maintaining aspect ratio
        const scale = Math.min(destWidth / srcWidth, destHeight / srcHeight);
        const drawWidth = srcWidth * scale;
        const drawHeight = srcHeight * scale;
        const offsetX = destX + (destWidth - drawWidth) / 2;
        const offsetY = destY + (destHeight - drawHeight) / 2;

        ctx.drawImage(tempCanvas, offsetX, offsetY, drawWidth, drawHeight);
    }

    return {
        capturePreCropFrame,
        capturePostCropFrame,
        captureUnstackedImage,
        captureProcessedImage,
        resetCaptures,
        canExport,
        getExportStatus,
        generateComparisonVideo,
        // Expose refs for reactivity
        preCropFrames,
        postCropFrames,
        unstackedImage,
        processedImage
    };
}
