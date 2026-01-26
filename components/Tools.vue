<template>
    <div class="page-layout">
    <div class="card tools-card">
        <h2>Tools</h2>

        <div class="tool-section">
            <h3>Worker Loading Test</h3>
            <p class="tool-description">Test different methods of loading web workers on Cloudflare.</p>

            <button @click="runWorkerTests" :disabled="workerTestRunning" class="test-button">
                {{ workerTestRunning ? 'Testing...' : 'Run Worker Tests' }}
            </button>

            <div v-if="workerTestResults.length > 0" class="test-results">
                <div
                    v-for="(result, idx) in workerTestResults"
                    :key="idx"
                    :class="['test-result', result.success ? 'success' : 'error']"
                >
                    <span class="method">{{ result.method }}:</span>
                    <span class="message">{{ result.message }}</span>
                </div>
            </div>
        </div>

        <div class="separator"></div>

        <div class="tool-section">
            <h3>FFmpeg FS Access Test</h3>
            <p class="tool-description">Test if we can read files from FFmpeg's filesystem during encoding.</p>

            <div class="file-input-wrapper">
                <input
                    type="file"
                    accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
                    @change="handleVideoSelect"
                    ref="videoInput"
                    id="video-file-input"
                />
                <label for="video-file-input" class="file-label">
                    {{ selectedVideo ? selectedVideo.name : 'Select video file...' }}
                </label>
            </div>

            <button
                @click="runFfmpegFsTest"
                :disabled="ffmpegTestRunning || !selectedVideo"
                class="test-button"
            >
                {{ ffmpegTestRunning ? 'Testing...' : 'Run FFmpeg FS Test' }}
            </button>

            <div v-if="ffmpegTestLog.length > 0" class="test-results ffmpeg-log">
                <div
                    v-for="(entry, idx) in ffmpegTestLog"
                    :key="idx"
                    :class="['test-result', entry.type]"
                >
                    <span class="message">{{ entry.message }}</span>
                </div>
            </div>
        </div>

        <div class="separator"></div>

        <div class="tool-section">
            <h3>SER Analyzer</h3>
            <p class="tool-description">Analyze SER file bit depth and Bayer pattern.</p>

            <div class="file-input-wrapper">
                <input
                    type="file"
                    accept=".ser"
                    @change="handleAnalyzerFileSelect"
                    ref="analyzerFileInput"
                    id="analyzer-ser-input"
                />
                <label for="analyzer-ser-input" class="file-label">
                    {{ analyzerFile ? analyzerFile.name : 'Select SER file...' }}
                </label>
            </div>

            <div v-if="analyzerHeader" class="file-info">
                <div class="info-row">
                    <span class="label">Dimensions:</span>
                    <span class="value">{{ analyzerHeader.width }} x {{ analyzerHeader.height }}</span>
                </div>
                <div class="info-row">
                    <span class="label">Header bit depth:</span>
                    <span class="value">{{ analyzerHeader.pixelDepth }}-bit</span>
                </div>
                <div class="info-row">
                    <span class="label">Frames:</span>
                    <span class="value">{{ analyzerHeader.frameCount }}</span>
                </div>
                <div class="info-row">
                    <span class="label">File size analysis:</span>
                    <span class="value">{{ fileSizeAnalysis }}</span>
                </div>
                <div class="info-row">
                    <span class="label">Pixel value range:</span>
                    <span class="value">{{ pixelValueRange }}</span>
                </div>
            </div>

            <div v-if="analyzerHeader" class="analyzer-controls">
                <div class="control-row">
                    <label>Bit depth:</label>
                    <div class="toggle-buttons">
                        <button
                            :class="{ active: forcedBitDepth === 8 }"
                            @click="setForcedBitDepth(8)"
                        >8-bit</button>
                        <button
                            :class="{ active: forcedBitDepth === 16 }"
                            @click="setForcedBitDepth(16)"
                        >16-bit</button>
                    </div>
                </div>

                <div class="control-row" v-if="forcedBitDepth === 16">
                    <label>Byte swap:</label>
                    <div class="toggle-buttons">
                        <button
                            :class="{ active: !byteSwap }"
                            @click="setByteSwap(false)"
                        >Off</button>
                        <button
                            :class="{ active: byteSwap }"
                            @click="setByteSwap(true)"
                        >On</button>
                    </div>
                </div>

                <div class="control-row">
                    <label>Byte offset: {{ byteOffset }}</label>
                    <input
                        type="range"
                        v-model.number="byteOffset"
                        min="0"
                        max="7"
                        @input="renderAnalyzerThumbnails"
                    />
                </div>

                <div class="raw-bytes-preview">
                    <label>First 32 raw bytes:</label>
                    <div class="bytes-display">{{ rawBytesPreview }}</div>
                </div>
            </div>

            <div v-if="analyzerHeader" class="bayer-thumbnails">
                <h4>Bayer Pattern Preview</h4>
                <div v-if="!thumbnailsReady" class="loading-thumbnails">
                    <p>Rendering previews...</p>
                </div>
                <div class="thumbnails-grid" :class="{ hidden: !thumbnailsReady }">
                    <div
                        v-for="profile in bayerProfiles"
                        :key="profile.id"
                        class="thumbnail-item"
                    >
                        <canvas :ref="el => thumbnailCanvases[profile.id] = el" class="thumbnail-canvas"></canvas>
                        <div class="thumbnail-label">{{ profile.label }}</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="separator"></div>

        <div class="tool-section">
            <h3>Trim SER File</h3>
            <p class="tool-description">Extract a range of frames from a SER file without re-encoding.</p>

            <div class="file-input-wrapper">
                <input
                    type="file"
                    accept=".ser"
                    @change="handleFileSelect"
                    ref="fileInput"
                    id="ser-file-input"
                />
                <label for="ser-file-input" class="file-label">
                    {{ selectedFile ? selectedFile.name : 'Select SER file...' }}
                </label>
            </div>

            <div v-if="serHeader" class="file-info">
                <div class="info-row">
                    <span class="label">Dimensions:</span>
                    <span class="value">{{ serHeader.width }} x {{ serHeader.height }}</span>
                </div>
                <div class="info-row">
                    <span class="label">Bit depth:</span>
                    <span class="value">{{ serHeader.pixelDepth }}-bit</span>
                </div>
                <div class="info-row">
                    <span class="label">Total frames:</span>
                    <span class="value">{{ serHeader.frameCount }}</span>
                </div>
                <div class="info-row" v-if="serHeader.observer && !isDefaultObserver">
                    <span class="label">Observer:</span>
                    <span class="value">{{ serHeader.observer }}</span>
                </div>
            </div>

            <div v-if="serHeader" class="trim-controls">
                <div class="separator"></div>

                <div class="input-group">
                    <label for="start-frame">Start frame:</label>
                    <input
                        type="number"
                        id="start-frame"
                        v-model.number="startFrame"
                        :min="1"
                        :max="serHeader.frameCount"
                    />
                </div>

                <div class="input-group">
                    <label for="end-frame">End frame:</label>
                    <input
                        type="number"
                        id="end-frame"
                        v-model.number="endFrame"
                        :min="startFrame"
                        :max="serHeader.frameCount"
                    />
                </div>

                <div class="output-info">
                    <span class="label">Output frames:</span>
                    <span class="value">{{ outputFrameCount }}</span>
                    <span class="percentage">({{ outputPercentage }}%)</span>
                </div>

                <div class="separator"></div>

                <button
                    @click="trimAndDownload"
                    :disabled="isProcessing || outputFrameCount <= 0"
                    class="download-button"
                >
                    {{ isProcessing ? 'Processing...' : 'Download Trimmed SER' }}
                </button>

                <div v-if="isProcessing" class="progress-bar">
                    <div class="progress-fill" :style="{ width: progress + '%' }"></div>
                </div>
            </div>
        </div>
    </div>
    <div class="content">
        <h2>Tools</h2>
        <p>Explore planetary imaging file formats and test how eise.app processes your data. Useful for troubleshooting or seeing what's under the hood.</p>
    </div>
    </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import { parseSerHeader } from '@/composables/useSerReader';

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

