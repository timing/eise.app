<template>
    <div class="page-layout">
    <div class="card tools-card">
        <h3>SER Analyzer, Player & Trimmer</h3>

        <div class="tool-section">
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
                    <span class="label">Header bit depth:</span>
                    <span class="value">{{ serHeader.pixelDepth }}-bit</span>
                </div>
                <div class="info-row">
                    <span class="label">Color format:</span>
                    <span class="value">{{ colorFormatLabel }}</span>
                </div>
                <div class="info-row">
                    <span class="label">Frames:</span>
                    <span class="value">{{ serHeader.frameCount }}</span>
                </div>
                <div class="info-row">
                    <span class="label">File size analysis:</span>
                    <span class="value">{{ fileSizeAnalysis }}</span>
                </div>
                <div class="info-row">
                    <span class="label">Pixel value range:</span>
                    <span class="value">{{ pixelValueRange }}</span>
                </div>
                <div class="info-row" v-if="serHeader.observer && !isDefaultObserver">
                    <span class="label">Observer:</span>
                    <span class="value">{{ serHeader.observer }}</span>
                </div>
            </div>

            <!-- Analyzer Section -->
            <template v-if="serHeader">
                <div class="separator"></div>
                <h3>Analyzer</h3>

                <div class="analyzer-controls">
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
                            @input="renderThumbnails"
                        />
                    </div>

                    <div class="raw-bytes-preview">
                        <label>First 32 raw bytes:</label>
                        <div class="bytes-display">{{ rawBytesPreview }}</div>
                    </div>
                </div>

                <div class="bayer-thumbnails" v-if="!isRgbSer">
                    <h4>Bayer Pattern Preview</h4>
                    <div v-if="!thumbnailsReady" class="loading-thumbnails">
                        <p>Rendering previews...</p>
                    </div>
                    <div class="thumbnails-grid" :class="{ hidden: !thumbnailsReady }">
                        <div
                            v-for="profile in bayerProfiles"
                            :key="profile.id"
                            class="thumbnail-item"
                            :class="{ selected: selectedBayerProfile === profile.id }"
                            @click="selectBayerProfile(profile.id)"
                        >
                            <canvas :ref="el => thumbnailCanvases[profile.id] = el" class="thumbnail-canvas"></canvas>
                            <div class="thumbnail-label">{{ profile.label }}</div>
                        </div>
                    </div>
                </div>
                <div v-else class="rgb-info">
                    <p>{{ isBgrSer ? 'BGR' : 'RGB' }} color format — frames are already decoded color, no Bayer demosaicing needed.</p>
                </div>
            </template>

            <!-- Trimmer Section -->
            <template v-if="serHeader">
                <div class="separator"></div>
                <h3>Trimmer</h3>

                <div class="trim-controls">
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

                    <div class="trim-buttons">
                        <button @click="setStartFromCurrent" class="set-frame-button">
                            Set start to current ({{ currentFrame }})
                        </button>
                        <button @click="setEndFromCurrent" class="set-frame-button">
                            Set end to current ({{ currentFrame }})
                        </button>
                    </div>

                    <div class="output-info">
                        <span class="label">Output frames:</span>
                        <span class="value">{{ outputFrameCount }}</span>
                        <span class="percentage">({{ outputPercentage }}%)</span>
                    </div>

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
            </template>
        </div>
    </div>
    <div class="content">
        <h2>SER Tools</h2>
        <p>Analyze SER file bit depth and Bayer pattern, play back frames with the selected color profile, or trim to extract a range of frames.</p>

        <div class="feedback-box">
            <p>Ideas for this page? Something not working?</p>
            <a href="https://github.com/timing/eise.app/issues" target="_blank" class="btn-primary" @click="handleFeedbackClick">
                💬 Send feedback!
            </a>
        </div>

        <!-- Player Section -->
        <template v-if="serHeader">
            <div class="separator"></div>
            <h3>Player</h3>

            <div class="player-section">
                <div class="player-canvas-container">
                    <canvas ref="playerCanvas" class="player-canvas"></canvas>
                </div>

                <div class="player-controls">
                    <div class="frame-slider">
                        <input
                            type="range"
                            v-model.number="currentFrame"
                            :min="1"
                            :max="serHeader.frameCount"
                            @input="renderCurrentFrame"
                        />
                        <span class="frame-number">{{ currentFrame }} / {{ serHeader.frameCount }}</span>
                    </div>

                    <div class="playback-controls">
                        <button @click="previousFrame" :disabled="currentFrame <= 1">
                            &lt;
                        </button>
                        <button @click="togglePlayback" class="play-button">
                            {{ isPlaying ? '⏸' : '▶' }}
                        </button>
                        <button @click="nextFrame" :disabled="currentFrame >= serHeader.frameCount">
                            &gt;
                        </button>
                        <div class="speed-control">
                            <label>FPS:</label>
                            <input
                                type="number"
                                v-model.number="playbackFps"
                                min="1"
                                max="60"
                                class="fps-input"
                            />
                        </div>
                        <button @click="downloadRawFrame" class="download-raw-button">
                            Download Raw Frame
                        </button>
                    </div>
                </div>
            </div>
        </template>
    </div>
    </div>
