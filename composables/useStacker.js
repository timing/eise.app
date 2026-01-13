import { useEventBus } from '@/composables/eventBus';

export function useStacker() {
    const { addLog, emit } = useEventBus();

    /**
     * Stack frames using a web worker for local alignment
     * @param frames - Array of frame objects with rgbaBuffer, width, height, sharpness
     * @param existingWorker - Optional: reuse an existing initialized worker
     */
    async function stackFramesLocally(frames, existingWorker = null) {
        emit('set-caption', 'Preparing for stacking...');
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        // Filter frames that have valid rgbaBuffer and sharpness
        const validFrames = frames.filter(f => f.rgbaBuffer && f.width && f.height && f.sharpness > 0);

        if (validFrames.length === 0) {
            addLog('No valid frames with RGBA data for stacking');
            return null;
        }

        // Emit stacking-started with reference frame (best frame = first after sort)
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);
        const referenceFrame = sortedFrames[0];
        emit('stacking-started', { referenceFrame });

        addLog(`Sending ${validFrames.length} frames to stacking worker`);

        return new Promise((resolve, reject) => {
            // Create a FRESH worker for stacking to avoid WASM heap exhaustion from analysis
            addLog('Creating fresh worker for stacking...');
            const worker = new Worker('/unified_analyze_worker.js');
            const shouldTerminate = true; // Always terminate since we created it

            // Wait for OpenCV to initialize in the new worker
            const initHandler = (e) => {
                if (e.data.type === 'ready') {
                    addLog('Fresh stacking worker ready');
                    worker.removeEventListener('message', initHandler);
                    proceedWithStacking();
                } else if (e.data.type === 'error') {
                    addLog(`Fresh worker init error: ${e.data.message}`);
                    worker.removeEventListener('message', initHandler);
                    reject(new Error('Failed to initialize stacking worker'));
                }
            };
            worker.addEventListener('message', initHandler);
            worker.postMessage({ type: 'init' }); // Trigger OpenCV initialization

            function proceedWithStacking() {

            const messageHandler = (e) => {
                const { type } = e.data;

                if (type === 'stack-progress') {
                    emit('set-caption', e.data.stage);
                    emit('update-loading', {
                        progress: e.data.progress,
                        current: Math.round(e.data.progress),
                        total: 100
                    });
                }

                if (type === 'stack-complete') {
                    const { blob, width, height } = e.data;
                    addLog(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);
                    emit('set-caption', 'Stacking complete');
                    worker.removeEventListener('message', messageHandler);
                    worker.terminate(); // Clean up fresh worker
                    resolve(blob);
                }

                if (type === 'stack-error') {
                    addLog(`Stacking error: ${e.data.error}`);
                    emit('set-caption', 'Stacking failed');
                    worker.removeEventListener('message', messageHandler);
                    worker.terminate(); // Clean up fresh worker
                    reject(new Error(e.data.error));
                }
            };

            worker.addEventListener('message', messageHandler);

            // Prepare frame data for transfer - only include cloneable/transferable properties
            const frameData = [];
            for (let i = 0; i < validFrames.length; i++) {
                const f = validFrames[i];
                // Ensure rgbaBuffer is an ArrayBuffer (not typed array)
                let buffer = f.rgbaBuffer;
                if (buffer && !(buffer instanceof ArrayBuffer)) {
                    // If it's a typed array, get its buffer
                    if (buffer.buffer instanceof ArrayBuffer) {
                        buffer = buffer.buffer;
                    } else {
                        console.warn(`Frame ${i}: rgbaBuffer is not an ArrayBuffer, skipping`);
                        continue;
                    }
                }
                if (!buffer || buffer.byteLength === 0) {
                    console.warn(`Frame ${i}: rgbaBuffer is empty or detached, skipping`);
                    continue;
                }
                frameData.push({
                    rgbaBuffer: buffer,
                    width: f.width,
                    height: f.height,
                    sharpness: f.sharpness,
                    subPixelOffset: { x: f.subPixelOffset?.x || 0, y: f.subPixelOffset?.y || 0 }
                });
            }

            if (frameData.length === 0) {
                addLog('Error: No valid frame buffers for stacking');
                reject(new Error('No valid frame buffers'));
                return;
            }
            addLog(`Prepared ${frameData.length} frames for stacking worker`);

            // Collect unique buffers for transfer (avoid duplicates)
            const uniqueBuffers = new Set();
            frameData.forEach(f => {
                if (f.rgbaBuffer instanceof ArrayBuffer && f.rgbaBuffer.byteLength > 0) {
                    uniqueBuffers.add(f.rgbaBuffer);
                }
            });
            const transferables = Array.from(uniqueBuffers);

            // Emit frame data for AVI export BEFORE transfer (buffers will be detached after)
            // Skip AVI export for large frame counts to save memory
            if (frameData.length <= 500) {
                // Clone buffers so they remain accessible after transfer
                const aviFrameData = frameData.map(f => ({
                    rgbaBuffer: f.rgbaBuffer instanceof ArrayBuffer ? f.rgbaBuffer.slice(0) : null,
                    width: f.width,
                    height: f.height
                })).filter(f => f.rgbaBuffer !== null);
                emit('cropped-avi-ready', {
                    frames: aviFrameData,
                    width: frameData[0].width,
                    height: frameData[0].height,
                    frameCount: aviFrameData.length
                });
                addLog(`AVI export data ready: ${aviFrameData.length} frames`);
            } else {
                addLog(`Skipping AVI export for ${frameData.length} frames (memory optimization)`);
            }

            // Send stacking request - worker is already initialized
            worker.postMessage({
                type: 'stack-frames',
                frames: frameData
            }, transferables);
            } // end proceedWithStacking
        });
    }

    return { stackFramesLocally };
}