// Worker test state
const workerTestRunning = ref(false);
const workerTestResults = ref([]);

// Inline worker code for blob test
const inlineWorkerCode = `
self.addEventListener('message', (e) => {
    const { method, timestamp } = e.data;
    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
        sum += Math.sqrt(i);
    }
    const elapsed = performance.now() - start;
    self.postMessage({
        method,
        success: true,
        message: 'Worker responded in ' + elapsed.toFixed(2) + 'ms',
        timestamp,
        computeResult: sum
    });
});
`;

async function testWorkerMethod(method, createWorker) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ method, success: false, message: 'Timeout after 5s' });
        }, 5000);

        try {
            const worker = createWorker();
            worker.onmessage = (e) => {
                clearTimeout(timeout);
                worker.terminate();
                resolve({ method, success: true, message: e.data.message });
            };
            worker.onerror = (err) => {
                clearTimeout(timeout);
                worker.terminate();
                resolve({ method, success: false, message: err.message || 'Worker error' });
            };
            worker.postMessage({ method, timestamp: Date.now() });
        } catch (err) {
            clearTimeout(timeout);
            resolve({ method, success: false, message: err.message || 'Failed to create worker' });
        }
    });
}

async function runWorkerTests() {
    workerTestRunning.value = true;
    workerTestResults.value = [];

    const tests = [
        {
            method: '1. Vite URL import (classic)',
            createWorker: () => new Worker(
                new URL('../workers/testWorker.js', import.meta.url)
            )
        },
        {
            method: '2. Vite URL import (module)',
            createWorker: () => new Worker(
                new URL('../workers/testWorker.js', import.meta.url),
                { type: 'module' }
            )
        },
        {
            method: '3. Inline Blob worker',
            createWorker: () => {
                const blob = new Blob([inlineWorkerCode], { type: 'application/javascript' });
                return new Worker(URL.createObjectURL(blob));
            }
        }
    ];

    for (const test of tests) {
        const result = await testWorkerMethod(test.method, test.createWorker);
        workerTestResults.value.push(result);
    }

    workerTestRunning.value = false;
}

