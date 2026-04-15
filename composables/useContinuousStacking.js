import { ref } from 'vue';
import { useStacker } from '@/composables/useStacker';
import { useEventBus } from '@/composables/eventBus';
import { useProcessingState } from '@/composables/useProcessingState';

export function useContinuousStacking() {
    const { stackContinuousLocally, calculateSharpness } = useStacker();
    const { emit, addLog } = useEventBus();
    const { setContinuousResults } = useProcessingState();
    
    const results = ref([]);
    const isProcessing = ref(false);
    const currentPercentage = ref(0);
    let cancelled = false;

    function cancel() {
        cancelled = true;
        isProcessing.value = false;
        addLog('Continuous Stacking: Cancellation requested');
    }

    /**
     * Run sequential stacking from startPct to endPct in steps of stepPct
     */
    async function runContinuousStacking(allFrames, options = {}) {
        const {
            startPct = 5,
            endPct = 90,
            stepPct = 5,
            drizzleScale = 1.5,
            useWebGPU = true,
            frameReReader = null,
            surfaceMode = false
        } = options;

        isProcessing.value = true;
        cancelled = false;
        results.value = [];

        const snapshots = [];
        for (let p = startPct; p <= endPct; p += stepPct) {
            snapshots.push(p);
        }

        addLog(`Continuous Stacking: Starting incremental processing with ${snapshots.length} snapshots`);

        // If no frameReReader but frames have uint8Buffer (pre-loaded in memory),
        // create an in-memory wrapper. Frames are already cropped RGBA, so
        // srcWidth/srcHeight = frame size and crop is a no-op.
        let effectiveReReader = frameReReader;
        if (!effectiveReReader && allFrames.length > 0 && (allFrames[0].uint8Buffer || allFrames[0].float32Buffer)) {
            const frameMap = new Map();
            for (const f of allFrames) {
                frameMap.set(f.index, f);
            }
            const w = allFrames[0].width;
            const h = allFrames[0].height;
            effectiveReReader = {
                fileType: 'image',
                srcWidth: w,
                srcHeight: h,
                cropRegion: null,
                async getFrame(frameObj) {
                    const idx = frameObj.index ?? frameObj;
                    const frame = frameMap.get(idx);
                    if (!frame) return null;
                    const buffer = frame.uint8Buffer || frame.float32Buffer;
                    if (!buffer) return null;
                    return {
                        data: frame.uint8Buffer ? new Uint8Array(buffer) : new Float32Array(buffer),
                        width: frame.width,
                        height: frame.height,
                        centerX: frame.width / 2,
                        centerY: frame.height / 2
                    };
                }
            };
            addLog('Continuous Stacking: Using in-memory frames (no disk re-read needed)');
        }

        try {
            // We only take the number of frames needed for the largest percentage
            const maxPct = Math.max(...snapshots);
            const totalCount = Math.max(1, Math.ceil(allFrames.length * (maxPct / 100)));
            const framesToProcess = allFrames.slice(0, totalCount);

            await stackContinuousLocally(
                framesToProcess,
                effectiveReReader,
                drizzleScale,
                useWebGPU,
                surfaceMode,
                snapshots,
                async (snapshot) => {
                    if (cancelled) return;

                    addLog(`Continuous Stacking: Snapshot for ${snapshot.percentage}% ready`);
                    currentPercentage.value = snapshot.percentage;

                    // Create item immediately with N/A for sharpness
                    const itemIndex = results.value.length;
                    const item = {
                        percentage: snapshot.percentage,
                        frameCount: snapshot.frameCount,
                        blob: snapshot.blob,
                        float32Data: snapshot.float32Data,
                        width: snapshot.width,
                        height: snapshot.height,
                        tenengrad: null,
                        laplacian: null,
                        combined: null
                    };

                    results.value.push(item);
                    setContinuousResults([...results.value]);

                    // Calculate sharpness asynchronously so UI shows the image immediately
                    const bufferCopy = snapshot.float32Data.slice(0).buffer;
                    addLog(`Continuous Stacking: Calculating sharpness for ${snapshot.percentage}%...`);
                    
                    calculateSharpness(bufferCopy, snapshot.width, snapshot.height)
                        .then(sharpness => {
                            if (cancelled) return;
                            addLog(`Continuous Stacking: Sharpness for ${snapshot.percentage}%: combined=${sharpness.sharpness.toFixed(4)}, tenengrad=${sharpness.tenengrad.toFixed(4)}, laplacian=${sharpness.laplacian.toFixed(4)}`);
                            
                            // Update the item directly using the captured reference
                            item.tenengrad = sharpness.tenengrad;
                            item.laplacian = sharpness.laplacian;
                            item.combined = sharpness.sharpness;
                            
                            // Trigger re-render by updating shared state with a FRESH array copy
                            const newResults = [...results.value];
                            setContinuousResults(newResults);
                        })

                        .catch(err => {
                            addLog(`Continuous Stacking: Sharpness calculation failed for ${snapshot.percentage}%: ${err.message}`);
                        });
                }
            );

        } catch (error) {
            if (!cancelled) {
                addLog(`Continuous Stacking error: ${error.message}`);
                console.error(error);
            }
        }

        isProcessing.value = false;
        addLog(`Continuous Stacking complete. Produced ${results.value.length} stacks.`);
        return results.value;
    }

    return {
        runContinuousStacking,
        cancel,
        results,
        isProcessing,
        currentPercentage
    };
}
