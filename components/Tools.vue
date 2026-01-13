<template>
    <div class="card tools-card">
        <h2>Tools</h2>

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
</style>