</template>

<script setup>
import { ref, computed, onUnmounted, onMounted } from 'vue';
import { parseSerHeader, SER_HEADER_SIZE, getChannels, isRgbColor, SER_COLOR_BGR } from '@/composables/useSerParser';
import { useFeedback } from '@/composables/useFeedback';

const { openFeedback } = useFeedback();
const sentryAvailable = ref(false);

function handleFeedbackClick(event) {
    if (sentryAvailable.value) {
        event.preventDefault();
        openFeedback();
    }
    // Otherwise, let the <a href> work normally (opens GitHub)
}

// Shared state
const fileInput = ref(null);
const selectedFile = ref(null);
const serHeader = ref(null);
const firstFrameBuffer = ref(null);
const frameSize = ref(0); // Calculated frame size in bytes

// Analyzer state
const forcedBitDepth = ref(16);
const byteSwap = ref(false);
const byteOffset = ref(0);
const thumbnailCanvases = ref({});
const thumbnailsReady = ref(false);
const pixelValueRange = ref('');
const fileSizeAnalysis = ref('');
const rawBytesPreview = ref('');
const selectedBayerProfile = ref('RGGB');

const bayerProfiles = [
    { id: 'RGGB', label: 'RGGB' },
    { id: 'BGGR', label: 'BGGR' },
    { id: 'GBRG', label: 'GBRG' },
    { id: 'GRBG', label: 'GRBG' },
    { id: 'MONO', label: 'Mono' }
];

// Player state
const playerCanvas = ref(null);
const currentFrame = ref(1);
const isPlaying = ref(false);
const playbackFps = ref(15);
let playbackInterval = null;

// Trimmer state
const startFrame = ref(1);
const endFrame = ref(1);
const isProcessing = ref(false);
const progress = ref(0);

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

const isRgbSer = computed(() => serHeader.value ? isRgbColor(serHeader.value.colorID) : false);
const isBgrSer = computed(() => serHeader.value?.colorID === SER_COLOR_BGR);