// FFmpeg FS test state
const videoInput = ref(null);
const selectedVideo = ref(null);
const ffmpegTestRunning = ref(false);
const ffmpegTestLog = ref([]);

function handleVideoSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedVideo.value = file;
        ffmpegTestLog.value = [];
    }
}

function logFfmpeg(message, type = 'info') {
    ffmpegTestLog.value.push({ message, type });
}

async function runFfmpegFsTest() {
    if (!selectedVideo.value) return;

    ffmpegTestRunning.value = true;
    ffmpegTestLog.value = [];

    try {
        logFfmpeg('Loading FFmpeg...');
        await $loadFFmpeg();
        logFfmpeg('FFmpeg loaded', 'success');

        // Write video to FFmpeg filesystem
        logFfmpeg(`Writing ${selectedVideo.value.name} to FFmpeg FS...`);
        const videoData = await selectedVideo.value.arrayBuffer();
        $ffmpeg.FS('writeFile', 'input.mp4', new Uint8Array(videoData));
        logFfmpeg('Video written to FS', 'success');

        // Track files we've seen and read
        const seenFiles = new Set();
        const readFiles = [];
        let lastReportedFrame = 0;

        // Set up logger to test FS access during encoding
        $ffmpeg.setLogger(({ type, message }) => {
            if (typeof message !== 'string') return;

            const frameMatch = message.match(/frame=\s*(\d+)/);
            if (frameMatch) {
                const currentFrame = parseInt(frameMatch[1], 10);
                if (currentFrame === lastReportedFrame) return;
                lastReportedFrame = currentFrame;

                // Try to read directory during callback
                try {
                    const files = $ffmpeg.FS('readdir', '/');
                    const pngFiles = files.filter(f => f.endsWith('.png'));

                    // Log new files found
                    for (const file of pngFiles) {
                        if (!seenFiles.has(file)) {
                            seenFiles.add(file);
                        }
                    }

                    // Only log every 20 frames to avoid flooding
                    if (currentFrame % 20 === 0) {
                        logFfmpeg(`Frame ${currentFrame}: ${pngFiles.length} PNG files exist`, 'info');
                    }

                    // Try to read ANY available file we haven't read yet
                    for (const filename of pngFiles) {
                        if (readFiles.includes(filename)) continue;

                        try {
                            const data = $ffmpeg.FS('readFile', filename);
                            readFiles.push(filename);
                            logFfmpeg(`READ SUCCESS: ${filename} (${data.length} bytes) at frame ${currentFrame}`, 'success');

                            // Try to delete it
                            try {
                                $ffmpeg.FS('unlink', filename);
                                logFfmpeg(`DELETE SUCCESS: ${filename}`, 'success');
                            } catch (delErr) {
                                logFfmpeg(`DELETE FAILED: ${filename} - ${delErr.message}`, 'error');
                            }

                            // Only try one file per callback to avoid blocking too long
                            break;
                        } catch (readErr) {
                            // Don't log every failure - file might not be fully written
                        }
                    }
                } catch (e) {
                    logFfmpeg(`FS access failed at frame ${currentFrame}: ${e.message}`, 'error');
                }
            }
        });

        // Run FFmpeg to extract frames as PNGs
        logFfmpeg('Starting FFmpeg encoding...');
        try {
            await $ffmpeg.run('-i', 'input.mp4', 'frame_%04d.png');
        } catch (e) {
            logFfmpeg(`FFmpeg run error (may be normal): ${e.message}`, 'info');
        }

        // Clear logger
        $ffmpeg.setLogger(() => {});

        // Final summary
        logFfmpeg(`--- Test Complete ---`, 'info');
        logFfmpeg(`Total files seen during encoding: ${seenFiles.size}`, 'info');
        logFfmpeg(`Files successfully read during encoding: ${readFiles.length}`, readFiles.length > 0 ? 'success' : 'error');

        // Cleanup
        try {
            $ffmpeg.FS('unlink', 'input.mp4');
            const remainingFiles = $ffmpeg.FS('readdir', '/').filter(f => f.endsWith('.png'));
            for (const f of remainingFiles) {
                $ffmpeg.FS('unlink', f);
            }
            logFfmpeg(`Cleanup complete, removed ${remainingFiles.length} remaining files`, 'info');
        } catch (e) {
            logFfmpeg(`Cleanup error: ${e.message}`, 'error');
        }

    } catch (error) {
        logFfmpeg(`Test failed: ${error.message}`, 'error');
    } finally {
        ffmpegTestRunning.value = false;
    }
}

