<template>
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
</template>

<script setup>
import { ref, computed } from 'vue';
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
    max-width: 400px;
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
</style>
