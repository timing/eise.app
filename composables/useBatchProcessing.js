// composables/useBatchProcessing.js
// Central state management for batch processing operations.
// Orchestrates processing of multiple files - delegates to existing readers.

import { ref, computed, readonly } from 'vue';
import { useEventBus } from '@/composables/eventBus';

// Batch file status types
export const BatchStatus = {
    PENDING: 'pending',
    ANALYZING: 'analyzing',
    STACKING: 'stacking',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// Singleton state - shared across all useBatchProcessing() calls
const batchState = ref({
    isActive: false,
    files: [],           // Array of BatchFile objects
    currentIndex: -1,
    settings: {
        stackPercentage: 30,
        drizzleScale: 1.5,
        cropMarginPercent: 10,
        surfaceMode: false,
        manualThreshold: false,
        maxFrames: -1,
        alignResults: false,  // Enable cross-stack alignment for wobble-free animation
        bayerPattern: null    // Captured from first file, reused for rest
    }
});

// Generate unique ID for batch files
let nextFileId = 1;
function generateFileId() {
    return `batch-file-${nextFileId++}`;
}

/**
 * Create a BatchFile object from a File
 */
function createBatchFile(file) {
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();

    return {
        id: generateFileId(),
        file,
        name,
        size: file.size,
        type: ext === 'ser' ? 'ser' : ext === 'avi' ? 'avi' : 'unknown',
        status: BatchStatus.PENDING,
        progress: 0,
        progressMessage: '',
        metadata: null,    // { width, height, frameCount, bayerPattern }
        result: null,      // { blob, float32Data, width, height, centroid, tiltAngle }
        error: null
    };
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function useBatchProcessing() {
    const { addLog, emit } = useEventBus();

    // Cancellation flag
    let cancelRequested = false;

    /**
     * Check if batch mode is currently active
     */
    const isActive = computed(() => batchState.value.isActive);

    /**
     * Get all batch files
     */
    const files = computed(() => batchState.value.files);

    /**
     * Get current file being processed
     */
    const currentFile = computed(() => {
        if (batchState.value.currentIndex < 0) return null;
        return batchState.value.files[batchState.value.currentIndex];
    });

    /**
     * Get completed files with results
     */
    const completedFiles = computed(() =>
        batchState.value.files.filter(f => f.status === BatchStatus.COMPLETED && f.result)
    );

    /**
     * Get overall batch progress (0-100)
     */
    const batchProgress = computed(() => {
        const files = batchState.value.files;
        if (files.length === 0) return 0;

        let totalProgress = 0;
        for (const file of files) {
            if (file.status === BatchStatus.COMPLETED) {
                totalProgress += 100;
            } else if (file.status === BatchStatus.FAILED || file.status === BatchStatus.CANCELLED) {
                totalProgress += 100; // Count as done for progress purposes
            } else {
                totalProgress += file.progress;
            }
        }
        return Math.round(totalProgress / files.length);
    });

    /**
     * Add files to the batch queue
     */
    function addFiles(inputFiles) {
        const newFiles = Array.from(inputFiles).map(createBatchFile);
        batchState.value.files.push(...newFiles);
        batchState.value.isActive = true;

        addLog(`[Batch] Added ${newFiles.length} files to batch queue`);
        emit('batch-files-added', { files: newFiles });

        return newFiles;
    }

    /**
     * Remove a file from the batch queue (only if pending)
     */
    function removeFile(fileId) {
        const index = batchState.value.files.findIndex(f => f.id === fileId);
        if (index === -1) return false;

        const file = batchState.value.files[index];
        if (file.status !== BatchStatus.PENDING) {
            addLog(`[Batch] Cannot remove file ${file.name} - already processing`);
            return false;
        }

        batchState.value.files.splice(index, 1);
        addLog(`[Batch] Removed ${file.name} from batch`);
        return true;
    }

    /**
     * Update batch settings
     */
    function updateSettings(newSettings) {
        batchState.value.settings = {
            ...batchState.value.settings,
            ...newSettings
        };
    }

    /**
     * Update file progress
     */
    function updateFileProgress(fileId, progress, message = '') {
        const file = batchState.value.files.find(f => f.id === fileId);
        if (file) {
            file.progress = progress;
            file.progressMessage = message;
            emit('batch-file-progress', { fileId, progress, message });
        }
    }

    /**
     * Update file status
     */
    function updateFileStatus(fileId, status, error = null) {
        const file = batchState.value.files.find(f => f.id === fileId);
        if (file) {
            file.status = status;
            if (error) file.error = error;
            emit('batch-file-status', { fileId, status, error });
        }
    }

    /**
     * Store file metadata after parsing
     */
    function setFileMetadata(fileId, metadata) {
        const file = batchState.value.files.find(f => f.id === fileId);
        if (file) {
            file.metadata = metadata;
        }
    }

    /**
     * Store file result after stacking
     */
    function setFileResult(fileId, result) {
        const file = batchState.value.files.find(f => f.id === fileId);
        if (file) {
            file.result = result;
            file.status = BatchStatus.COMPLETED;
            file.progress = 100;
            emit('batch-file-completed', { fileId, result });
        }
    }

    /**
     * Process a single file using existing readers
     */
    async function processFile(batchFile) {
        const { settings } = batchState.value;

        updateFileStatus(batchFile.id, BatchStatus.ANALYZING);
        addLog(`[Batch] Processing ${batchFile.name}...`);

        try {
            // Import parser and reader based on file type
            let parser, reader;

            if (batchFile.type === 'ser') {
                const { useSerParser } = await import('@/composables/useSerParser');
                const { useDebayerReader } = await import('@/composables/useDebayerReader');

                parser = useSerParser();
                await parser.init(batchFile.file);

                reader = useDebayerReader();
                await reader.init(batchFile.file, parser);
            } else if (batchFile.type === 'avi') {
                const { useAviParser, is8bitRawFormat } = await import('@/composables/useAviParser');

                parser = useAviParser();
                const metadata = await parser.init(batchFile.file);

                // Check if it's raw Bayer AVI
                if (is8bitRawFormat(metadata.fourCC, metadata.bpp)) {
                    const { useDebayerReader } = await import('@/composables/useDebayerReader');
                    reader = useDebayerReader();
                    await reader.init(batchFile.file, parser);
                } else {
                    // Non-Bayer AVI - would need useAviReader
                    // For now, only support raw Bayer
                    throw new Error(`AVI format '${metadata.fourCC}' not supported in batch mode. Only raw Bayer AVIs are supported.`);
                }
            } else {
                throw new Error(`Unsupported file type: ${batchFile.type}`);
            }

            // Store metadata
            const metadata = parser.getMetadata();
            setFileMetadata(batchFile.id, {
                width: metadata.width,
                height: metadata.height,
                frameCount: metadata.frameCount,
                bayerPattern: metadata.bayerPattern
            });

            updateFileStatus(batchFile.id, BatchStatus.STACKING);

            // Process file - intercept events to capture result
            return new Promise((resolve, reject) => {
                // Set up one-time listeners
                const { on, off } = useEventBus();

                const handleStackedImage = (data) => {
                    off('stacked-image-ready', handleStackedImage);
                    off('stack-failed', handleStackFailed);

                    // Capture bayer pattern from first file for subsequent files
                    if (data.bayerPattern && !batchState.value.settings.bayerPattern) {
                        batchState.value.settings.bayerPattern = data.bayerPattern;
                        addLog(`[Batch] Captured bayer pattern: ${data.bayerPattern}`);
                    }

                    // Store result
                    setFileResult(batchFile.id, {
                        blob: data.blob,
                        float32Data: data.float32Data,
                        width: data.width,
                        height: data.height,
                        centroid: data.centroid || null,
                        tiltAngle: data.tiltAngle || 0
                    });

                    resolve(data);
                };

                const handleStackFailed = (data) => {
                    off('stacked-image-ready', handleStackedImage);
                    off('stack-failed', handleStackFailed);

                    const error = data?.reason || 'Stacking failed';
                    updateFileStatus(batchFile.id, BatchStatus.FAILED, error);
                    reject(new Error(error));
                };

                on('stacked-image-ready', handleStackedImage);
                on('stack-failed', handleStackFailed);

                // Process the file
                // First file shows color selector, subsequent files use the captured pattern
                reader.processFile({
                    maxFrames: settings.maxFrames,
                    manualThreshold: false, // Batch mode uses automatic threshold
                    cropMarginPercent: settings.cropMarginPercent,
                    stackPercentage: settings.stackPercentage,
                    drizzleScale: settings.drizzleScale,
                    surfaceMode: settings.surfaceMode,
                    forceBayerPattern: settings.bayerPattern, // null for first file, set for rest
                }).catch(reject);
            });

        } catch (err) {
            addLog(`[Batch] Error processing ${batchFile.name}: ${err.message}`);
            updateFileStatus(batchFile.id, BatchStatus.FAILED, err.message);
            throw err;
        }
    }

    /**
     * Process the next pending file in the queue
     */
    async function processNextFile() {
        if (cancelRequested) {
            addLog('[Batch] Processing cancelled');
            return null;
        }

        // Find next pending file
        const nextIndex = batchState.value.files.findIndex(f => f.status === BatchStatus.PENDING);
        if (nextIndex === -1) {
            return null; // No more files to process
        }

        batchState.value.currentIndex = nextIndex;
        const file = batchState.value.files[nextIndex];

        try {
            await processFile(file);
            return file;
        } catch (err) {
            // Error already logged in processFile
            return file;
        }
    }

    /**
     * Start batch processing
     */
    async function startBatch(settings = {}) {
        if (batchState.value.files.length === 0) {
            addLog('[Batch] No files to process');
            return;
        }

        cancelRequested = false;
        updateSettings(settings);

        addLog(`[Batch] Starting batch processing of ${batchState.value.files.length} files`);
        emit('batch-started', { fileCount: batchState.value.files.length });
        emit('start-loading', 'Batch processing...');

        // Process files sequentially
        let processedCount = 0;
        let successCount = 0;

        while (true) {
            if (cancelRequested) break;

            const file = await processNextFile();
            if (!file) break; // No more files

            processedCount++;
            if (file.status === BatchStatus.COMPLETED) {
                successCount++;
            }

            // Update overall progress
            emit('update-loading', {
                progress: batchProgress.value,
                current: processedCount,
                total: batchState.value.files.length
            });
        }

        // Batch complete
        batchState.value.currentIndex = -1;
        emit('stop-loading');

        const results = completedFiles.value.map(f => ({
            id: f.id,
            name: f.name,
            result: f.result
        }));

        addLog(`[Batch] Complete: ${successCount}/${processedCount} files stacked successfully`);
        emit('batch-complete', {
            results,
            successCount,
            totalCount: processedCount
        });

        return results;
    }

    /**
     * Cancel batch processing
     */
    function cancelBatch() {
        cancelRequested = true;

        // Mark any in-progress files as cancelled
        for (const file of batchState.value.files) {
            if (file.status === BatchStatus.ANALYZING || file.status === BatchStatus.STACKING) {
                updateFileStatus(file.id, BatchStatus.CANCELLED);
            }
        }

        addLog('[Batch] Batch cancelled');
        emit('batch-cancelled');
    }

    /**
     * Clear all batch state
     */
    function clearBatch() {
        batchState.value = {
            isActive: false,
            files: [],
            currentIndex: -1,
            settings: { ...batchState.value.settings, bayerPattern: null }  // Reset pattern for next batch
        };
        cancelRequested = false;
        nextFileId = 1;

        emit('batch-cleared');
    }

    /**
     * Get batch settings
     */
    function getSettings() {
        return { ...batchState.value.settings };
    }

    return {
        // State (readonly)
        isActive,
        files,
        currentFile,
        completedFiles,
        batchProgress,

        // Actions
        addFiles,
        removeFile,
        updateSettings,
        startBatch,
        cancelBatch,
        clearBatch,
        getSettings,

        // For internal/testing use
        updateFileProgress,
        updateFileStatus,
        setFileMetadata,
        setFileResult
    };
}

export default useBatchProcessing;
