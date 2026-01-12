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
            const worker = existingWorker;
            const shouldTerminate = !existingWorker; // Only terminate if we created it

            if (!worker) {
                addLog('Error: No worker provided for stacking');
                reject(new Error('No worker provided for stacking'));
                return;
            }

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
                    resolve(blob);
                }

                if (type === 'stack-error') {
                    addLog(`Stacking error: ${e.data.error}`);
                    emit('set-caption', 'Stacking failed');
                    worker.removeEventListener('message', messageHandler);
                    reject(new Error(e.data.error));
                }
            };

            worker.addEventListener('message', messageHandler);

            // Prepare frame data for transfer
            const frameData = validFrames.map(f => ({
                rgbaBuffer: f.rgbaBuffer,
                width: f.width,
                height: f.height,
                sharpness: f.sharpness,
                subPixelOffset: f.subPixelOffset || { x: 0, y: 0 }
            }));

            // Collect unique buffers for transfer (avoid duplicates)
            const uniqueBuffers = new Set();
            frameData.forEach(f => {
                if (f.rgbaBuffer instanceof ArrayBuffer) {
                    uniqueBuffers.add(f.rgbaBuffer);
                }
            });
            const transferables = Array.from(uniqueBuffers);

            // Send stacking request - worker is already initialized
            worker.postMessage({
                type: 'stack-frames',
                frames: frameData
            }, transferables);
        });
    }

    return { stackFramesLocally };
}