const colorFormatLabel = computed(() => {
    if (!serHeader.value) return '';
    const id = serHeader.value.colorID;
    const names = { 0: 'MONO', 8: 'RGGB', 9: 'GRBG', 10: 'GBRG', 11: 'BGGR', 100: 'RGB', 101: 'BGR' };
    return names[id] ?? `Unknown (${id})`;
});

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Stop any playback
    stopPlayback();

    selectedFile.value = file;
    thumbnailsReady.value = false;

    // Read header
    const headerBuf = await file.slice(0, SER_HEADER_SIZE).arrayBuffer();
    const header = parseSerHeader(headerBuf);
    serHeader.value = header;

    // Analyze file size (account for multi-channel RGB/BGR)
    const channels = getChannels(header.colorID);
    const frameSize16 = header.width * header.height * 2 * channels;
    const frameSize8 = header.width * header.height * 1 * channels;
    const dataSize = file.size - SER_HEADER_SIZE;
    const frameCount16 = Math.floor(dataSize / frameSize16);
    const frameCount8 = Math.floor(dataSize / frameSize8);
    fileSizeAnalysis.value = `as 16-bit: ${frameCount16} frames, as 8-bit: ${frameCount8} frames`;

    // Set initial bit depth based on header
    forcedBitDepth.value = header.pixelDepth > 8 ? 16 : 8;

    // Calculate and store frame size (bytes per frame, including all channels)
    const bpp = header.pixelDepth > 8 ? 2 : 1;
    frameSize.value = header.width * header.height * bpp * channels;

    // Read first frame for analyzer (slice, not full file)
    const firstFrameSlice = file.slice(SER_HEADER_SIZE, SER_HEADER_SIZE + frameSize.value);
    firstFrameBuffer.value = await firstFrameSlice.arrayBuffer();

    analyzePixelValues(firstFrameBuffer.value, header.pixelDepth);
    updateRawBytesPreview(firstFrameBuffer.value);
    await renderThumbnails();

    // Set trimmer defaults
    startFrame.value = 1;
    endFrame.value = header.frameCount;
    currentFrame.value = 1;

    // Render first frame in player
    await renderCurrentFrame();
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
    renderThumbnails();
    renderCurrentFrame();
}

function setByteSwap(swap) {
    byteSwap.value = swap;
    renderThumbnails();
    renderCurrentFrame();
}

function selectBayerProfile(profileId) {
    selectedBayerProfile.value = profileId;
    renderCurrentFrame();
}

function updateRawBytesPreview(buffer) {
    const bytes = new Uint8Array(buffer);
    const preview = [];
    for (let i = 0; i < Math.min(32, bytes.length); i++) {
        preview.push(bytes[i].toString(16).padStart(2, '0'));
    }
    rawBytesPreview.value = preview.join(' ');
}

async function renderThumbnails() {
    if (!firstFrameBuffer.value || !serHeader.value) return;

    const header = serHeader.value;
    if (!header.width || !header.height || header.width <= 0 || header.height <= 0) return;

    thumbnailsReady.value = false;

    // Wait for next tick to ensure canvases are mounted
    await new Promise(resolve => setTimeout(resolve, 10));
    const buffer = firstFrameBuffer.value;
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
        const u16 = new Uint16Array(Math.floor(offsetBytes.length / 2));
        for (let i = 0; i < u16.length; i++) {
            if (swap) {
                u16[i] = (offsetBytes[i * 2] << 8) | offsetBytes[i * 2 + 1];
            } else {
                u16[i] = offsetBytes[i * 2] | (offsetBytes[i * 2 + 1] << 8);
            }
        }
        src = u16;
    } else {
        src = offsetBytes;
    }

    const srcScale = useBitDepth === 16 ? 1/256 : 1;
    const actualWidth = useBitDepth === 8 && header.pixelDepth > 8 ? width : width;
    const actualHeight = useBitDepth === 8 && header.pixelDepth > 8 ? height * 2 : height;

    // Calculate thumbnail size
    const maxSize = 120;
    const scale = Math.min(maxSize / actualWidth, maxSize / actualHeight);
    const thumbWidth = Math.floor(actualWidth * scale);
    const thumbHeight = Math.floor(actualHeight * scale);

    // Guard against zero dimensions (can happen with corrupt headers)
    if (thumbWidth < 1 || thumbHeight < 1) return;

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