// SER Analyzer state
const analyzerFileInput = ref(null);
const analyzerFile = ref(null);
const analyzerBuffer = ref(null);
const analyzerHeader = ref(null);
const forcedBitDepth = ref(16);
const byteSwap = ref(false);
const byteOffset = ref(0);
const thumbnailCanvases = ref({});
const thumbnailsReady = ref(false);
const pixelValueRange = ref('');
const fileSizeAnalysis = ref('');
const rawBytesPreview = ref('');

const bayerProfiles = [
    { id: 'RGGB', label: 'RGGB' },
    { id: 'BGGR', label: 'BGGR' },
    { id: 'GBRG', label: 'GBRG' },
    { id: 'GRBG', label: 'GRBG' },
    { id: 'MONO', label: 'Mono' }
];

async function handleAnalyzerFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    analyzerFile.value = file;
    thumbnailsReady.value = false;

    // Read header
    const headerBuf = await file.slice(0, 178).arrayBuffer();
    const header = parseSerHeader(headerBuf);
    analyzerHeader.value = header;

    // Analyze file size
    const frameSize16 = header.width * header.height * 2;
    const frameSize8 = header.width * header.height * 1;
    const dataSize = file.size - 178;
    const frameCount16 = Math.floor(dataSize / frameSize16);
    const frameCount8 = Math.floor(dataSize / frameSize8);
    fileSizeAnalysis.value = `as 16-bit: ${frameCount16} frames, as 8-bit: ${frameCount8} frames`;

    // Set initial bit depth based on header
    forcedBitDepth.value = header.pixelDepth > 8 ? 16 : 8;

    // Read first frame and analyze pixel values
    const bpp = header.pixelDepth > 8 ? 2 : 1;
    const frameSize = header.width * header.height * bpp;
    const frameBuffer = await file.slice(178, 178 + frameSize).arrayBuffer();
    analyzerBuffer.value = frameBuffer;

    analyzePixelValues(frameBuffer, header.pixelDepth);
    updateRawBytesPreview(frameBuffer);
    await renderAnalyzerThumbnails();
}

