// composables/useLiteMemoryLimits.js
// Dynamic memory-based frame limits for Lite mode

export function useLiteMemoryLimits() {
    function detectPlatform() {
        const ua = navigator.userAgent;
        if (/Android/i.test(ua)) return 'android';
        // iOS, iPad, or desktop with ?lite=1 all use iOS (restrictive) path
        return 'ios';
    }

    // Returns estimated available memory in MB
    function estimateAvailableMemory(platform) {
        const deviceMemoryGB = navigator.deviceMemory || 4;

        const thresholds = {
            android: { base: 512, perGB: 200, max: 1500 },
            ios:     { base: 300, perGB: 100, max: 800 }
        };

        const config = thresholds[platform];
        return Math.min(config.max, config.base + deviceMemoryGB * config.perGB);
    }

    // Check if file can be processed by FFmpeg WASM
    // FFmpeg streams video so file size is less critical than frame memory
    function checkFileSize(fileSizeMB, platform) {
        // Simple hard limits - FFmpeg can handle larger files since it streams
        const maxFileMB = platform === 'android' ? 800 : 500;

        if (fileSizeMB > maxFileMB) {
            return {
                canProcess: false,
                reason: `File too large (${Math.round(fileSizeMB)}MB, max ${maxFileMB}MB)`
            };
        }
        return { canProcess: true };
    }

    // Calculate max frames based on crop size
    function calculateMaxFrames(cropSize, platform) {
        const availableMB = estimateAvailableMemory(platform);

        // Memory per cropped frame (RGBA + working buffers)
        const bytesPerFrame = cropSize * cropSize * 4 * 3;
        const mbPerFrame = bytesPerFrame / (1024 * 1024);

        // Reserves: 2 workers (~256MB), stacking accumulator, templates
        const reserves = 256 + (cropSize * cropSize * 16) / (1024 * 1024) + 50;

        const availableForFrames = availableMB - reserves;
        const maxFrames = Math.floor(availableForFrames / mbPerFrame);

        // Android gets 1.5x multiplier (better memory handling)
        const multiplier = platform === 'android' ? 1.5 : 1.0;
        const adjusted = Math.floor(maxFrames * multiplier);

        return Math.max(20, Math.min(adjusted, 200));
    }

    return { detectPlatform, estimateAvailableMemory, checkFileSize, calculateMaxFrames };
}