// Player functions
async function renderCurrentFrame() {
    if (!selectedFile.value || !serHeader.value || !playerCanvas.value) return;

    const header = serHeader.value;
    if (!header.width || !header.height || header.width <= 0 || header.height <= 0) return;

    const bpp = forcedBitDepth.value === 16 ? 2 : 1;
    const channels = getChannels(header.colorID);
    const currentFrameSize = header.width * header.height * bpp * channels;
    const frameOffset = SER_HEADER_SIZE + (currentFrame.value - 1) * currentFrameSize;

    // Read frame data from file slice (not full buffer)
    const frameSlice = selectedFile.value.slice(frameOffset, frameOffset + currentFrameSize);
    const frameBuffer = await frameSlice.arrayBuffer();

    const width = header.width;
    const height = header.height;

    // Set canvas size
    const canvas = playerCanvas.value;
    const maxWidth = 400;
    const scale = Math.min(1, maxWidth / width);
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);

    // Guard against zero dimensions (can happen with corrupt headers)
    if (canvas.width < 1 || canvas.height < 1) return;

    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const data = imageData.data;

    const xRatio = width / canvas.width;
    const yRatio = height / canvas.height;

    if (isRgbSer.value) {
        // RGB / BGR SER: packed 3-channel data, no demosaicing needed
        const rawBytes = new Uint8Array(frameBuffer);
        let src;
        if (forcedBitDepth.value === 16) {
            const u16 = new Uint16Array(Math.floor(rawBytes.length / 2));
            for (let i = 0; i < u16.length; i++) {
                u16[i] = byteSwap.value
                    ? (rawBytes[i * 2] << 8) | rawBytes[i * 2 + 1]
                    : rawBytes[i * 2] | (rawBytes[i * 2 + 1] << 8);
            }
            src = u16;
        } else {
            src = rawBytes;
        }
        const srcScale = forcedBitDepth.value === 16 ? 1 / 256 : 1;
        const bgr = isBgrSer.value;

        // First pass: find min/max luminance for auto-stretch
        let minVal = Infinity, maxVal = 0;
        const tempRgb = new Float32Array(canvas.width * canvas.height * 3);
        for (let ty = 0; ty < canvas.height; ty++) {
            for (let tx = 0; tx < canvas.width; tx++) {
                const sx = Math.floor(tx * xRatio);
                const sy = Math.floor(ty * yRatio);
                const srcBase = (sy * width + sx) * 3;
                const tidx = (ty * canvas.width + tx) * 3;
                const s0 = (srcBase < src.length ? src[srcBase]     : 0) * srcScale;
                const s1 = (srcBase + 1 < src.length ? src[srcBase + 1] : 0) * srcScale;
                const s2 = (srcBase + 2 < src.length ? src[srcBase + 2] : 0) * srcScale;
                tempRgb[tidx]     = bgr ? s2 : s0;  // R
                tempRgb[tidx + 1] = s1;              // G
                tempRgb[tidx + 2] = bgr ? s0 : s2;  // B
                const lum = (tempRgb[tidx] + tempRgb[tidx + 1] + tempRgb[tidx + 2]) / 3;
                if (lum < minVal) minVal = lum;
                if (lum > maxVal) maxVal = lum;
            }
        }
        const range = maxVal - minVal || 1;
        const stretchScale = 255 / range;
        for (let i = 0; i < canvas.width * canvas.height; i++) {
            const tidx = i * 3;
            const didx = i * 4;
            data[didx]     = Math.min(255, Math.max(0, Math.round((tempRgb[tidx]     - minVal) * stretchScale)));
            data[didx + 1] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 1] - minVal) * stretchScale)));
            data[didx + 2] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 2] - minVal) * stretchScale)));
            data[didx + 3] = 255;
        }
    } else {
        // Bayer / MONO: apply byte offset and demosaic
        const rawBytes = new Uint8Array(frameBuffer);
        const offsetBytes = rawBytes.slice(byteOffset.value);

        let src;
        if (forcedBitDepth.value === 16) {
            const u16 = new Uint16Array(Math.floor(offsetBytes.length / 2));
            for (let i = 0; i < u16.length; i++) {
                u16[i] = byteSwap.value
                    ? (offsetBytes[i * 2] << 8) | offsetBytes[i * 2 + 1]
                    : offsetBytes[i * 2] | (offsetBytes[i * 2 + 1] << 8);
            }
            src = u16;
        } else {
            src = offsetBytes;
        }

        const srcScale = forcedBitDepth.value === 16 ? 1/256 : 1;

        // Get Bayer config
        const patternConfigs = {
            'RGGB': { rX: 0, rY: 0, bX: 1, bY: 1 },
            'BGGR': { rX: 1, rY: 1, bX: 0, bY: 0 },
            'GBRG': { rX: 0, rY: 1, bX: 1, bY: 0 },
            'GRBG': { rX: 1, rY: 0, bX: 0, bY: 1 },
            'MONO': { mono: true }
        };
        const config = patternConfigs[selectedBayerProfile.value] || patternConfigs['RGGB'];

        let minVal = 255, maxVal = 0;
        const tempRgb = new Float32Array(canvas.width * canvas.height * 3);

        // First pass: demosaic and find min/max
        for (let ty = 0; ty < canvas.height; ty++) {
            for (let tx = 0; tx < canvas.width; tx++) {
                const sx = Math.floor(tx * xRatio);
                const sy = Math.floor(ty * yRatio);
                const tidx = (ty * canvas.width + tx) * 3;

                if (config.mono) {
                    const idx = sy * width + sx;
                    const v = (idx < src.length ? src[idx] : 0) * srcScale;
                    tempRgb[tidx] = tempRgb[tidx + 1] = tempRgb[tidx + 2] = v;
                } else {
                    const bx = sx & ~1;
                    const by = sy & ~1;
                    const getVal = (x, y) => {
                        const idx = Math.min(y, height-1) * width + Math.min(x, width-1);
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

        for (let i = 0; i < canvas.width * canvas.height; i++) {
            const tidx = i * 3;
            const didx = i * 4;
            data[didx] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx] - minVal) * stretchScale)));
            data[didx + 1] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 1] - minVal) * stretchScale)));
            data[didx + 2] = Math.min(255, Math.max(0, Math.round((tempRgb[tidx + 2] - minVal) * stretchScale)));
            data[didx + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function previousFrame() {
    if (currentFrame.value > 1) {
        currentFrame.value--;
        renderCurrentFrame();
    }
}

function nextFrame() {
    if (serHeader.value && currentFrame.value < serHeader.value.frameCount) {
        currentFrame.value++;
        renderCurrentFrame();
    }
}

async function downloadRawFrame() {
    if (!selectedFile.value || !serHeader.value) return;

    const header = serHeader.value;
    const bpp = forcedBitDepth.value === 16 ? 2 : 1;
    const channels = getChannels(header.colorID);
    const currentFrameSize = header.width * header.height * bpp * channels;
    const frameOffset = SER_HEADER_SIZE + (currentFrame.value - 1) * currentFrameSize;

    // Read raw frame data from file
    const frameSlice = selectedFile.value.slice(frameOffset, frameOffset + currentFrameSize);
    const frameBuffer = await frameSlice.arrayBuffer();

    // Create blob and download
    const blob = new Blob([frameBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Generate filename with frame number and bit depth
    const originalName = selectedFile.value.name.replace(/\.ser$/i, '');
    a.download = `${originalName}_frame${currentFrame.value}_${forcedBitDepth.value}bit_${header.width}x${header.height}.raw`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function togglePlayback() {
    if (isPlaying.value) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    isPlaying.value = true;
    const interval = 1000 / playbackFps.value;
    playbackInterval = setInterval(() => {
        if (serHeader.value && currentFrame.value < serHeader.value.frameCount) {
            currentFrame.value++;
            renderCurrentFrame();
        } else {
            // Loop back to start
            currentFrame.value = 1;
            renderCurrentFrame();
        }
    }, interval);
}

function stopPlayback() {
    isPlaying.value = false;
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
}

// Trimmer functions
function setStartFromCurrent() {
    startFrame.value = currentFrame.value;
}

function setEndFromCurrent() {
    endFrame.value = currentFrame.value;
}

async function trimAndDownload() {
    if (!selectedFile.value || !serHeader.value) return;

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
    const file = selectedFile.value;
    const bytesPerPixel = (header.pixelDepth > 8 ? 2 : 1) * getChannels(header.colorID);
    const singleFrameSize = header.width * header.height * bytesPerPixel;

    // Calculate frame indices (0-based internally)
    const startIdx = startFrame.value - 1;
    const endIdx = endFrame.value - 1;
    const newFrameCount = endIdx - startIdx + 1;

    // Read and modify header
    const originalHeader = await file.slice(0, SER_HEADER_SIZE).arrayBuffer();
    const newHeader = new ArrayBuffer(SER_HEADER_SIZE);
    new Uint8Array(newHeader).set(new Uint8Array(originalHeader));
    const headerView = new DataView(newHeader);
    headerView.setInt32(38, newFrameCount, true);

    // Calculate source range and read all needed frames at once
    const sourceStart = SER_HEADER_SIZE + startIdx * singleFrameSize;
    const sourceEnd = SER_HEADER_SIZE + (endIdx + 1) * singleFrameSize;

    progress.value = 10; // Show some progress while reading
    const framesSlice = file.slice(sourceStart, sourceEnd);
    const framesData = await framesSlice.arrayBuffer();
    progress.value = 90;

    // Combine header and frames
    const result = new Blob([newHeader, framesData], { type: 'application/octet-stream' });
    progress.value = 100;

    return result;
}

onMounted(() => {
    // Check Sentry feedback availability
    import('@sentry/vue').then((Sentry) => {
        sentryAvailable.value = !!(Sentry.getFeedback && Sentry.getFeedback());
    }).catch(() => {
        sentryAvailable.value = false;
    });
});

onUnmounted(() => {
    stopPlayback();
});
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
    margin-bottom: 10px;
    font-size: 14px;
    color: #333;
}

.tool-description {
    margin: 0 0 15px 0;
    color: #666;
    font-size: 12px;
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

.trim-buttons {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
}

.set-frame-button {
    flex: 1;
    padding: 8px;
    background: #f5f5f5;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}

.set-frame-button:hover {
    background: #e8f5e9;
    border-color: #8CCF7E;
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

/* Analyzer styles */
.analyzer-controls {
    margin: 10px 0;
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
    cursor: pointer;
    padding: 5px;
    border-radius: 4px;
    transition: all 0.2s;
}

.thumbnail-item:hover {
    background: #f0f0f0;
}

.thumbnail-item.selected {
    background: #e8f5e9;
    outline: 2px solid #8CCF7E;
}

.thumbnail-canvas {
    border: 2px solid #ddd;
    border-radius: 4px;
    background: #000;
    max-width: 100%;
}

.thumbnail-item.selected .thumbnail-canvas {
    border-color: #8CCF7E;
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

.rgb-info {
    margin: 10px 0;
    padding: 10px 12px;
    background: #e8f5e9;
    border-radius: 5px;
    font-size: 12px;
    color: #2e7d32;
}

.rgb-info p {
    margin: 0;
}

/* Player styles */
.player-section {
    margin-top: 10px;
}

.player-canvas-container {
    background: #000;
    border-radius: 4px;
    padding: 10px;
    display: flex;
    justify-content: center;
    margin-bottom: 10px;
}

.player-canvas {
    max-width: 100%;
    border-radius: 2px;
}

.player-controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.frame-slider {
    display: flex;
    align-items: center;
    gap: 10px;
}

.frame-slider input[type="range"] {
    flex: 1;
}

.frame-number {
    min-width: 80px;
    text-align: right;
    font-size: 12px;
    color: #666;
}

.playback-controls {
    display: flex;
    align-items: center;
    gap: 10px;
}

.playback-controls button {
    padding: 8px 16px;
    border: 1px solid #ccc;
    background: #f5f5f5;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
}

.playback-controls button:hover:not(:disabled) {
    background: #e8f5e9;
    border-color: #8CCF7E;
}

.playback-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.play-button {
    min-width: 50px;
}

.speed-control {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
}

.speed-control label {
    font-size: 12px;
    color: #666;
}

.fps-input {
    width: 50px;
    padding: 4px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    text-align: center;
}

.download-raw-button {
    margin-left: auto;
    padding: 8px 12px;
    background: #e3f2fd;
    border: 1px solid #90caf9;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: bold;
    color: #1565c0;
}

.download-raw-button:hover {
    background: #bbdefb;
    border-color: #64b5f6;
}

/* Feedback box */
.feedback-box {
    margin-top: 30px;
    text-align: center;
}

.feedback-box p {
    margin: 0 0 15px 0;
}

</style>