function analyzePixelValues(buffer, headerBitDepth) {
    let minVal, maxVal;

    if (headerBitDepth > 8) {
        const u16 = new Uint16Array(buffer);
        minVal = Infinity;
        maxVal = 0;
        for (let i = 0; i < Math.min(10000, u16.length); i++) {
            if (u16[i] < minVal) minVal = u16[i];
            if (u16[i] > maxVal) maxVal = u16[i];
        }
    } else {
        const u8 = new Uint8Array(buffer);
        minVal = Infinity;
        maxVal = 0;
        for (let i = 0; i < Math.min(10000, u8.length); i++) {
            if (u8[i] < minVal) minVal = u8[i];
            if (u8[i] > maxVal) maxVal = u8[i];
        }
    }

    pixelValueRange.value = `${minVal} - ${maxVal}`;
}

function setForcedBitDepth(depth) {
    forcedBitDepth.value = depth;
    renderAnalyzerThumbnails();
}

function setByteSwap(swap) {
    byteSwap.value = swap;
    renderAnalyzerThumbnails();
}

function updateRawBytesPreview(buffer) {
    const bytes = new Uint8Array(buffer);
    const preview = [];
    for (let i = 0; i < Math.min(32, bytes.length); i++) {
        preview.push(bytes[i].toString(16).padStart(2, '0'));
    }
    rawBytesPreview.value = preview.join(' ');
}

async function renderAnalyzerThumbnails() {
    if (!analyzerBuffer.value || !analyzerHeader.value) return;

    thumbnailsReady.value = false;
    await nextTick();

    const header = analyzerHeader.value;
    const buffer = analyzerBuffer.value;
    const useBitDepth = forcedBitDepth.value;
    const offset = byteOffset.value;
    const swap = byteSwap.value;

    // Get raw data based on forced bit depth interpretation
    let width = header.width;
    let height = header.height;
    let src;

    // Apply byte offset by creating a shifted view
    const rawBytes = new Uint8Array(buffer);
    const offsetBytes = rawBytes.slice(offset);

    if (useBitDepth === 16) {
        // Create Uint16Array from offset bytes
        const u16 = new Uint16Array(Math.floor(offsetBytes.length / 2));
        for (let i = 0; i < u16.length; i++) {
            if (swap) {
                // Big-endian: high byte first
                u16[i] = (offsetBytes[i * 2] << 8) | offsetBytes[i * 2 + 1];
            } else {
                // Little-endian: low byte first (default)
                u16[i] = offsetBytes[i * 2] | (offsetBytes[i * 2 + 1] << 8);
            }
        }
        src = u16;
    } else {
        src = offsetBytes;
    }

    const srcScale = useBitDepth === 16 ? 1/256 : 1;
    const pixelCount = src.length;
    const actualWidth = useBitDepth === 8 && header.pixelDepth > 8 ? width : width;
    const actualHeight = useBitDepth === 8 && header.pixelDepth > 8 ? height * 2 : height;

    // Calculate thumbnail size
    const maxSize = 120;
    const scale = Math.min(maxSize / actualWidth, maxSize / actualHeight);
    const thumbWidth = Math.floor(actualWidth * scale);
    const thumbHeight = Math.floor(actualHeight * scale);

    // Bayer pattern configs
    const patternConfigs = [
        { id: 'RGGB', rX: 0, rY: 0, bX: 1, bY: 1 },
        { id: 'BGGR', rX: 1, rY: 1, bX: 0, bY: 0 },
        { id: 'GBRG', rX: 0, rY: 1, bX: 1, bY: 0 },
        { id: 'GRBG', rX: 1, rY: 0, bX: 0, bY: 1 },
        { id: 'MONO', mono: true }
    ];

    for (const config of patternConfigs) {
        const canvas = thumbnailCanvases.value[config.id];
        if (!canvas) continue;

        canvas.width = thumbWidth;
        canvas.height = thumbHeight;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(thumbWidth, thumbHeight);
        const data = imageData.data;

        const xRatio = actualWidth / thumbWidth;
        const yRatio = actualHeight / thumbHeight;

        let minVal = 255, maxVal = 0;
        const tempRgb = new Float32Array(thumbWidth * thumbHeight * 3);

        // First pass: demosaic and find min/max
        for (let ty = 0; ty < thumbHeight; ty++) {
            for (let tx = 0; tx < thumbWidth; tx++) {
                const sx = Math.floor(tx * xRatio);
                const sy = Math.floor(ty * yRatio);
                const tidx = (ty * thumbWidth + tx) * 3;

                if (config.mono) {
                    const idx = sy * actualWidth + sx;
                    const v = (idx < src.length ? src[idx] : 0) * srcScale;
                    tempRgb[tidx] = tempRgb[tidx + 1] = tempRgb[tidx + 2] = v;
                } else {
                    const bx = sx & ~1;
                    const by = sy & ~1;
                    const getVal = (x, y) => {
                        const idx = Math.min(y, actualHeight-1) * actualWidth + Math.min(x, actualWidth-1);
                        return (idx < src.length ? src[idx] : 0) * srcScale;
                    };

                    const rPos = { x: bx + config.rX, y: by + config.rY };
                    const bPos = { x: bx + config.bX, y: by + config.bY };
                    const g1 = { x: bx + (1 - config.rX), y: by + config.rY };
                    const g2 = { x: bx + config.rX, y: by + (1 - config.rY) };

                    tempRgb[tidx] = getVal(rPos.x, rPos.y);
                    tempRgb[tidx + 1] = (getVal(g1.x, g1.y) + getVal(g2.x, g2.y)) / 2;
                    tempRgb[tidx + 2] = getVal(bPos.x, bPos.y);
                }

                const lum = (tempRgb[tidx] + tempRgb[tidx + 1] + tempRgb[tidx + 2]) / 3;
                minVal = Math.min(minVal, lum);
                maxVal = Math.max(maxVal, lum);
            }
        }

        // Second pass: auto-stretch
        const range = maxVal - minVal || 1;
        const stretchScale = 255 / range;

        for (let i = 0; i < thumbWidth * thumbHeight; i++) {
            const tidx = i * 3;
            const didx = i * 4;
            data[didx] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx] - minVal) * stretchScale)));
            data[didx + 1] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 1] - minVal) * stretchScale)));
            data[didx + 2] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 2] - minVal) * stretchScale)));
            data[didx + 3] = 255;
        }

        ctx.putImageData(imageData, 0, 0);
    }

    thumbnailsReady.value = true;
}

// SER trimmer state
const fileInput = ref(null);
const selectedFile = ref(null);
const fileBuffer = ref(null);
const serHeader = ref(null);
const startFrame = ref(1);
const endFrame = ref(1);
const isProcessing = ref(false);
const progress = ref(0);

const SER_HEADER_SIZE = 178;

const outputFrameCount = computed(() => {
    if (!serHeader.value) return 0;
    return Math.max(0, endFrame.value - startFrame.value + 1);
});

const outputPercentage = computed(() => {
    if (!serHeader.value || serHeader.value.frameCount === 0) return 0;
    return Math.round((outputFrameCount.value / serHeader.value.frameCount) * 100);
});

const isDefaultObserver = computed(() => {
    if (!serHeader.value?.observer) return true;
    const obs = serHeader.value.observer.toLowerCase();
    return obs === 'observer name' || obs === 'observer' || obs === 'unknown';
});

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    selectedFile.value = file;

    // Read the file
    const buffer = await file.arrayBuffer();
    fileBuffer.value = buffer;

    // Parse header
    const header = parseSerHeader(buffer);
    serHeader.value = header;

    // Set default range to full file
    startFrame.value = 1;
    endFrame.value = header.frameCount;
}

async function trimAndDownload() {
    if (!fileBuffer.value || !serHeader.value) return;

    isProcessing.value = true;
    progress.value = 0;

    try {
        const trimmedBlob = await createTrimmedSerFile();

        // Download
        const url = URL.createObjectURL(trimmedBlob);
        const a = document.createElement('a');
        a.href = url;

        // Generate filename
        const originalName = selectedFile.value.name.replace(/\.ser$/i, '');
        a.download = `${originalName}_trimmed_${startFrame.value}-${endFrame.value}.ser`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error('Error trimming SER file:', error);
        alert('Error trimming file: ' + error.message);
    } finally {
        isProcessing.value = false;
        progress.value = 0;
    }
}

async function createTrimmedSerFile() {
    const header = serHeader.value;
    const bytesPerPixel = header.pixelDepth > 8 ? 2 : 1;
    const frameSize = header.width * header.height * bytesPerPixel;

    // Calculate frame indices (0-based internally)
    const startIdx = startFrame.value - 1;
    const endIdx = endFrame.value - 1;
    const newFrameCount = endIdx - startIdx + 1;

    // Create new header
    const newHeader = new ArrayBuffer(SER_HEADER_SIZE);
    const headerView = new DataView(newHeader);
    const originalHeaderView = new DataView(fileBuffer.value);

    // Copy original header
    new Uint8Array(newHeader).set(new Uint8Array(fileBuffer.value.slice(0, SER_HEADER_SIZE)));

    // Update frame count
    headerView.setInt32(38, newFrameCount, true);

    // Calculate total size for trimmed file
    const trimmedDataSize = newFrameCount * frameSize;
    const trimmedFile = new ArrayBuffer(SER_HEADER_SIZE + trimmedDataSize);

    // Copy header
    new Uint8Array(trimmedFile).set(new Uint8Array(newHeader));

    // Copy frames
    const trimmedData = new Uint8Array(trimmedFile);
    const sourceData = new Uint8Array(fileBuffer.value);

    for (let i = 0; i < newFrameCount; i++) {
        const sourceOffset = SER_HEADER_SIZE + (startIdx + i) * frameSize;
        const destOffset = SER_HEADER_SIZE + i * frameSize;

        // Copy frame data
        trimmedData.set(
            sourceData.slice(sourceOffset, sourceOffset + frameSize),
            destOffset
        );

        // Update progress
        progress.value = Math.round(((i + 1) / newFrameCount) * 100);

        // Yield to UI every 100 frames
        if (i % 100 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return new Blob([trimmedFile], { type: 'application/octet-stream' });
}
</script>

<style scoped>
.tools-card {
    margin: 0;
}

.tools-card h2 {
    margin-top: 0;
    margin-bottom: 20px;
    color: #333;
}

.tool-section h3 {
    margin-top: 0;
    margin-bottom: 5px;
    font-size: 14px;
    color: #333;
}

.tool-description {
    margin: 0 0 15px 0;
    color: #666;
    font-size: 12px;
}

.file-input-wrapper {
    position: relative;
    margin-bottom: 15px;
}

.file-input-wrapper input[type="file"] {
    position: absolute;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
}

.file-label {
    display: block;
    padding: 10px 15px;
    background: #f5f5f5;
    border: 2px dashed #ccc;
    border-radius: 5px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    color: #666;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.file-label:hover {
    border-color: #8CCF7E;
    background: #f0fff0;
}

.file-info {
    background: #f9f9f9;
    padding: 10px;
    border-radius: 5px;
    margin-bottom: 10px;
}

.info-row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
}

.info-row .label {
    color: #666;
}

.info-row .value {
    font-weight: bold;
    color: #333;
}

.trim-controls {
    margin-top: 10px;
}

.input-group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}

.input-group label {
    color: #333;
}

.input-group input {
    width: 100px;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    text-align: right;
}

.output-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    background: #e8f5e9;
    border-radius: 5px;
    margin-bottom: 10px;
}

.output-info .label {
    color: #666;
}

.output-info .value {
    font-weight: bold;
    color: #2e7d32;
}

.output-info .percentage {
    color: #666;
    font-size: 12px;
}

.download-button {
    width: 100%;
    padding: 12px;
    background: #8CCF7E;
    color: #111;
    border: none;
    border-radius: 5px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.2s;
}

.download-button:hover:not(:disabled) {
    background: #70f1ec;
}

.download-button:disabled {
    background: #ccc;
    cursor: not-allowed;
}

.progress-bar {
    margin-top: 10px;
    height: 4px;
    background: #e0e0e0;
    border-radius: 2px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: #8CCF7E;
    transition: width 0.1s;
}

.separator {
    border-top: 1px solid #ddd;
    margin: 15px -20px;
}

.test-button {
    width: 100%;
    padding: 12px;
    background: #5c9eff;
    color: #fff;
    border: none;
    border-radius: 5px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.2s;
    margin-bottom: 10px;
}

.test-button:hover:not(:disabled) {
    background: #3d7fe0;
}

.test-button:disabled {
    background: #ccc;
    cursor: not-allowed;
}

.test-results {
    margin-top: 10px;
}

.test-result {
    padding: 8px 10px;
    margin-bottom: 5px;
    border-radius: 4px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.test-result.success {
    background: #e8f5e9;
    border-left: 3px solid #4caf50;
}

.test-result.error {
    background: #ffebee;
    border-left: 3px solid #f44336;
}

.test-result .method {
    font-weight: bold;
    color: #333;
}

.test-result .message {
    color: #666;
    word-break: break-word;
}

.test-result.info {
    background: #e3f2fd;
    border-left: 3px solid #2196f3;
}

.ffmpeg-log {
    max-height: 300px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 11px;
}

.ffmpeg-log .test-result {
    padding: 4px 8px;
    margin-bottom: 2px;
}

/* SER Analyzer styles */
.analyzer-controls {
    margin: 15px 0;
}

.control-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.control-row label {
    color: #333;
    font-weight: bold;
    min-width: 100px;
}

.control-row input[type="range"] {
    flex: 1;
}

.raw-bytes-preview {
    margin-top: 10px;
}

.raw-bytes-preview label {
    display: block;
    color: #333;
    font-weight: bold;
    margin-bottom: 5px;
}

.bytes-display {
    font-family: monospace;
    font-size: 11px;
    background: #f0f0f0;
    padding: 8px;
    border-radius: 4px;
    word-break: break-all;
    color: #333;
}

.toggle-buttons {
    display: flex;
    gap: 5px;
}

.toggle-buttons button {
    padding: 8px 16px;
    border: 2px solid #ccc;
    background: #f5f5f5;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    transition: all 0.2s;
}

.toggle-buttons button:hover {
    border-color: #8CCF7E;
}

.toggle-buttons button.active {
    background: #8CCF7E;
    border-color: #6ab05e;
    color: #111;
}

.bayer-thumbnails h4 {
    margin: 15px 0 10px 0;
    color: #333;
}

.thumbnails-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
}

.thumbnails-grid.hidden {
    display: none;
}

.thumbnail-item {
    text-align: center;
}

.thumbnail-canvas {
    border: 2px solid #ddd;
    border-radius: 4px;
    background: #000;
    max-width: 100%;
}

.thumbnail-label {
    margin-top: 5px;
    font-size: 12px;
    font-weight: bold;
    color: #333;
}

.loading-thumbnails {
    text-align: center;
    padding: 20px;
    color: #666;
}
</style>
