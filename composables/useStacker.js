import { useEventBus } from '@/composables/eventBus';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useLiteMode } from '@/composables/useLiteMode';
import { useProcessingState } from '@/composables/useProcessingState';
import { reportError } from '@/composables/useSentryReporting';

// Uncaptured stacking-GPU errors, capped per PAGE SESSION. The worker already
// caps at 3 per device, but a device is built per stack run, so a user retrying
// the same bad file sent that burst again each time (EISE-RQ: 22 events from a
// handful of sessions on the first day of a billing cycle). The first errors
// carry the root cause; the rest are echoes, and the full sequence still rides
// along in session_logs.
const MAX_STACK_GPU_ERROR_REPORTS = 3;
let stackGpuErrorReports = 0;

// Custom error for WebGPU unavailability - callers can catch this to show user choice
export class WebGPUUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebGPUUnavailableError';
    }
}

/**
 * Total sharpness for weighting, plus a usable flag.
 *
 * Frames are accumulated with weight `sharpness / totalSharpness * frameCount`.
 * That expression has two ways to produce NaN, and the GPU propagates NaN
 * silently: `accumW[idx] += NaN` poisons the accumulator, every later
 * comparison against it is false, and the stack finalises to a fully black
 * image with no error anywhere.
 *
 *   - totalSharpness === 0  -> 0 / 0.  Happens when every frame scores zero,
 *     which a very dim linear RAW can do.
 *   - any sharpness missing -> the reduce itself becomes NaN, poisoning the
 *     weights of every frame including the good ones.
 *
 * Neither is a reason to produce a black image: a frame set with no usable
 * sharpness spread should stack as a plain unweighted average, which is what
 * `usable: false` tells callers to do.
 */
function sumSharpness(frames) {
    let total = 0;
    let bad = 0;
    for (const f of frames) {
        const s = Number(f?.sharpness);
        if (Number.isFinite(s) && s > 0) total += s;
        else bad++;   // counted, but treated as 0 rather than poisoning the sum
    }
    return { total, bad, usable: total > 0 };
}

/**
 * Per-frame accumulation weight. Guaranteed finite.
 *
 * Identical to the old `sharpness / total * frameCount` in every case that
 * previously produced a number: an unscored frame still gets weight 0 and
 * contributes nothing. Only the two NaN cases behave differently, and there
 * the fallback is an unweighted average instead of a black image.
 */
function frameWeight(sharpness, sharpnessTotal, frameCount) {
    if (!sharpnessTotal.usable) return 1;   // no usable spread at all: equal weights
    const s = Number(sharpness);
    if (!Number.isFinite(s) || s <= 0) return 0;
    return (s / sharpnessTotal.total) * frameCount;
}

export function useStacker() {
    const { addLog, emit, on, off } = useEventBus();

    // Relay for messages the stacking worker pushes on its own initiative (NCC
    // telemetry, uncaptured GPU errors). addEventListener (not onmessage) on
    // purpose: the await-per-step helpers reassign worker.onmessage constantly,
    // and an unsolicited message landing mid-step would otherwise hit whichever
    // handler happened to be installed and get read as an unexpected reply.
    function attachStackWorkerRelay(worker) {
        worker.addEventListener('message', (e) => {
            if (e.data?.type === 'ncc-telemetry') {
                emit('stack-step', `stack_ncc_${e.data.kind}`, e.data.props);
                return;
            }
            if (e.data?.type === 'warp-shifts') {
                // Raw Bayer path: the shifts never reach the main thread, so the
                // worker hands them over purely for the warp histogram.
                accumulateWarpTriples(e.data.shifts);
                return;
            }
            if (e.data?.type === 'gpu-uncaptured-error') {
                // Visible in the log tail that rides along with stack_failed, and
                // counted so a validation failure is diagnosable without having
                // to reproduce it.
                addLog(`WebGPU validation error: ${e.data.message}`);
                if (stackGpuErrorReports >= MAX_STACK_GPU_ERROR_REPORTS) return;
                stackGpuErrorReports++;
                reportError(new Error(`Stacking GPU uncaptured error: ${e.data.message}`), {
                    component: 'useStacker',
                    action: 'stackingDevice',
                });
            }
        });
    }
    const { captureUnstackedImage, capturePostCropFrame, capturePreCropFrame } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();
    const { getMinApQuality, getApPatchSize, getPixfrac, getApSpacingScale, getApSliceLimit, getShowApChecker, getApPatchOverride, setApPatchOverride } = useProcessingState();

    // Track active workers for cancellation
    let cancelled = false;
    const activeWorkers = new Set();

    // Cancel processing and terminate all workers.
    // Only log when there is actually something to cancel — during video Pass 1/2
    // the mediabunny reader owns the pipeline and this cancel-processing handler
    // fires with an empty worker set, which used to spam misleading "(0 active)"
    // lines on every user click.
    function cancelProcessing() {
        cancelled = true;
        if (activeWorkers.size > 0) {
            addLog(`Cancelling ${activeWorkers.size} stacker workers...`);
            for (const worker of activeWorkers) {
                try { worker.terminate(); } catch (e) { /* ignore */ }
            }
            activeWorkers.clear();
            addLog('Stacker workers terminated');
        }
    }

    // Listen for cancel event from UI
    on('cancel-processing', cancelProcessing);

    // Helper to track workers
    function trackWorker(worker) {
        activeWorkers.add(worker);
        return worker;
    }

    function untrackWorker(worker) {
        activeWorkers.delete(worker);
    }

    // Timing stats collector for performance analysis
    let stackingStats = null;
    function resetStackingStats() {
        stackingStats = {
            frameLoadMs: [],      // Time to read frames from disk
            gpuDemosaicMs: [],    // Time for GPU demosaic+crop
            grayscaleMs: [],      // Time for grayscale conversion
            templateMatchMs: [],  // Time for GPU template matching
            accumulateMs: [],     // Time for GPU accumulation
            totalFrames: 0,
            startTime: performance.now(),
            analysisStartTime: null // Set separately for total pipeline time
        };
    }
    function logStackingStats() {
        if (!stackingStats) return;
        const elapsed = performance.now() - stackingStats.startTime;
        const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '0';
        const sum = arr => arr.reduce((a, b) => a + b, 0);
        const pct = (ms) => elapsed > 0 ? ((ms / elapsed) * 100).toFixed(0) : '0';

        const loadTotal = sum(stackingStats.frameLoadMs);
        const demosaicTotal = sum(stackingStats.gpuDemosaicMs);
        const grayTotal = sum(stackingStats.grayscaleMs);
        const matchTotal = sum(stackingStats.templateMatchMs);
        const accumTotal = sum(stackingStats.accumulateMs);

        addLog(`─── Stacking Performance Summary ───`);
        addLog(`Stacking time: ${(elapsed / 1000).toFixed(1)}s for ${stackingStats.totalFrames} frames`);
        addLog(`Frame loading (disk): ${avg(stackingStats.frameLoadMs)}ms avg, ${(loadTotal / 1000).toFixed(1)}s total (${pct(loadTotal)}%)`);
        addLog(`GPU demosaic+crop: ${avg(stackingStats.gpuDemosaicMs)}ms avg, ${(demosaicTotal / 1000).toFixed(1)}s total (${pct(demosaicTotal)}%)`);
        addLog(`Grayscale: ${avg(stackingStats.grayscaleMs)}ms avg, ${(grayTotal / 1000).toFixed(1)}s total (${pct(grayTotal)}%)`);
        addLog(`Template match: ${avg(stackingStats.templateMatchMs)}ms avg, ${(matchTotal / 1000).toFixed(1)}s total (${pct(matchTotal)}%)`);
        addLog(`Accumulate: ${avg(stackingStats.accumulateMs)}ms avg, ${(accumTotal / 1000).toFixed(1)}s total (${pct(accumTotal)}%)`);

        // Total pipeline time (analysis + stacking)
        if (stackingStats.analysisStartTime) {
            const totalPipeline = performance.now() - stackingStats.analysisStartTime;
            addLog(`─── Total pipeline: ${(totalPipeline / 1000).toFixed(1)}s ───`);
        } else {
            addLog(`────────────────────────────────────`);
        }
    }

    // ── Local warp statistics ───────────────────────────────────────────────
    // Inspired by PlanetarySystemStacker's "Frequency distribution of local warp
    // sizes at alignment points", but it reports what *this* stacker did, which
    // is not the same thing. Template matching returns a local displacement and
    // an NCC score for every (frame, AP) pair, and the warp shader then either:
    //   - drops the AP, when the score is below minApQuality. It contributes no
    //     displacement at all and neighbouring APs interpolate over the gap.
    //   - applies the displacement, weighted by gaussWeight * quality.
    // The histogram covers the applied ones only, because those are the warp the
    // stack actually received. PSS instead excludes shifts whose NCC peak sat on
    // the search-window border (it zeroes them, so for PSS they really are
    // absent); our shader has no notion of the search radius and applies them at
    // full weight, so excluding them here would hide real displacement. They are
    // counted and drawn separately instead: the value is a cap, not a
    // measurement, so a bin made mostly of capped shifts says "at least this
    // far" rather than "this far".
    //
    // Reading it: a healthy stack is a hump a few pixels wide, little capping,
    // few drops. A hump pressed against the search radius, or a lot of capping,
    // means the search window is too small or per-frame centering is drifting. A
    // high drop rate means the APs never found their templates, so the warp field
    // is mostly interpolation between whatever few APs did lock on.
    //
    // Alongside the histogram we measure how *smooth* the applied field is.
    // createAPGrid lays APs on a regular lattice at patchSize/2 spacing, so
    // neighbouring APs overlap by half their pixels and cannot legitimately
    // disagree by much: real atmospheric warp is spatially smooth. Comparing
    // each AP's displacement against its lattice neighbours therefore separates
    // the two ways a large mean warp can arise. A smooth field means the APs
    // really are tracking something that moved. A field as rough as its own
    // magnitude means the NCC argmax is wandering and the "displacements" are
    // noise, which no amount of search window will fix.
    // Nearest neighbours per AP, as flat typed arrays so a dense grid does not
    // allocate one JS array per point.
    //
    // Found by proximity through a spatial hash, not by walking a lattice:
    // rows are staggered and points near the subject edge get nudged off the
    // grid entirely, so there is no lattice left to walk. Bucketing by spacing
    // and checking the 3x3 neighbourhood keeps this linear in AP count.
    const MAX_APS_FOR_COHERENCE = 20000;
    const AP_NEIGHBOUR_RADIUS = 1.3;   // x spacing; catches the 6 neighbours of a staggered grid
    const AP_MAX_NEIGHBOURS = 6;
    function buildApNeighbours(alignmentPoints, spacing) {
        if (!alignmentPoints || alignmentPoints.length < 2) return null;
        if (alignmentPoints.length > MAX_APS_FOR_COHERENCE) return null;
        if (!spacing || spacing <= 0) return null;

        const n = alignmentPoints.length;
        const cell = spacing;
        const buckets = new Map();
        const key = (cx, cy) => cx * 100000 + cy;
        for (let i = 0; i < n; i++) {
            const k = key(Math.floor(alignmentPoints[i].x / cell), Math.floor(alignmentPoints[i].y / cell));
            let list = buckets.get(k);
            if (!list) buckets.set(k, (list = []));
            list.push(i);
        }

        const maxDist2 = (spacing * AP_NEIGHBOUR_RADIUS) ** 2;
        const offsets = new Int32Array(n + 1);
        const indices = new Int32Array(n * AP_MAX_NEIGHBOURS);
        let w = 0;
        const candidates = [];
        for (let i = 0; i < n; i++) {
            offsets[i] = w;
            const ap = alignmentPoints[i];
            const cx = Math.floor(ap.x / cell);
            const cy = Math.floor(ap.y / cell);
            candidates.length = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const list = buckets.get(key(cx + dx, cy + dy));
                    if (!list) continue;
                    for (const j of list) {
                        if (j === i) continue;
                        const ddx = alignmentPoints[j].x - ap.x;
                        const ddy = alignmentPoints[j].y - ap.y;
                        const d2 = ddx * ddx + ddy * ddy;
                        if (d2 <= maxDist2) candidates.push([d2, j]);
                    }
                }
            }
            // Closest first, so a dense pocket cannot crowd out true neighbours.
            candidates.sort((a, b) => a[0] - b[0]);
            const take = Math.min(candidates.length, AP_MAX_NEIGHBOURS);
            for (let c = 0; c < take; c++) indices[w++] = candidates[c][1];
        }
        offsets[n] = w;
        return { offsets, indices };
    }

    // One frame's applied displacements vs their lattice neighbours. `ok` marks
    // the APs the shader actually used; dropped ones contribute nothing and are
    // skipped on both sides of the comparison.
    function addFrameCoherence(dxArr, dyArr, ok) {
        const nb = warpStats.neighbours;
        if (!nb) return;
        const { offsets, indices } = nb;
        const n = Math.min(dxArr.length, offsets.length - 1);
        for (let i = 0; i < n; i++) {
            if (!ok[i]) continue;
            let sumDx = 0, sumDy = 0, count = 0;
            for (let k = offsets[i]; k < offsets[i + 1]; k++) {
                const j = indices[k];
                if (!ok[j]) continue;
                sumDx += dxArr[j];
                sumDy += dyArr[j];
                count++;
            }
            if (!count) continue;
            const rx = dxArr[i] - sumDx / count;
            const ry = dyArr[i] - sumDy / count;
            warpStats.residualSum += Math.sqrt(rx * rx + ry * ry);
            warpStats.residualCount++;
        }
    }

    let warpStats = null;
    // How much of its area an AP shares with a lattice neighbour. Grid spacing
    // is NOT patchSize/2 except on large frames (see createAPGrid), so this has
    // to be derived, not assumed: the disagreement figure is only comparable
    // between runs at the same overlap. More overlap means neighbours are more
    // correlated by construction and the number flatters itself.
    function apGeometry(alignmentPoints, patchSize, spacing) {
        if (!alignmentPoints?.length) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const ap of alignmentPoints) {
            if (ap.x < minX) minX = ap.x;
            if (ap.x > maxX) maxX = ap.x;
            if (ap.y < minY) minY = ap.y;
            if (ap.y > maxY) maxY = ap.y;
        }
        return {
            patchSize,
            spacing: spacing || null,
            spanX: Math.round(maxX - minX),
            spanY: Math.round(maxY - minY),
            overlapPct: (patchSize && spacing > 0)
                ? Math.max(0, ((patchSize - spacing) / patchSize) * 100)
                : null,
        };
    }

    function resetWarpStats(searchRadius, alignmentPoints = null, patchSize = 0, spacing = 0) {
        warpStats = {
            searchRadius,
            geom: apGeometry(alignmentPoints, patchSize, spacing),
            neighbours: buildApNeighbours(alignmentPoints, spacing),
            numAPs: alignmentPoints ? alignmentPoints.length : 0,
            residualSum: 0,
            residualCount: 0,
            // Shifts are bounded by the radius in each axis, so the longest
            // possible vector is radius*sqrt(2).
            histogram: new Uint32Array(Math.ceil(Math.SQRT2 * searchRadius) + 1),
            cappedHistogram: new Uint32Array(Math.ceil(Math.SQRT2 * searchRadius) + 1),
            total: 0,
            applied: 0,
            dropped: 0,
            capped: 0,
            sumLength: 0,
            sumQuality: 0,
            // Signed means: isotropic wander averages to ~0, a residual global
            // offset does not.
            sumDx: 0,
            sumDy: 0,
        };
    }

    function addWarpSample(dx, dy, quality, minQuality) {
        warpStats.total++;
        warpStats.sumQuality += quality;

        // Below the threshold the shader skips this AP entirely, so no
        // displacement reaches the stack and there is nothing to bin.
        if (quality < minQuality) {
            warpStats.dropped++;
            return;
        }

        warpStats.applied++;
        warpStats.sumDx += dx;
        warpStats.sumDy += dy;
        const length = Math.sqrt(dx * dx + dy * dy);
        warpStats.sumLength += length;
        const bin = Math.min(Math.round(length), warpStats.histogram.length - 1);
        warpStats.histogram[bin]++;

        const r = warpStats.searchRadius;
        if (Math.abs(dx) >= r || Math.abs(dy) >= r) {
            warpStats.capped++;
            warpStats.cappedHistogram[bin]++;
        }
    }

    // allShifts[frameIdx][apIdx] = {dx, dy, quality}, as returned by the
    // template matcher on the main thread. Those shifts have the global drift
    // offset folded in; strip it so the histogram shows local warp, not mount
    // drift.
    function accumulateWarpShifts(allShifts, searchOffset = null) {
        if (!warpStats || !allShifts) return;
        const offX = searchOffset ? Math.round(searchOffset.dx) : 0;
        const offY = searchOffset ? Math.round(searchOffset.dy) : 0;
        const minQuality = getMinApQuality();
        const scratch = warpScratch(allShifts[0]?.length || 0);
        for (const frameShifts of allShifts) {
            if (!frameShifts) continue;
            for (let i = 0; i < frameShifts.length; i++) {
                const s = frameShifts[i];
                const dx = s.dx - offX;
                const dy = s.dy - offY;
                addWarpSample(dx, dy, s.quality, minQuality);
                if (scratch && i < scratch.dx.length) {
                    scratch.dx[i] = dx;
                    scratch.dy[i] = dy;
                    scratch.ok[i] = s.quality >= minQuality ? 1 : 0;
                }
            }
            if (scratch) addFrameCoherence(scratch.dx, scratch.dy, scratch.ok);
        }
    }

    // Reused per-frame buffers for the coherence pass, so a long sequence does
    // not allocate three arrays per frame.
    let warpScratchBuf = null;
    function warpScratch(size) {
        if (!warpStats?.neighbours || !size) return null;
        if (!warpScratchBuf || warpScratchBuf.dx.length < size) {
            warpScratchBuf = {
                dx: new Float32Array(size),
                dy: new Float32Array(size),
                ok: new Uint8Array(size),
            };
        }
        return warpScratchBuf;
    }

    // Packed (dx, dy, score) triples straight off the GPU shifts buffer, as the
    // fully-GPU raw Bayer path relays them. These are already local: the search
    // window itself carries the drift offset, so nothing to subtract.
    function accumulateWarpTriples(triples) {
        if (!warpStats || !triples) return;
        const minQuality = getMinApQuality();
        const numAPs = warpStats.numAPs;
        const scratch = warpScratch(numAPs);
        const frames = numAPs ? Math.floor(triples.length / (numAPs * 3)) : 0;
        for (let i = 0; i + 2 < triples.length; i += 3) {
            addWarpSample(triples[i], triples[i + 1], triples[i + 2], minQuality);
        }
        if (!scratch || !frames) return;
        for (let f = 0; f < frames; f++) {
            const base = f * numAPs * 3;
            for (let a = 0; a < numAPs; a++) {
                const t = base + a * 3;
                scratch.dx[a] = triples[t];
                scratch.dy[a] = triples[t + 1];
                scratch.ok[a] = triples[t + 2] >= minQuality ? 1 : 0;
            }
            addFrameCoherence(scratch.dx, scratch.dy, scratch.ok);
        }
    }

    function logWarpStats() {
        if (!warpStats || !warpStats.total) return;
        const { histogram, cappedHistogram, total, applied, dropped, capped, searchRadius } = warpStats;
        const pct = (n, of) => ((n / of) * 100).toFixed(1);

        // Compact on purpose: every number the long-form version carried, but
        // terse enough to paste. Legends live here, not on every line.
        //   disagree: 0% = neighbours move together, ~110% = independent noise.
        //             Only comparable between runs at the SAME overlap.
        //   capped:   NCC peak on the window border, so the value is a cap.
        //   weakGrad: RMS gradient in the patch's worst direction, grey/px.
        const numAPs = warpStats.numAPs || 0;
        const frames = numAPs ? Math.round(total / numAPs) : 0;
        const g = warpStats.geom;
        const grid = g
            ? `patch ${g.patchSize}px, spacing ${g.spacing}px (staggered), overlap ${g.overlapPct != null ? g.overlapPct.toFixed(0) : '?'}%, span ${g.spanX}x${g.spanY}px`
            : 'grid ?';

        addLog(`─── Warp @ APs ───`);
        const kept = apGridTotal
            ? `${numAPs}/${apGridTotal}ap kept (${((numAPs / apGridTotal) * 100).toFixed(0)}%)`
            : `${numAPs}ap`;
        addLog(`${total.toLocaleString()} meas (${frames}f x ${kept}), ${grid}, radius ${searchRadius}px`);
        addLog(`NCC ${(warpStats.sumQuality / total).toFixed(2)}, dropped<${getMinApQuality()} ${pct(dropped, total)}%`);
        addLog(apLocalizabilitySummary());
        if (!applied) {
            addLog(`no displacement applied - alignment did not lock on`);
            return;
        }
        const meanWarp = warpStats.sumLength / applied;
        addLog(`applied ${applied.toLocaleString()}, mean ${meanWarp.toFixed(2)}px, vector (${(warpStats.sumDx / applied).toFixed(2)}, ${(warpStats.sumDy / applied).toFixed(2)}), capped ${pct(capped, applied)}%`);
        if (warpStats.residualCount) {
            const meanResidual = warpStats.residualSum / warpStats.residualCount;
            addLog(`disagree ${meanResidual.toFixed(2)}px = ${pct(meanResidual, meanWarp)}% (0 smooth / 110 noise)`);
        }

        let lastBin = histogram.length - 1;
        while (lastBin > 0 && histogram[lastBin] === 0) lastBin--;
        const peak = Math.max(...histogram);
        for (let bin = 0; bin <= lastBin; bin++) {
            // Measured portion solid, capped portion shaded, so a bin that is
            // mostly cap reads as "at least this far" at a glance.
            const width = Math.round((histogram[bin] / peak) * 40);
            const cappedWidth = Math.round((cappedHistogram[bin] / peak) * 40);
            const bar = '█'.repeat(Math.max(0, width - cappedWidth)) + '▒'.repeat(cappedWidth);
            const suffix = cappedHistogram[bin] ? ` (${histogram[bin].toLocaleString()}, ${cappedHistogram[bin].toLocaleString()} capped)` : ` (${histogram[bin].toLocaleString()})`;
            addLog(`${String(bin).padStart(2)}px |${bar.padEnd(40)} ${pct(histogram[bin], applied)}%${suffix}`);
        }
        addLog(`────────────────────────────────────`);
    }

    /**
     * Convert Float32 buffer to Uint8 buffer (for display/export)
     */
    function float32ToUint8(float32Buffer, width, height) {
        const float32Data = new Float32Array(float32Buffer);
        const uint8Data = new Uint8Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            uint8Data[i] = Math.round(float32Data[i] * 255);
        }
        return uint8Data.buffer;
    }

    /**
     * Create a PNG blob from float32Buffer for preview display
     */
    async function float32ToBlob(float32Buffer, width, height) {
        const float32Data = new Float32Array(float32Buffer);
        const uint8Data = new Uint8ClampedArray(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            uint8Data[i] = Math.round(float32Data[i] * 255);
        }
        const imageData = new ImageData(uint8Data, width, height);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
    }

    /**
     * Create a PNG blob from uint8Buffer for preview display
     */
    async function uint8ToBlob(uint8Buffer, width, height) {
        const uint8Data = new Uint8ClampedArray(uint8Buffer);
        const imageData = new ImageData(uint8Data, width, height);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
    }

    /**
     * Convert RGBA buffer to grayscale for alignment (supports both Float32 and Uint8 input)
     * Returns Uint8Array (8-bit grayscale) because:
     * - NCC alignment normalizes by mean/variance, so relative patterns matter, not precision
     * - 256 intensity levels capture planetary features well (high contrast against dark sky)
     * - 20x20 patches provide statistical robustness for reliable template matching
     * - Industry standard: AutoStakkert, PIPP, Registax all use 8-bit for alignment
     * The GPU template matcher packs this u8 data (4 pixels per u32) for 4x memory savings
     */
    function rgbaToGrayscale(buffer, width, height, isFloat32 = false) {
        const gray = new Uint8Array(width * height);
        if (isFloat32) {
            const rgba = new Float32Array(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    (0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]) * 255
                );
            }
        } else {
            const rgba = new Uint8ClampedArray(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]
                );
            }
        }
        return gray;
    }

    /**
     * Calculate mean brightness of non-black pixels (for normalization)
     * Supports both Float32 (0.0-1.0) and Uint8 (0-255) input
     * Always returns brightness in 0-255 scale for consistency with stacking worker
     */
    function calcMeanBrightness(buffer, width, height, isFloat32 = false) {
        let sum = 0;
        let count = 0;
        const step = 8;

        if (isFloat32) {
            const data = new Float32Array(buffer);
            const blackCutoff = 10 / 255; // ~0.04 in float range
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        } else {
            const data = new Uint8Array(buffer);
            const blackCutoff = 10;
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        }
        // Always return in 0-255 scale (matches stacking worker's calcMeanBrightness)
        const avg = count > 0 ? sum / count : 1;
        return isFloat32 ? avg * 255 : avg;
    }

    /**
     * Crop raw Bayer data to a square region centered at (centerX, centerY)
     * Ensures crop starts at even coordinates to preserve Bayer pattern
     * @param {Uint8Array|Uint16Array} data - Raw Bayer data (single channel)
     * @param {number} srcWidth - Source image width
     * @param {number} srcHeight - Source image height
     * @param {number} cropSize - Size of square crop region
     * @param {number} centerX - Center X coordinate
     * @param {number} centerY - Center Y coordinate
     * @returns {Uint8Array|Uint16Array} Cropped Bayer data
     */
    function cropRawBayer(data, srcWidth, srcHeight, cropSize, centerX, centerY) {
        const halfCrop = Math.floor(cropSize / 2);

        // Calculate crop start, ensuring even coordinates for Bayer alignment
        let startX = Math.round(centerX - halfCrop);
        let startY = Math.round(centerY - halfCrop);

        // Clamp to image bounds
        startX = Math.max(0, Math.min(srcWidth - cropSize, startX));
        startY = Math.max(0, Math.min(srcHeight - cropSize, startY));

        // Ensure even coordinates to preserve Bayer pattern
        startX = startX & ~1;  // Round down to even
        startY = startY & ~1;

        // Create output buffer of same type as input
        const OutputType = data instanceof Uint16Array ? Uint16Array : Uint8Array;
        const cropped = new OutputType(cropSize * cropSize);

        // Copy crop region row by row
        for (let y = 0; y < cropSize; y++) {
            const srcOffset = (startY + y) * srcWidth + startX;
            const dstOffset = y * cropSize;
            cropped.set(data.subarray(srcOffset, srcOffset + cropSize), dstOffset);
        }

        return cropped;
    }

    /**
     * Create alignment points grid (pure JS, no OpenCV)
     * PSS defaults: patchSize=20, searchRadius=8 (planets) or 34 (surface)
     */
    // AP grid spacing bounds.
    //   PATCH_FRACTION: floor on spacing as a fraction of patch size, so
    //     overlap can never exceed 25% however large the patch gets. Matches
    //     PSS. Extra overlap buys no information: the warp at each pixel is
    //     smoothed over a Gaussian of sigma = 1.5 x patch, and the independent
    //     evidence inside that kernel is set by its area divided by the patch
    //     area, not by how finely it is sampled. At 0.5 we sampled 3x finer
    //     than we smooth and re-measured the same pixels. The redundancy did
    //     quietly dilute outliers, which is why the robust estimator in the
    //     warp shader had to land first.
    //   MIN: cost floor. NCC work scales as 1/spacing^2, and atmospheric warp
    //     is smooth over tens of pixels, so sampling finer than this buys
    //     resolution the signal does not have.
    //   MAX: absolute coarseness limit, so one huge patch cannot flatten the
    //     warp field into a handful of points on a large frame.
    //   MIN_GRID_STEPS: points across the short edge, the relative version of
    //     the same guard for small frames.
    // Trackability bar, as sqrt(lambda_min) of a patch's structure tensor.
    // Calibrated against measured runs on a soft ~210px Jupiter, where the
    // neighbour-disagreement metric put the noise boundary between these:
    //   trackScore 14.8 -> 93% disagreement (pure noise)
    //   trackScore 34.1 -> 55%
    //   trackScore 45.9 -> 41% (real seeing)
    // 40 sits just below the point where the warp field became real. It is one
    // target's calibration, so expect to revisit it; the log prints the score
    // distribution so a bad bar is visible rather than silent.
    const AP_TRACK_SCORE_MIN = 40;
    // Selection is RELATIVE: keep points scoring at least this fraction of the
    // best point in the same image. An absolute bar cannot work for selection,
    // because it is calibrated against whatever target happened to be measured
    // and every other capture has its own scale of structure. Kept low on
    // purpose: the warp at each pixel is an average over nearby points, so
    // discarding weak-but-unbiased ones costs noise averaging (measured at
    // roughly 1.9x more field noise on one clip). Selection should remove the
    // useless, not chase the best.
    // 4%, matching PSS. 10% was measured to carve holes in the very targets it
    // should handle best: on a bright planet the limb lifts the best score, the
    // bar rises with it, and mid-disk points fall under, leaving 50% of the
    // disk with no alignment point at all. Selection is meant to drop the
    // useless, not rank the good, and a near-inert bar is the correct shape for
    // that now the warp shader rejects outliers on its own.
    const AP_TRACK_RELATIVE = 0.04;
    // Floor for "this patch has essentially no gradient at all", so a frame
    // whose best point is itself noise does not keep everything by default.
    const AP_TRACK_SCORE_FLOOR = 4;
    // Brightness gate, as a fraction of the frame's own range above its
    // background. Small: this only separates subject from sky.
    const AP_BRIGHTNESS_RELATIVE = 0.02;
    // Share of probe positions that must clear the bar for a patch size to be
    // accepted. Well under half, because on a planetary disk only the limb and
    // the belt edges are ever trackable and that is enough to pin the frame.
    const AP_TRACK_SHARE_MIN = 0.25;
    // Below this many surviving APs the warp field is not a field. Applying it
    // is worse than not applying it, so the run falls back to global alignment.
    const AP_MIN_TRACKABLE = 6;

    // Search radii, unchanged from the long-standing defaults.
    const PLANETARY_SEARCH_RADIUS = 8;
    const SURFACE_SEARCH_RADIUS = 34;
    const AP_SPACING_PATCH_FRACTION = 3 / 4;
    const AP_SPACING_MIN = 10;
    const AP_SPACING_MAX = 64;
    const AP_MIN_GRID_STEPS = 6;

    function createAPGrid(width, height, surfaceMode = false, refGray = null) {
        const override = getApPatchOverride();
        let patchSize = override || getApPatchSize();
        const searchRadius = surfaceMode ? SURFACE_SEARCH_RADIUS : PLANETARY_SEARCH_RADIUS;

        // Patch size is always measured unless someone has overridden it from
        // the AP checker, having seen the grid. There is no separate "auto"
        // switch: a setting that silently disables another setting, with
        // neither showing its consequence, is worse than no setting at all.
        if (override) {
            addLog(`AP sizing: manual override, patch ${patchSize}px`);
        } else if (refGray) {
            const auto = autoAlignmentGeometry(refGray, width, height, surfaceMode);
            if (auto) {
                patchSize = auto.patchSize;
                addLog(`AP sizing (${auto.basis}): patch ${patchSize}px, search radius ${searchRadius}px`);
            } else {
                addLog(`AP sizing: could not measure a target, using patch ${patchSize}px`);
            }
        }

        // Cap patch size for small images - patch can't be larger than 1/3 of image
        const minDim = Math.min(width, height);
        const maxPatchSize = Math.floor(minDim / 3);
        if (patchSize > maxPatchSize && maxPatchSize >= 8) {
            patchSize = maxPatchSize;
        }

        // Frame-size spacing, unchanged.
        let spacing;
        if (minDim < 300) {
            spacing = Math.min(20, Math.floor(minDim / 3));
        } else if (minDim < 500) {
            spacing = 20;
        } else if (minDim < 800) {
            spacing = 15;
        } else {
            // Large frames were already patch-driven; the floor below now sets
            // the policy for every size, so this just defers to it.
            spacing = Math.floor(patchSize * AP_SPACING_PATCH_FRACTION);
        }

        // Cap overlap at 25% by never spacing APs closer than 3/4 of a patch.
        // Applied as a FLOOR on the rule above rather than a replacement, so
        // every existing configuration keeps its exact spacing and only large
        // patches move. Those are where the waste is: an 84px patch at 20px
        // spacing overlaps 76%, and since NCC cost is APs x searchArea x
        // patchArea, most of that work re-measures the same pixels.
        spacing = Math.max(spacing, Math.floor(patchSize * AP_SPACING_PATCH_FRACTION));
        spacing = Math.max(AP_SPACING_MIN, Math.min(AP_SPACING_MAX, spacing));
        // However coarse the patch, the grid still has to be a field: keep at
        // least AP_MIN_GRID_STEPS points across the short edge.
        spacing = Math.min(spacing, Math.max(AP_SPACING_MIN, Math.floor(minDim / AP_MIN_GRID_STEPS)));

        // User/lite-mode density dial. Widening the spacing drops the AP count
        // quadratically, which is the dominant term in NCC dispatch cost
        // (frames × APs × searchArea × patchArea). Default scale is 1, so the
        // grid is unchanged unless something deliberately dials it back.
        const spacingScale = getApSpacingScale();
        if (spacingScale > 1) {
            spacing = Math.max(4, Math.round(spacing * spacingScale));
        }

        const alignmentPoints = [];
        // A patch that overhangs the frame cannot be matched, so centres are
        // confined to half a patch in from each edge. That margin is
        // unavoidable; stopping short of it is not.
        const margin = patchSize / 2;

        // Spread points evenly across the usable span instead of stepping by a
        // fixed spacing and giving up when the next step would overflow. The
        // fixed-step version stranded whatever did not divide evenly: on a
        // tightly cropped 220px frame at patch 56 it reached x=174 when it
        // could have reached 192, and the leftover was dumped on one side, so
        // the bare band was 30px on the left and 46px on the right. Tight crops
        // are the normal planetary case, and that is precisely where the subject
        // runs right up to the edge and most needs covering. PSS corrects the
        // step the same way.
        const axisLocations = (total, offsetHalfStep) => {
            const span = total - 2 * margin;
            if (span <= 0) return [];
            const steps = Math.max(1, Math.ceil(span / spacing));
            const step = span / steps;
            if (offsetHalfStep) {
                // Staggered row: half a step across, one point fewer, which
                // leaves it short of the margin at BOTH ends. Copied from PSS
                // as-is at first, and it scalloped the left and right edges of
                // the grid by half a step on alternate rows. Put the two edge
                // points back so every row reaches the margin; the stagger that
                // matters is in the interior, and the slightly tighter pair at
                // each end costs a little redundancy rather than coverage.
                const inner = Array.from({ length: steps }, (_, i) => margin + step * (i + 0.5));
                const out = [margin];
                for (const v of inner) {
                    if (v - out[out.length - 1] > 1) out.push(v);
                }
                const last = total - margin;
                if (last - out[out.length - 1] > 1) out.push(last);
                return out;
            }
            return Array.from({ length: steps + 1 }, (_, i) => margin + step * i);
        };

        // Staggered rows, offset by half a step on alternate lines, the way PSS
        // lays its grid out. A square lattice lines up in both directions at
        // once, which samples the warp field on a coarser effective grid along
        // the diagonals and makes the patches moire into a chessboard when
        // drawn. Brickwork avoids both for free.
        const ysAll = axisLocations(height, false);
        const xsEven = axisLocations(width, false);
        const xsOdd = axisLocations(width, true);
        ysAll.forEach((y, row) => {
            for (const x of (row % 2 ? xsOdd : xsEven)) {
                alignmentPoints.push({ x: Math.round(x), y: Math.round(y) });
            }
        });

        // Report the corrected step, not the nominal one: overlap and the
        // neighbour search are both computed from it.
        if (xsEven.length > 1) spacing = Math.round(xsEven[1] - xsEven[0]);

        // Ensure at least one center AP for very small images
        if (alignmentPoints.length === 0 && minDim >= 8) {
            alignmentPoints.push({ x: Math.floor(width / 2), y: Math.floor(height / 2) });
        }

        return { alignmentPoints, patchSize, searchRadius, spacing };
    }

    /**
     * Filter alignment points by structure (local contrast) and brightness
     * PSS defaults: minStructure=0.02, minBrightness=5
     */
    // How well can the reference patches actually be *located*?
    //
    // filterAPsByQuality below keeps a patch on its standard deviation, which
    // measures contrast, not localizability. A smooth ramp (limb darkening, a
    // defocused edge, a terminator) has plenty of contrast, but its NCC surface
    // is a ridge rather than a peak: sliding along the ridge barely changes the
    // score, so the argmax position in that direction is decided by noise. That
    // is the aperture problem, and the structure tensor is what detects it. For
    // gradients Ix, Iy over the patch, [[sum Ix^2, sum IxIy], [sum IxIy, sum
    // Iy^2]] has a small eigenvalue that measures the *worst* direction. A ramp
    // has one large and one near-zero eigenvalue; a corner has two large ones.
    // This is the Shi-Tomasi "good features to track" criterion.
    //
    // Diagnostic only: it reports, it does not filter. Two readings matter.
    // Ridge-like APs are localizable in one direction only. Noise-limited APs
    // have a weak-direction gradient too shallow to beat 8-bit quantisation, so
    // their matched position is noise in *both* directions.
    // Measured when the AP grid is built, but reported at the end next to the
    // warp histogram: the two readouts only make sense read together, and the
    // end of the log is where a run gets copied from. Kept outside warpStats
    // because resetWarpStats runs *after* the grid is prepared.
    // Structure tensor of one patch: the single primitive behind AP selection,
    // auto patch sizing and the localizability readout.
    //
    // For gradients Ix, Iy over the patch, [[sum Ix^2, sum IxIy], [sum IxIy,
    // sum Iy^2]] has eigenvalues measuring how sharply the patch is pinned down
    // along its best and worst axes. The SMALLER one is what matters: a smooth
    // ramp has one large and one near-zero eigenvalue and slides freely along
    // the ridge, while a corner has two large ones and is pinned in both.
    // Shi-Tomasi "good features to track", applied to template matching.
    //
    // trackScore is sqrt(lambda_min), i.e. TOTAL structure in the worst
    // direction, not per-pixel. That distinction is the whole point: measured
    // on one file, per-pixel gradient barely moved across patch sizes (0.53 ->
    // 0.56) while quality transformed, because a bigger patch accumulates more
    // of the same gentle gradient. trackScore tracked the outcome exactly:
    //   trackScore 14.8 -> neighbour disagreement 93% (noise)
    //   trackScore 34.1 -> 55%
    //   trackScore 45.9 -> 41% (real seeing, Rayleigh warp histogram)
    // Positional error goes as 1/sqrt(lambda_min), so trackScore is inversely
    // proportional to how far the matched position wanders.
    function patchStructure(refGray, width, x0, y0, patchSize) {
        let a = 0, b = 0, c = 0, n = 0;
        for (let py = 1; py < patchSize - 1; py++) {
            const row = (y0 + py) * width + x0;
            for (let px = 1; px < patchSize - 1; px++) {
                const idx = row + px;
                const ix = (refGray[idx + 1] - refGray[idx - 1]) * 0.5;
                const iy = (refGray[idx + width] - refGray[idx - width]) * 0.5;
                a += ix * ix;
                b += ix * iy;
                c += iy * iy;
                n++;
            }
        }
        if (!n) return null;
        const tr = a + c;
        const det = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
        const lMin = Math.max(0, (tr - det) / 2);
        const lMax = Math.max(0, (tr + det) / 2);
        return { lMin, lMax, n, trackScore: Math.sqrt(lMin), weakGrad: Math.sqrt(lMin / n) };
    }

    function patchInFrame(x0, y0, patchSize, width, height) {
        return x0 >= 1 && y0 >= 1 && x0 + patchSize < width && y0 + patchSize < height;
    }

    let apLocalizability = null;
    // Lattice points before filterAPsByQuality culls them. Worth reporting next
    // to the survivor count: raising the patch size shrinks the grid but lifts
    // the pass rate (a bigger patch reaches bright pixels from further out), so
    // the two move in opposite directions and the net AP count is not something
    // you can predict from the patch size alone.
    let apGridTotal = 0;
    const MAX_APS_FOR_LOCALIZABILITY = 5000;
    function measureApLocalizability(alignmentPoints, refGray, width, height, patchSize) {
        apLocalizability = null;
        if (!alignmentPoints?.length) return;
        const halfPatch = Math.floor(patchSize / 2);
        // Sample evenly rather than truncating, so the readout describes the
        // whole frame and not just its top-left corner.
        const stride = Math.max(1, Math.ceil(alignmentPoints.length / MAX_APS_FOR_LOCALIZABILITY));

        const weakGrads = [];
        let ridgeLike = 0;
        let noiseLimited = 0;

        for (let i = 0; i < alignmentPoints.length; i += stride) {
            const ap = alignmentPoints[i];
            if (!ap) continue;
            const x0 = ap.x - halfPatch;
            const y0 = ap.y - halfPatch;
            if (x0 < 1 || y0 < 1 || x0 + patchSize >= width || y0 + patchSize >= height) continue;

            let a = 0, b = 0, c = 0, n = 0;
            for (let py = 1; py < patchSize - 1; py++) {
                const row = (y0 + py) * width + x0;
                for (let px = 1; px < patchSize - 1; px++) {
                    const idx = row + px;
                    const ix = (refGray[idx + 1] - refGray[idx - 1]) * 0.5;
                    const iy = (refGray[idx + width] - refGray[idx - width]) * 0.5;
                    a += ix * ix;
                    b += ix * iy;
                    c += iy * iy;
                    n++;
                }
            }
            if (!n) continue;

            const tr = a + c;
            const det = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
            const lMin = (tr - det) / 2;
            const lMax = (tr + det) / 2;

            // RMS gradient along the weakest direction, in grey levels per pixel.
            const weakGrad = Math.sqrt(Math.max(0, lMin) / n);
            weakGrads.push(weakGrad);
            if (lMax > 0 && lMin / lMax < 0.1) ridgeLike++;
            // Below ~1 grey level/px the matched position is swamped by 8-bit
            // quantisation: positional sigma goes as noise/weakGrad.
            if (weakGrad < 1.0) noiseLimited++;
        }

        if (!weakGrads.length) return;
        weakGrads.sort((p, q) => p - q);
        apLocalizability = {
            sampled: weakGrads.length,
            median: weakGrads[Math.floor(weakGrads.length / 2)],
            ridgeLike,
            noiseLimited,
            gray: greyRange(refGray),
        };
    }

    // Dynamic range of the 8-bit image the matcher actually sees. A patch can
    // only be flat for two reasons: the scene has no detail at this scale, or
    // the greyscale conversion threw the detail away before the matcher ever
    // saw it. Those need completely different fixes, and min/max/stddev tells
    // them apart immediately: a planetary crop should span most of 0-255, and
    // a frame compressed into a handful of levels is a conversion bug.
    function greyRange(refGray) {
        if (!refGray?.length) return null;
        let min = 255, max = 0, sum = 0, sumSq = 0, n = 0;
        // Every 3rd pixel: plenty for a range estimate, cheap on a big frame.
        for (let i = 0; i < refGray.length; i += 3) {
            const v = refGray[i];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
            sumSq += v * v;
            n++;
        }
        const mean = sum / n;
        return { min, max, mean, stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
    }

    // Returned as a fragment rather than logged on its own line: it has to ride
    // along on a line that is certain to be read, and a separate line above the
    // summary header is not that.
    function apLocalizabilitySummary() {
        if (!apLocalizability) return 'AP localizability: not measured';
        const { sampled, median, ridgeLike, noiseLimited } = apLocalizability;
        const pct = (x) => ((x / sampled) * 100).toFixed(1);
        const g = apLocalizability.gray;
        const grayPart = g
            ? ` | img ${g.min}-${g.max}/255, mean ${g.mean.toFixed(1)}, sd ${g.stdDev.toFixed(1)}`
            : '';
        return `ridge ${pct(ridgeLike)}%, noise-limited ${pct(noiseLimited)}%, weakGrad ${median.toFixed(2)}/px (${sampled.toLocaleString()}ap)${grayPart}`;
    }

    // Extent of the lit subject in the reference frame, in pixels.
    //
    // Measured straight off the greyscale rather than plumbed through from crop
    // detection, so it still works when the crop was skipped. Threshold sits at
    // 20% of the frame's range above its floor, which separates a planetary
    // disk from sky without caring how dim the capture is; the bounding box of
    // what survives is the subject. Returns null when the subject fills the
    // frame (no dark border to bound it against), which is the surface case and
    // is handled by its own rule.
    // Background level and peak of the reference greyscale.
    //
    // Background is a low percentile, not the minimum and not the median. Not
    // the minimum, because a capture sits on a haze floor well above zero and
    // the single darkest pixel is noise. Not the median, because that only
    // equals the background when the subject covers less than half the frame:
    // on a lunar or solar frame the subject IS the frame, the median lands
    // mid-surface, and a bar measured from it rejects everything darker than
    // average. Measured on a synthetic full-frame lunar, a median-based bar
    // threw away half the surface (61 of 138 points); the percentile keeps it.
    const BACKGROUND_PERCENTILE = 0.10;
    function greyBackgroundPeak(refGray) {
        const hist = new Uint32Array(256);
        let sampled = 0;
        for (let i = 0; i < refGray.length; i += 3) {
            hist[refGray[i]]++;
            sampled++;
        }
        if (!sampled) return null;
        let cumulative = 0, background = 0;
        for (let v = 0; v < 256; v++) {
            cumulative += hist[v];
            if (cumulative >= sampled * BACKGROUND_PERCENTILE) { background = v; break; }
        }
        let peak = 255;
        while (peak > 0 && hist[peak] === 0) peak--;
        return { background, peak };
    }

    function measureTargetDiameter(refGray, width, height) {
        if (!refGray?.length) return null;

        // Shared estimator, deliberately not a local copy: an earlier inline
        // version here used the median and silently under-measured every
        // tightly cropped subject, because a tight crop leaves no sky for the
        // median to land in. A 200px disk measured 144px at a 2% crop margin.
        const levels = greyBackgroundPeak(refGray);
        if (!levels) return null;
        const { background, peak } = levels;
        if (peak - background < 10) return null;

        // Area above threshold, converted to the diameter of the equivalent
        // circle. A bounding box is set by its two most extreme pixels, so a
        // little haze or a few hot pixels stretches it arbitrarily; area has to
        // be outvoted by thousands of pixels to move.
        const threshold = background + (peak - background) * 0.25;
        let area = 0;
        for (let i = 0; i < refGray.length; i++) {
            if (refGray[i] > threshold) area++;
        }
        if (!area) return null;

        // Cap rather than reject when the subject fills the frame. An earlier
        // version bailed above 95%, on the theory that no dark surround meant
        // no measurable subject. That is wrong here: planetary frames are
        // cropped tightly on purpose, so filling the frame is the normal case
        // and the measurement is correct. Surface frames never reach this code,
        // they take their own branch, and a frame with genuinely no subject is
        // already rejected above on peak minus background.
        const diameter = 2 * Math.sqrt(area / Math.PI);
        return Math.round(Math.min(diameter, Math.min(width, height)));
    }

    // Alignment geometry derived from the subject rather than fixed constants.
    //
    // Planetary: both numbers scale with the measured disk. Patch size at D/4
    // sits inside the D/4..D/3 range the measurements support (30px on a 200px
    // Jupiter left every AP on featureless disk; 64px reached the limb and cut
    // border-capping from 25% to 8%). Search radius at D/25 reproduces today's
    // 8px at D=200, so a 200px target behaves exactly as before and only other
    // sizes move.
    //
    // Surface: there is no disk, the frame is the subject, so patch size scales
    // with the frame instead. The search radius is deliberately NOT scaled: the
    // 34px surface figure exists to absorb mount drift, which has nothing to do
    // with how big the features are, and shrinking it would reintroduce the
    // border-capping this whole exercise was about.
    // Smallest patch size at which the frame actually yields trackable APs.
    //
    // Replaces guessing patch size from the subject diameter. Diameter is only
    // a correlate: what decides whether matching works is how much structure a
    // patch of a given size contains, and that depends on the target's detail,
    // not just its size. So measure it directly, over a coarse sample of
    // candidate positions, and take the smallest candidate that clears the bar
    // for a useful share of them. Smallest-that-works matters because NCC cost
    // grows with patchSize^2 and a finer grid resolves warp better.
    function chooseAutoPatchSize(refGray, width, height, maxPatch) {
        // Starts at 10, not 20: a 48px crop caps patch size at 16, so a list
        // beginning at 20 would be filtered empty and the measured path would
        // silently fall back to the diameter formula on exactly the small
        // targets that need measuring most.
        const candidates = [10, 14, 20, 28, 40, 56, 80, 112, 160, 224].filter(p => p <= maxPatch);
        if (!candidates.length) return null;

        let fallback = candidates[0];
        let fallbackShare = -1;

        for (const patchSize of candidates) {
            const half = Math.floor(patchSize / 2);
            // Sample on a grid independent of patch size so candidates are
            // compared over the same ground.
            const step = Math.max(patchSize, Math.floor(Math.min(width, height) / 12));
            let tested = 0, passed = 0;
            for (let y = half + 1; y + half + 1 < height; y += step) {
                for (let x = half + 1; x + half + 1 < width; x += step) {
                    const st = patchStructure(refGray, width, x - half, y - half, patchSize);
                    if (!st) continue;
                    tested++;
                    if (st.trackScore >= AP_TRACK_SCORE_MIN) passed++;
                }
            }
            if (!tested) continue;
            const share = passed / tested;
            if (share > fallbackShare) { fallbackShare = share; fallback = patchSize; }
            if (share >= AP_TRACK_SHARE_MIN) {
                return { patchSize, share, measured: true };
            }
        }
        // Nothing cleared the bar. Hand back whichever came closest and say so,
        // so the caller can decide whether local warping is worth attempting.
        return { patchSize: fallback, share: Math.max(0, fallbackShare), measured: false };
    }

    function autoAlignmentGeometry(refGray, width, height, surfaceMode) {
        const minDim = Math.min(width, height);
        const even = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v / 2) * 2));

        if (surfaceMode) {
            // Same measured criterion as planetary, so the default is never a
            // bare guess. Lunar and solar detail is usually high contrast, so
            // this normally settles on a small patch, which is cheaper than
            // the fixed default rather than more expensive. The frame caps it
            // because there is no disk to cap it with. Search radius stays at
            // 34: it absorbs mount drift, which is unrelated to feature size.
            const surfaceMax = Math.max(24, Math.min(256, Math.round(minDim / 8)));
            const picked = chooseAutoPatchSize(refGray, width, height, surfaceMax);
            return {
                patchSize: picked ? even(picked.patchSize, 16, 256) : even(minDim / 12, 24, 256),
                searchRadius: SURFACE_SEARCH_RADIUS,
                trackable: picked ? picked.measured : true,
                basis: picked
                    ? `surface, frame ${minDim}px, ${(picked.share * 100).toFixed(0)}% of probes trackable at ${picked.patchSize}px${picked.measured ? '' : ' (below bar)'}`
                    : `surface, frame ${minDim}px`,
            };
        }

        const diameter = measureTargetDiameter(refGray, width, height);
        if (!diameter) return null;
        // Calibrated against measured runs on a ~210px Jupiter, where quality
        // improved monotonically with patch size and no ceiling was reached:
        //   D/7   (30px): disagree 93%, capped 25%  - every AP on blank disk
        //   D/3.3 (64px): disagree 55%, capped 8%
        //   D/2.5 (84px): disagree 41%, capped 0.1% - Rayleigh warp histogram
        // D/3 sits between the two best points. The true optimum may be larger;
        // the ceiling is wherever the AP grid gets too coarse to be a field.
        //
        // Radius at D/15 reproduces the 14px that produced capped 0.1% on that
        // target. The earlier D/25 was fitted to a diameter we now know was
        // overestimated by 1.6x, so it would have given 8px here, and 8px was
        // measured at 8% capped.
        // Diameter still sets the ceiling (a patch larger than a third of the
        // subject leaves too few APs to form a field) and still sets the search
        // radius, which depends on how far the subject drifts rather than on
        // how much detail it has. Patch size itself is measured.
        const maxPatch = Math.max(16, Math.min(256, Math.round(diameter / 2)));
        const chosen = chooseAutoPatchSize(refGray, width, height, maxPatch);
        const patchSize = chosen ? even(chosen.patchSize, 16, 256) : even(diameter / 3, 16, 256);
        // Search radius deliberately NOT derived from the subject. D/15 was
        // fitted to one file against a diameter later found to be wrong, and
        // it regressed two real captures: on an uncropped frame it measured a
        // large subject, hit its 34px ceiling and handed the argmax a window
        // 4.2x the default search area, which it promptly filled with 20px of
        // random wander. Cost goes as (2r+1)^2 too. Keep the proven default and
        // let the `capped` readout say when a specific file needs more.
        return {
            patchSize,
            searchRadius: PLANETARY_SEARCH_RADIUS,
            trackable: chosen ? chosen.measured : true,
            basis: chosen
                ? `target ${diameter}px, ${(chosen.share * 100).toFixed(0)}% of probes trackable at ${chosen.patchSize}px${chosen.measured ? '' : ' (below bar)'}`
                : `target ${diameter}px`,
        };
    }

    // Slide any point whose patch overhangs the frame back inside, rather than
    // discarding it.
    //
    // Dropping was the old behaviour and it is the wrong trade on a tight crop,
    // where the subject runs right up to the edge: the points nearest the rim
    // cover real signal, and a few pixels of displacement costs far less than
    // losing them. The grid already places its outermost row exactly at the
    // margin, so this mostly matters after the brightness nudge and for odd
    // patch sizes, where rounding can leave a point a pixel over the line.
    function clampApsIntoFrame(alignmentPoints, width, height, patchSize) {
        const half = Math.floor(patchSize / 2);
        // x0 = x - half must be >= 0, and x0 + patchSize must be <= width.
        const hiX = width - (patchSize - half);
        const hiY = height - (patchSize - half);
        if (hiX < half || hiY < half) return 0;

        let moved = 0;
        for (const ap of alignmentPoints) {
            const nx = Math.max(half, Math.min(hiX, ap.x));
            const ny = Math.max(half, Math.min(hiY, ap.y));
            if (nx !== ap.x || ny !== ap.y) {
                ap.x = nx;
                ap.y = ny;
                moved++;
            }
        }
        return moved;
    }

    // Pull alignment points onto the subject.
    //
    // A point whose patch is mostly empty sky carries almost no signal, and on
    // a round target that is every point near the limb: exactly where the
    // sharpest feature in a soft planetary frame lives. Discarding them wastes
    // the best structure in the image, so instead each mostly-dark patch is
    // moved to the centre of brightness within its own patch, which slides it
    // back onto the disk. This is why the PSS grid visibly follows the planet's
    // curve instead of stopping at a straight lattice edge.
    //
    // Only mostly-dark patches move, so interior points stay exactly on the
    // lattice and the warp field keeps its regular sampling where it matters.
    const AP_NUDGE_DARK_FRACTION = 0.6;
    function nudgeApsToBrightness(alignmentPoints, refGray, width, height, patchSize, minBrightness) {
        const half = Math.floor(patchSize / 2);
        // Keep the moved point far enough inside that its patch still fits.
        const lo = half + 1;
        const hiX = width - half - 2;
        const hiY = height - half - 2;
        if (hiX <= lo || hiY <= lo) return 0;

        let moved = 0;
        for (const ap of alignmentPoints) {
            const x0 = ap.x - half;
            const y0 = ap.y - half;
            if (x0 < 0 || y0 < 0 || x0 + patchSize > width || y0 + patchSize > height) continue;

            let dark = 0, total = 0, mass = 0, mx = 0, my = 0;
            for (let py = 0; py < patchSize; py++) {
                const rowBase = (y0 + py) * width + x0;
                for (let px = 0; px < patchSize; px++) {
                    const v = refGray[rowBase + px];
                    if (v < minBrightness) dark++;
                    total++;
                    mass += v;
                    mx += v * px;
                    my += v * py;
                }
            }
            if (!total || !mass) continue;
            if (dark / total <= AP_NUDGE_DARK_FRACTION) continue;

            const nx = Math.round(x0 + mx / mass);
            const ny = Math.round(y0 + my / mass);
            const cx = Math.max(lo, Math.min(hiX, nx));
            const cy = Math.max(lo, Math.min(hiY, ny));
            if (cx !== ap.x || cy !== ap.y) {
                ap.x = cx;
                ap.y = cy;
                moved++;
            }
        }
        return moved;
    }

    // Build the AP grid, publish it to the UI, and let the reviewer rebuild it
    // with a different patch size before any frame is matched.
    //
    // A loop rather than a single pass, because patch size is the parameter
    // that decides nearly everything about a stack and the only honest way to
    // choose it is to see the grid it produces. Falls straight through when
    // the checker is off.
    async function prepareAlignmentWithReview(build) {
        let data = build();
        for (;;) {
            resetWarpStats(data.searchRadius, data.alignmentPoints, data.patchSize, data.spacing);
            emit('alignment-points', {
                alignmentPoints: data.alignmentPoints,
                patchSize: data.patchSize,
                searchRadius: data.searchRadius,
                localWarp: data.localWarp,
                overlapPct: warpStats?.geom?.overlapPct != null ? Math.round(warpStats.geom.overlapPct) : null,
                spacing: data.spacing,
                width: data.width,
                height: data.height,
                autoPatchSize: getApPatchOverride() == null,
            });

            const action = await awaitApReview();
            const requested = action && Number(action.patchSize);
            if (requested && requested !== data.patchSize) {
                setApPatchOverride(requested);
                addLog(`Alignment points: rebuilding at ${requested}px patches`);
                data = build();
                continue;
            }
            return data;
        }
    }

    // Optional stop in the workflow so the alignment points can be inspected
    // before any frame is matched against them.
    //
    // Worth having because the AP grid decides nearly everything about a stack
    // and is the hardest part to reason about after the fact: by the time the
    // result looks wrong, the grid that caused it is gone. Pausing here also
    // gives a natural place to hang manual AP editing later.
    //
    // Resolves on cancel as well as continue, so a cancelled job cannot leave
    // the pipeline parked on a promise nobody will ever settle.
    async function awaitApReview() {
        if (!getShowApChecker()) return null;
        emit('set-caption', 'Review alignment points');
        emit('ap-review-open');
        const action = await new Promise((resolve) => {
            const done = (payload) => {
                off('ap-review-continue', done);
                off('cancel-processing', done);
                resolve(payload || null);
            };
            on('ap-review-continue', done);
            on('cancel-processing', done);
        });
        emit('ap-review-closed');
        emit('set-caption', 'Stacking...');
        return action;
    }

    // Is a local warp field worth computing at all?
    //
    // When almost nothing in the frame can be tracked, every displacement the
    // matcher returns is noise, and feeding noise into the warp field actively
    // smears detail that plain global alignment would have preserved. Soft but
    // clean beats soft and smeared, so in that case we stack globally aligned
    // frames with no local correction. Before this there was no path to that
    // outcome: the field was always applied, however meaningless.
    // NCC maxes out at 1.0, so a bar above it rejects every alignment point in
    // the warp shader, leaving zero displacement everywhere. The frames are
    // already globally aligned by per-frame centring, so that is exactly a
    // global-alignment stack, reached without a separate code path.
    function effectiveMinApQuality(localWarp) {
        return localWarp === false ? 2.0 : getMinApQuality();
    }

    function assessLocalWarp(trackableCount, gridCount, bestTrackScore) {
        // Absolute question, separate from selection: if the single best patch
        // in the frame still cannot be located, no choice of points helps and
        // the warp field would be noise. Stack globally aligned instead.
        if (bestTrackScore !== undefined && bestTrackScore < AP_TRACK_SCORE_MIN) {
            addLog(`Local de-warping disabled: nothing in this frame is trackable (best alignment point scores ${bestTrackScore.toFixed(0)}, needs ${AP_TRACK_SCORE_MIN}). Stacking with global alignment only - softer, but free of warp artifacts.`);
            return false;
        }
        // "Enough" has to be relative to how many points the grid could ever
        // hold. A 48px crop has 16 lattice points in total and most sit on
        // empty sky, so a flat floor of 6 would switch off local warping on a
        // small target that was aligning perfectly well. Never demand more
        // than a quarter of the available points, and never fewer than 3.
        const needed = Math.max(3, Math.min(AP_MIN_TRACKABLE, Math.ceil(gridCount * 0.25)));
        if (trackableCount >= needed) return true;
        addLog(`Local de-warping disabled: only ${trackableCount} of ${gridCount} alignment points are trackable (need ${needed}). Stacking with global alignment only - the result will be softer but free of warp artifacts.`);
        return false;
    }

    // Returns { points, bestTrackScore }. The best score is the global
    // decision input: selection is relative, but whether local warping is worth
    // attempting at all depends on whether ANYTHING in the frame is trackable,
    // and that question needs an absolute answer.
    function filterAPsByQuality(alignmentPoints, refGray, width, height, patchSize, minStructure = 0.02, minBrightness = 5) {
        // minStructure is retained in the signature for callers but no longer
        // gates anything; see the note at the brightness check below.
        const halfPatch = Math.floor(patchSize / 2);
        const filtered = [];

        // Pass 1: score every candidate, so the bar can be set from this image.
        const scores = new Map();
        let bestTrackScore = 0;
        for (const ap of alignmentPoints) {
            const sx = ap.x - halfPatch;
            const sy = ap.y - halfPatch;
            if (!patchInFrame(sx, sy, patchSize, width, height)) continue;
            const st = patchStructure(refGray, width, sx, sy, patchSize);
            if (!st) continue;
            scores.set(ap, st.trackScore);
            if (st.trackScore > bestTrackScore) bestTrackScore = st.trackScore;
        }
        const trackBar = Math.max(AP_TRACK_SCORE_FLOOR, bestTrackScore * AP_TRACK_RELATIVE);

        // Sky sits at the background; the subject is anything meaningfully
        // above it. The margin is small because trackScore already rejects
        // featureless patches: this gate only has to answer "is there a
        // subject here at all".
        const levels = greyBackgroundPeak(refGray);
        const brightnessBar = levels
            ? levels.background + Math.max(2, (levels.peak - levels.background) * AP_BRIGHTNESS_RELATIVE)
            : minBrightness;

        for (const ap of alignmentPoints) {
            const x0 = ap.x - halfPatch;
            const y0 = ap.y - halfPatch;

            if (x0 < 0 || y0 < 0 || x0 + patchSize > width || y0 + patchSize > height) {
                continue;
            }


            let sum = 0;
            let sumSq = 0;
            const n = patchSize * patchSize;

            for (let py = 0; py < patchSize; py++) {
                for (let px = 0; px < patchSize; px++) {
                    const val = refGray[(y0 + py) * width + (x0 + px)];
                    sum += val;
                    sumSq += val * val;
                }
            }

            const mean = sum / n;
            const variance = (sumSq / n) - (mean * mean);
            const stdDev = Math.sqrt(Math.max(0, variance));
            const structure = stdDev / 255;

            const trackScore = scores.get(ap);
            if (trackScore !== undefined && trackScore < trackBar) continue;

            // Brightness gates against empty sky, and like every other
            // threshold here it has to be relative to the frame. A fixed bar
            // of 5/255 cut the faint outer disk off a dim capture, because
            // real signal there sits below 5 in the raw data even though it is
            // plainly part of the subject once stretched. Measuring from the
            // background instead admits faint signal while still excluding
            // sky, and tightens automatically on a hazy frame where the
            // background is high.
            if (mean >= brightnessBar) {
                filtered.push(ap);
            }
        }

        return { points: filtered, bestTrackScore };
    }

    /**
     * Prepare alignment data (pure JS, no OpenCV needed)
     * Creates alignment points grid and reference grayscale for template matching.
     *
     * Note: The grayscale data here is 8-bit and used ONLY for alignment (finding dx/dy shifts).
     * The actual frame data used for stacking accumulation remains float32 (16-bit precision).
     * See rgbaToGrayscale() for why 8-bit is sufficient for alignment.
     */
    function prepareAlignmentData(refFrame, surfaceMode = false) {
        // Support both uint8Buffer (new) and float32Buffer (legacy)
        const buffer = refFrame.uint8Buffer || refFrame.float32Buffer;
        const isFloat32 = !refFrame.uint8Buffer && !!refFrame.float32Buffer;
        if (!refFrame || !buffer || !refFrame.width || !refFrame.height) {
            throw new Error('Invalid reference frame');
        }

        const { width, height } = refFrame;

        // Convert RGBA to grayscale
        const refGrayData = rgbaToGrayscale(buffer, width, height, isFloat32);

        // Create AP grid
        const { alignmentPoints, patchSize, searchRadius, spacing } = createAPGrid(width, height, surfaceMode, refGrayData);

        // Filter APs by quality
        // Nudge first: a point that lands on the subject can then be judged on
        // what it actually sees, instead of being rejected for the sky it used
        // to be sitting on.
        const nudged = nudgeApsToBrightness(alignmentPoints, refGrayData, width, height, patchSize, 5);
        // After nudging, so a point pulled toward the subject cannot end up
        // overhanging. Any point that still does not fit is slid in, not lost.
        const slid = clampApsIntoFrame(alignmentPoints, width, height, patchSize);
        const filtered = filterAPsByQuality(alignmentPoints, refGrayData, width, height, patchSize, 0.02, 5);
        const activeAPs = filtered.points.length > 0 ? filtered.points : alignmentPoints;
        apGridTotal = alignmentPoints.length;
        if (nudged || slid) {
            const parts = [];
            if (nudged) parts.push(`${nudged} moved onto the subject`);
            if (slid) parts.push(`${slid} slid in from the frame edge`);
            addLog(`Alignment points: ${parts.join(', ')} (of ${alignmentPoints.length})`);
        }
        measureApLocalizability(activeAPs, refGrayData, width, height, patchSize);
        const localWarp = assessLocalWarp(filtered.points.length, alignmentPoints.length, filtered.bestTrackScore);

        return {
            alignmentPoints: activeAPs,
            refGrayData,
            patchSize,
            searchRadius,
            spacing,
            localWarp,
            width,
            height
        };
    }

    /**
     * Prepare alignment data with pre-computed grayscale (for VNG demosaiced reference)
     * Same as prepareAlignmentData but skips grayscale extraction
     */
    function prepareAlignmentDataWithGray(refGrayData, width, height, surfaceMode = false) {
        // Create AP grid
        const { alignmentPoints, patchSize, searchRadius, spacing } = createAPGrid(width, height, surfaceMode, refGrayData);

        // Filter APs by quality
        // Nudge first: a point that lands on the subject can then be judged on
        // what it actually sees, instead of being rejected for the sky it used
        // to be sitting on.
        const nudged = nudgeApsToBrightness(alignmentPoints, refGrayData, width, height, patchSize, 5);
        // After nudging, so a point pulled toward the subject cannot end up
        // overhanging. Any point that still does not fit is slid in, not lost.
        const slid = clampApsIntoFrame(alignmentPoints, width, height, patchSize);
        const filtered = filterAPsByQuality(alignmentPoints, refGrayData, width, height, patchSize, 0.02, 5);
        const activeAPs = filtered.points.length > 0 ? filtered.points : alignmentPoints;
        apGridTotal = alignmentPoints.length;
        if (nudged || slid) {
            const parts = [];
            if (nudged) parts.push(`${nudged} moved onto the subject`);
            if (slid) parts.push(`${slid} slid in from the frame edge`);
            addLog(`Alignment points: ${parts.join(', ')} (of ${alignmentPoints.length})`);
        }
        measureApLocalizability(activeAPs, refGrayData, width, height, patchSize);
        const localWarp = assessLocalWarp(filtered.points.length, alignmentPoints.length, filtered.bestTrackScore);

        return {
            alignmentPoints: activeAPs,
            refGrayData,
            patchSize,
            searchRadius,
            spacing,
            localWarp,
            width,
            height
        };
    }

    /**
     * Pipelined two-pass GPU stacking
     * Loads frames from file and stacks them concurrently for better performance
     * Instead of: load ALL → then stack ALL
     * Does: load batch → align → stack, while loading next batch
     *
     * Supports both SER files (raw Bayer) and image files (RGBA)
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackWithGpuPipelined(frameMetadata, frameReReader, drizzleScale, addLog, emit, surfaceMode = false) {
        const frameCount = frameMetadata.length;
        resetStackingStats();
        stackingStats.analysisStartTime = frameReReader.analysisStartTime;

        // Detect frameReReader type and extract parameters
        const isSerFile = frameReReader.fileType === 'ser' || frameReReader.header;
        const isImageFile = frameReReader.fileType === 'image' || frameReReader.rgbaFrames;

        // cropWidth/cropHeight are the dimensions the demosaic+crop pass emits.
        // With no crop region (surface mode) they are the full source dimensions,
        // so that pass demosaics and discards nothing. Using srcWidth for both, as
        // this did before, squashed every non-square source into a square.
        let cropWidth, cropHeight, srcWidth, srcHeight, bayerPattern;

        if (isSerFile) {
            const { header, bayerChoice, cropRegion } = frameReReader;
            srcWidth = header.width;
            srcHeight = header.height;
            cropWidth = cropRegion?.size || srcWidth;
            cropHeight = cropRegion?.size || srcHeight;

            // Use direct bayerPattern if available (no-crop mode), otherwise map from bayerChoice
            if (frameReReader.bayerPattern !== undefined) {
                bayerPattern = frameReReader.bayerPattern;
            } else {
                const bayerMap = {
                    // OpenCV uses inverted naming: BG=RGGB, RG=BGGR, GB=GRBG, GR=GBRG
                    'COLOR_BayerBG2RGB': 0, 'COLOR_BayerRG2RGB': 1,
                    'COLOR_BayerGB2RGB': 2, 'COLOR_BayerGR2RGB': 3,
                    'COLOR_BayerBG2RGB_VNG': 0, 'COLOR_BayerRG2RGB_VNG': 1,
                    'COLOR_BayerGB2RGB_VNG': 2, 'COLOR_BayerGR2RGB_VNG': 3,
                    'MONO': -1
                };
                bayerPattern = bayerMap[bayerChoice] ?? -1;
            }
        } else if (isImageFile) {
            srcWidth = frameReReader.srcWidth;
            srcHeight = frameReReader.srcHeight;
            cropWidth = frameReReader.cropRegion?.size || srcWidth;
            cropHeight = frameReReader.cropRegion?.size || srcHeight;
            bayerPattern = -1; // RGBA input, no demosaic
        } else {
            throw new Error('Unknown frameReReader type');
        }

        // Detect 16-bit source: SER files have pixelDepth in header, images are always 8-bit
        // 16-bit sources return float32Buffer from GPU analyze, 8-bit returns uint8Buffer
        const is16bit = isSerFile && frameReReader.header?.pixelDepth > 8;

        addLog(`Pipelined GPU stacking: ${frameCount} frames, ${cropWidth}x${cropHeight}${is16bit ? ' (16-bit)' : ''}`);
        emit('set-caption', 'Initializing GPU workers...');
        cancelled = false; // Reset cancellation flag

        // Initialize GPU workers (no OpenCV worker needed - alignment prep is pure JS)
        const gpuAnalyzeWorker = trackWorker(new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' }));
        const gpuStackWorker = trackWorker(new Worker(workerUrl('/webgpu_stacking_worker.js'), { type: 'module' }));

        try {
            // Init GPU workers in parallel
            await Promise.all([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU analyze worker timeout')), 30000);
                    gpuAnalyzeWorker.onmessage = (e) => {
                        if (!e.data) { clearTimeout(timeout); reject(new Error('GPU worker crashed - try reloading the page')); return; }
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuAnalyzeWorker.postMessage({ type: 'init' });
                }),
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU stack worker timeout')), 10000);
                    gpuStackWorker.onerror = (e) => {
                        clearTimeout(timeout);
                        console.error('GPU stack worker error:', e);
                        reject(new Error(`GPU stack worker load error: ${e.message}`));
                    };
                    gpuStackWorker.onmessage = (e) => {
                        if (!e.data) { clearTimeout(timeout); reject(new Error('GPU worker crashed - try reloading the page')); return; }
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuStackWorker.postMessage({ type: 'init', apSliceLimit: getApSliceLimit() });
                })
            ]);
            attachStackWorkerRelay(gpuStackWorker);
            addLog('GPU workers initialized');

            // Surface mode does not crop, so the output covers the whole frame and the
            // only centre that maps source 1:1 onto output is the exact frame centre.
            // Frames carry the brightness centroid from analysis; feeding that in would
            // offset the window past the frame edge, and the crop shaders clamp per
            // sample, which shows up as a band of repeated edge pixels.
            //
            // Keyed on surfaceMode and NOT on "are we cropping", deliberately. Planetary
            // searches only ±8px (createAPGrid) and has no global drift tracking — the
            // searchOffset path is surface-only — so it relies on the centroid centre to
            // remove gross motion before alignment ever runs. Even in the no-crop
            // planetary fallback, where a full-size window centred on the centroid does
            // overhang and smear, that smear is the price of dragging the planet toward
            // the middle so the 8px search can still find it. Pinning the centre there
            // removes the smear and the alignment along with it.
            const frameCenter = { x: srcWidth / 2, y: srcHeight / 2 };
            const normalizeCenters = (centers) =>
                surfaceMode ? centers.map(() => ({ ...frameCenter })) : centers;

            // Helper to load a batch of frames (SER from file, images from memory)
            async function loadRawBatch(batchFrames) {
                const frames = [];
                const centers = [];

                if (isSerFile) {
                    // Prefer getFrame() when available (works for unified debayer reader, multi-file, etc.)
                    if (frameReReader.getFrame) {
                        // Parallel reads via getFrame
                        const results = await Promise.all(
                            batchFrames.map(frame => frameReReader.getFrame(frame))
                        );
                        for (let i = 0; i < results.length; i++) {
                            const result = results[i];
                            if (result) {
                                const data = frameReReader.header.pixelDepth > 8
                                    ? new Uint16Array(result.frameBuffer)
                                    : new Uint8Array(result.frameBuffer);
                                frames.push({ data, index: batchFrames[i].index });
                                centers.push({ x: result.centerX, y: result.centerY });
                            }
                        }
                    } else {
                        // Legacy path: direct file reads for old SER reader
                        const { file, frameSize, header } = frameReReader;
                        const frameBuffers = await Promise.all(
                            batchFrames.map(frame => {
                                const offset = 178 + (frame.index * frameSize);
                                return file.slice(offset, offset + frameSize).arrayBuffer();
                            })
                        );
                        for (let i = 0; i < frameBuffers.length; i++) {
                            const data = header.pixelDepth > 8
                                ? new Uint16Array(frameBuffers[i])
                                : new Uint8Array(frameBuffers[i]);
                            frames.push({ data, index: batchFrames[i].index });
                            centers.push({ x: batchFrames[i].centerX, y: batchFrames[i].centerY });
                        }
                    }
                } else if (isImageFile) {
                    if (frameReReader.getFrame) {
                        // Parallel reads via getFrame (for images/MJPEG)
                        const results = await Promise.all(
                            batchFrames.map(frame => frameReReader.getFrame(frame.index))
                        );
                        for (let i = 0; i < results.length; i++) {
                            const rgba = results[i];
                            if (rgba) {
                                frames.push({ data: rgba.data, index: batchFrames[i].index });
                                centers.push({ x: batchFrames[i].centerX, y: batchFrames[i].centerY });
                            }
                        }
                    } else if (frameReReader.rgbaFrames) {
                        // Pre-loaded frames - no I/O needed
                        for (const frame of batchFrames) {
                            const rgba = frameReReader.rgbaFrames[frame.index];
                            if (rgba) {
                                frames.push({ data: rgba.data, index: frame.index });
                                centers.push({ x: frame.centerX, y: frame.centerY });
                            }
                        }
                    }
                }

                return { frames, centers: normalizeCenters(centers) };
            }

            // Helper to process batch via GPU analyze worker
            async function processGpuBatch(frames, centers) {
                return new Promise((resolve, reject) => {
                    const requestId = Date.now() + Math.random();
                    const handler = (e) => {
                        if (!e.data) {
                            gpuAnalyzeWorker.removeEventListener('message', handler);
                            reject(new Error('GPU worker crashed - try reloading the page'));
                            return;
                        }
                        if (e.data.requestId !== requestId) return;
                        gpuAnalyzeWorker.removeEventListener('message', handler);
                        if (e.data.type === 'crop-analyze-result') {
                            resolve(e.data.results);
                        } else if (e.data.type === 'crop-analyze-error') {
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuAnalyzeWorker.addEventListener('message', handler);
                    gpuAnalyzeWorker.postMessage({
                        type: 'crop-analyze-batch',
                        frames,
                        srcWidth,
                        srcHeight,
                        cropWidth,
                        cropHeight,
                        centers,
                        bayerPattern,
                        threshold: 0.1,
                        requestId,
                        metadataOnly: false // Get float32 data for stacking
                    });
                });
            }

            // Step 1: Find and load reference frame
            emit('set-caption', 'Loading reference frame...');
            const sortedBySharpness = [...frameMetadata].sort((a, b) => b.sharpness - a.sharpness);
            const topCount = Math.max(1, Math.ceil(sortedBySharpness.length * 0.01));
            const topFrames = sortedBySharpness.slice(0, topCount);
            const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

            let refFrameMeta;
            if (avgCircularity > 0.7) {
                refFrameMeta = topFrames.reduce((best, f) =>
                    (f.circularity || 0) > (best.circularity || 0) ? f : best
                );
            } else {
                refFrameMeta = sortedBySharpness[0];
            }

            // Load reference frame
            const { frames: refFrames, centers: refCenters } = await loadRawBatch([refFrameMeta]);
            const isRawBayer = bayerPattern >= 0;

            let refBuffer, refGrayData, refBlob;

            if (isRawBayer) {
                // Raw Bayer: VNG demosaic + crop via stack worker for consistency with stacked frames
                const refCenter = refCenters[0];

                const vngResult = await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'vng-demosaic-ref-done') {
                            gpuStackWorker.removeEventListener('message', handler);
                            resolve(e.data);
                        } else if (e.data.type === 'vng-demosaic-ref-error') {
                            gpuStackWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'vng-demosaic-ref',
                        bayerData: refFrames[0].data,
                        srcWidth,
                        srcHeight,
                        cropWidth,
                        cropHeight,
                        center: refCenter,
                        bayerPattern,
                        bitDepth: is16bit ? 16 : 8,
                        bayerScale: is16bit ? (65535 / ((1 << (frameReReader.header?.pixelDepth || 16)) - 1)) : 1.0
                    });
                });

                // VNG returns Float32 RGBA (0.0-1.0) and Uint8 grayscale
                refBuffer = new Float32Array(vngResult.rgbaBuffer);
                refGrayData = new Uint8Array(vngResult.grayBuffer);
                refBlob = await float32ToBlob(refBuffer, cropWidth, cropHeight);
            } else {
                // RGBA input: use bilinear from analyze worker
                const refResults = await processGpuBatch(refFrames, refCenters);

                // Validate reference frame was processed successfully
                if (!refResults || refResults.length === 0 || !refResults[0]) {
                    throw new Error('Failed to process reference frame - GPU returned no results');
                }

                const rawRefBuffer = refResults[0].float32Buffer || refResults[0].uint8Buffer;
                if (!rawRefBuffer) {
                    throw new Error('Failed to process reference frame - no pixel buffer returned');
                }
                // GPU analyze worker returns ArrayBuffers, not typed arrays - wrap correctly
                // 16-bit sources return float32Buffer, 8-bit return uint8Buffer
                refBuffer = refResults[0].float32Buffer
                    ? new Float32Array(rawRefBuffer)
                    : new Uint8ClampedArray(rawRefBuffer);
                const refIsFloat = refBuffer instanceof Float32Array;
                refBlob = refIsFloat
                    ? await float32ToBlob(refBuffer, cropWidth, cropHeight)
                    : await uint8ToBlob(refBuffer, cropWidth, cropHeight);
                // Extract grayscale for alignment
                refGrayData = rgbaToGrayscale(refBuffer, cropWidth, cropHeight, refIsFloat);
            }

            const refFrame = {
                ...refFrameMeta,
                float32Buffer: refBuffer instanceof Float32Array ? refBuffer : undefined,
                uint8Buffer: refBuffer instanceof Uint8Array ? refBuffer : undefined,
                width: cropWidth,
                height: cropHeight,
                blob: refBlob
            };
            emit('stacking-started', { referenceFrame: refFrame });
            addLog(`Reference frame loaded: index ${refFrame.index}${isRawBayer ? ' (VNG demosaic)' : ''}`);

            // Step 2: Prepare alignment points (pure JS, no OpenCV)
            emit('set-caption', 'Preparing alignment points...');
            // Both paths now have refGrayData ready, just create AP grid
            const alignmentData = await prepareAlignmentWithReview(() => prepareAlignmentDataWithGray(refGrayData, cropWidth, cropHeight, surfaceMode));
            const { alignmentPoints, patchSize, searchRadius, localWarp } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs`);
            // G3 checkpoint: AP grid ready. In pipelined mode template-matching
            // interleaves with accumulation so there's no separate "matched" step.
            emit('stack-step', 'stack_ap_grid_built');

            // Calculate reference brightness for normalization
            // calcMeanBrightness returns 0-255 scale for both formats
            // For raw Bayer, refBuffer is Float32 from VNG; for RGBA depends on is16bit
            const isRefFloat32 = isRawBayer || is16bit;
            const refBrightness = calcMeanBrightness(refBuffer, cropWidth, cropHeight, isRefFloat32);

            // Step 3: Initialize GPU stacker
            let deviceMaxBatch = Infinity;
            let deviceCanFitFrame = true;
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuStackWorker.removeEventListener('message', handler);
                        if (Number.isFinite(e.data.maxBatch)) deviceMaxBatch = e.data.maxBatch;
                        if (e.data.deviceCanFit === false) deviceCanFitFrame = false;
                        resolve();
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({
                    type: 'init-stacking',
                    width: cropWidth,
                    height: cropHeight,
                    srcWidth,
                    srcHeight,
                    drizzleScale,
                    alignmentPoints,
                    patchSize,
                    refBrightness,
                    minApQuality: effectiveMinApQuality(localWarp),
                    bayerPattern,
                    bitDepth: is16bit ? 16 : 8,
                    bayerScale: is16bit ? (65535 / ((1 << (frameReReader.header?.pixelDepth || 16)) - 1)) : 1.0,
                    pixfrac: drizzleScale > 1 ? getPixfrac() : 1.0
                });
            });
            addLog('GPU stacker initialized');

            // Step 4: Process frames in pipelined batches
            emit('set-caption', 'Stacking...');
            // Dynamic batch size - start aggressive, OOM handling will scale back
            // Lite mode stays conservative for mobile/low-memory devices
            const frameBytes = cropWidth * cropHeight * 16; // Float32 RGBA = 16 bytes/pixel
            const { isLiteMode: checkLiteMode } = useLiteMode();
            const inLiteMode = checkLiteMode();
            const targetBatchMemory = inLiteMode ? (256 * 1024 * 1024) : (512 * 1024 * 1024);
            // targetBatchMemory is a soft budget; deviceMaxBatch is the hard
            // per-buffer cap the GPU will actually enforce. Clamp to the device
            // LAST, and never floor above it.
            //
            // The `Math.max(4, ...)` floor was the bug camera RAW exposed. Crops
            // are capped at min(srcW, srcH), so a ~60MP body (9504×6336) can
            // produce a 6033² crop = 555MB of Float32 RGBA per frame. The memory
            // target correctly computed "0 frames fit in 512MB", the floor
            // overrode it to 4, and demosaicVngCropBatchGpu then asked for
            // 2222MB against a 2048MB maxBufferSize. Every such stack threw at
            // stack_ap_grid_built. Small batches are slow but they complete.
            let effectiveBatchSize = Math.min(
                Math.max(4, Math.min(64, Math.floor(targetBatchMemory / frameBytes))),
                deviceMaxBatch
            );
            if (!deviceCanFitFrame) {
                addLog(`Warning: ${cropWidth}x${cropHeight} frames exceed this GPU's per-buffer limit; stacking one frame at a time`);
            }
            if (effectiveBatchSize < 4) {
                addLog(`Large frames (${cropWidth}x${cropHeight}): GPU allows ${effectiveBatchSize} frame(s) per batch`);
            }
            const totalSharpness = sumSharpness(frameMetadata);
            if (!totalSharpness.usable) {
                addLog(`Sharpness weighting unavailable (all ${frameMetadata.length} frames scored zero); stacking with equal weights.`);
            } else if (totalSharpness.bad > 0) {
                // These get weight 0 and contribute nothing. Silent before, so
                // a 100-frame job could quietly stack 10 frames.
                addLog(`${totalSharpness.bad}/${frameMetadata.length} frames have no usable sharpness score and will not contribute to the stack.`);
            }
            let processedCount = 0;

            // Helper to check for OOM errors
            const isOOMError = (err) => err.message?.includes('Array buffer allocation failed') ||
                err.message?.includes('out of memory') || err.message?.includes('OOM') ||
                err.message?.includes('allocation failed');

            // For surface mode, sort frames by original index for temporal drift tracking
            let framesToProcess = [...frameMetadata];
            if (surfaceMode) {
                framesToProcess.sort((a, b) => (a.index || 0) - (b.index || 0));
                addLog('Surface mode: processing frames in temporal order for drift tracking');
            }

            // Cumulative drift tracking for surface mode
            let cumulativeDrift = { dx: 0, dy: 0 };

            // Pipelining state
            // isRawBayer already defined above for reference frame handling
            let batchStart = 0;
            let nextRawPromise = null;
            let nextDemosaicPromise = null;  // Only used for RGBA path

            while (batchStart < frameCount) {
                const batchEnd = Math.min(batchStart + effectiveBatchSize, frameCount);
                let batchFrames = framesToProcess.slice(batchStart, batchEnd);

                // Load raw data from disk
                let rawBatch;
                const t0Load = performance.now();
                if (nextRawPromise) {
                    rawBatch = await nextRawPromise;
                    if (rawBatch.frames.length > effectiveBatchSize) {
                        rawBatch.frames = rawBatch.frames.slice(0, effectiveBatchSize);
                        rawBatch.centers = rawBatch.centers.slice(0, effectiveBatchSize);
                        batchFrames = batchFrames.slice(0, effectiveBatchSize);
                    }
                } else {
                    rawBatch = await loadRawBatch(batchFrames);
                }
                stackingStats.frameLoadMs.push(performance.now() - t0Load);

                // Prefetch next batch from disk (parallel with current batch processing)
                const nextStart = batchStart + rawBatch.frames.length;
                if (nextStart < frameCount) {
                    const nextEnd = Math.min(nextStart + effectiveBatchSize, frameCount);
                    const nextFramesSlice = framesToProcess.slice(nextStart, nextEnd);
                    nextRawPromise = loadRawBatch(nextFramesSlice);
                } else {
                    nextRawPromise = null;
                }

                // For surface mode, pass searchOffset to shift search region
                const searchOffset = surfaceMode && (cumulativeDrift.dx !== 0 || cumulativeDrift.dy !== 0)
                    ? { dx: cumulativeDrift.dx, dy: cumulativeDrift.dy }
                    : null;

                const batchWeights = batchFrames.map(f => frameWeight(f.sharpness, totalSharpness, frameCount));
                const t0Stack = performance.now();

                if (isRawBayer) {
                    // RAW BAYER PATH: VNG demosaic + stacking all on GPU stack worker
                    // No bilinear demosaic needed - saves GPU transfer and compute

                    // Capture raw frames for comparison video (lazy demosaic on export)
                    for (let i = 0; i < rawBatch.frames.length; i++) {
                        const globalIndex = batchStart + i;
                        capturePreCropFrame(rawBatch.frames[i].data, srcWidth, srcHeight, globalIndex, frameCount, bayerPattern);
                    }

                    // Send to stack worker: VNG demosaic (GPU) → template match → warp+accumulate
                    const fullBayerFrames = rawBatch.frames.map((rawFrame, i) => ({
                        data: rawFrame.data,
                        sharpness: batchFrames[i].sharpness
                    }));

                    await new Promise((resolve, reject) => {
                        const handler = (e) => {
                            if (e.data.type === 'stack-batch-done') {
                                gpuStackWorker.removeEventListener('message', handler);
                                resolve();
                            } else if (e.data.type === 'stack-frame-error') {
                                gpuStackWorker.removeEventListener('message', handler);
                                reject(new Error(e.data.error));
                            }
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'stack-frame-batch',
                            frames: fullBayerFrames,
                            centers: rawBatch.centers,
                            frameWeights: batchWeights,
                            refGrayData,
                            searchRadius,
                            searchOffset
                        });
                    });

                } else {
                    // RGBA PATH (images, MONO): needs bilinear demosaic from analyze worker
                    const t0Demosaic = performance.now();

                    // Get or compute demosaic results
                    let gpuResults;
                    if (nextDemosaicPromise) {
                        const prefetched = await nextDemosaicPromise;
                        gpuResults = prefetched.gpuResults;
                        nextDemosaicPromise = null;
                    } else {
                        gpuResults = await processGpuBatch(rawBatch.frames, rawBatch.centers);
                    }
                    stackingStats.gpuDemosaicMs.push(performance.now() - t0Demosaic);

                    // Prefetch next batch demosaic (parallel with current stacking)
                    if (nextRawPromise) {
                        const nextFramesSlice = framesToProcess.slice(nextStart, Math.min(nextStart + effectiveBatchSize, frameCount));
                        nextDemosaicPromise = nextRawPromise.then(async (nextRaw) => {
                            const results = await processGpuBatch(nextRaw.frames, nextRaw.centers);
                            return { gpuResults: results };
                        });
                    }

                    // Capture for comparison video
                    for (let i = 0; i < gpuResults.length; i++) {
                        const globalIndex = batchStart + i;
                        const frameBuffer = gpuResults[i].float32Buffer || gpuResults[i].uint8Buffer;
                        const isFrameFloat = frameBuffer instanceof Float32Array;
                        const uint8ForCapture = isFrameFloat
                            ? new Uint8Array(float32ToUint8(frameBuffer, cropWidth, cropHeight))
                            : new Uint8Array(frameBuffer);
                        capturePostCropFrame(uint8ForCapture, cropWidth, cropHeight, globalIndex, frameCount);
                    }

                    // Get grayscale for matching
                    const frameGrayDatas = gpuResults.map(r => new Uint8Array(r.packedGrayBuffer || r.grayBuffer));

                    // Template matching
                    const batchShifts = await new Promise((resolve, reject) => {
                        const requestId = batchStart;
                        const handler = (e) => {
                            if (!e.data) {
                                gpuStackWorker.removeEventListener('message', handler);
                                reject(new Error('GPU worker crashed - try reloading the page'));
                                return;
                            }
                            if (e.data.requestId !== requestId) return;
                            gpuStackWorker.removeEventListener('message', handler);
                            if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                            else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'match-templates-batch',
                            requestId,
                            refGrayData,
                            frameGrayDatas,
                            width: cropWidth,
                            height: cropHeight,
                            alignmentPoints,
                            patchSize,
                            searchRadius,
                            searchOffset
                        });
                    });

                    accumulateWarpShifts(batchShifts, searchOffset);

                    // Prepare RGBA frames for stacking
                    const rgbaFrames = gpuResults.map((r, i) => {
                        if (is16bit) {
                            return { rgbaBuffer: new Float32Array(r.float32Buffer), sharpness: batchFrames[i].sharpness };
                        } else {
                            return { rgbaBuffer: new Uint8Array(r.uint8Buffer), sharpness: batchFrames[i].sharpness };
                        }
                    });

                    await new Promise((resolve, reject) => {
                        const handler = (e) => {
                            if (e.data.type === 'stack-batch-done') {
                                gpuStackWorker.removeEventListener('message', handler);
                                resolve();
                            } else if (e.data.type === 'stack-frame-error') {
                                gpuStackWorker.removeEventListener('message', handler);
                                reject(new Error(e.data.error));
                            }
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'stack-frame-batch-rgba',
                            frames: rgbaFrames,
                            shifts: batchShifts,
                            frameWeights: batchWeights
                        });
                    });
                }
                stackingStats.accumulateMs.push(performance.now() - t0Stack);

                processedCount += batchFrames.length;
                const progress = (processedCount / frameCount) * 90;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: processedCount, total: frameCount });

                batchStart = batchEnd;
            }

            // G3 checkpoint: accumulation loop done, finalize is next.
            emit('stack-step', 'stack_accumulated');

            // Step 5: Finalize stacking
            emit('set-caption', 'Finalizing...');
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuStackWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({ type: 'finalize-stacking' });
            });
            // G3 checkpoint: finalized blob back from GPU. If we die between here
            // and stacked-image-ready, it's in the JS post-encode path, not GPU.
            emit('stack-step', 'stack_finalized');

            // Cleanup
            gpuStackWorker.postMessage({ type: 'cleanup' });
            // Print GPU timing summary before terminating
            gpuAnalyzeWorker.postMessage({ type: 'print-gpu-timing' });
            untrackWorker(gpuAnalyzeWorker);
            untrackWorker(gpuStackWorker);
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();

            // Log performance summary
            stackingStats.totalFrames = frameCount;
            logWarpStats();
            logStackingStats();

            addLog(`Stacking complete: ${result.width}x${result.height}`);
            emit('set-caption', 'Stacking complete');

            captureUnstackedImage(result.blob);

            return {
                blob: result.blob,
                float32Data: result.float32Buffer ? new Float32Array(result.float32Buffer) : null,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            untrackWorker(gpuAnalyzeWorker);
            untrackWorker(gpuStackWorker);
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();

            // Check if this is a GPU unavailable error - throw specific error for user choice
            const gpuUnavailableErrors = ['No WebGPU adapter', 'WebGPU not available', 'Device', 'lost'];
            const isGpuUnavailable = gpuUnavailableErrors.some(msg => error.message?.includes(msg));

            if (isGpuUnavailable) {
                addLog(`GPU unavailable: ${error.message}`);
                throw new WebGPUUnavailableError(error.message);
            }

            addLog(`Pipelined stacking error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Stack frames using a web worker for local alignment
     * @param frames - Array of frame objects with float32Buffer (or rgbaBuffer for legacy), width, height, sharpness
     *                 For two-pass mode: frames may have only metadata (sharpness, centerX, centerY) with no buffer
     * @param existingWorker - Optional: reuse an existing initialized worker
     * @param drizzleScale - Output scale factor (1.0 = normal, 1.5 = drizzle)
     * @param useWebGPU - Use WebGPU for stacking
     * @param frameReReader - Optional: two-pass mode - re-read frames on demand instead of using pre-loaded buffers
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackFramesLocally(frames, existingWorker = null, drizzleScale = 1.5, useWebGPU = false, frameReReader = null, surfaceMode = false) {
        emit('set-caption', 'Preparing for stacking...');
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        // TWO-PASS MODE: If frameReReader is provided and frames don't have buffers,
        // use pipelined stacking (load + stack concurrently)
        const hasTwoPassFrames = frames.length > 0 && !frames[0].uint8Buffer && !frames[0].float32Buffer && !frames[0].rgbaBuffer && frameReReader;

        if (hasTwoPassFrames && useWebGPU) {
            // Use pipelined approach: load batch → align → stack, while loading next batch
            // Will throw WebGPUUnavailableError if GPU not available - caller should handle
            return await stackWithGpuPipelined(frames, frameReReader, drizzleScale, addLog, emit, surfaceMode);
        }

        // Filter frames that have valid buffer (uint8Buffer preferred, float32Buffer/rgbaBuffer for legacy) and sharpness
        // DEBUG: Log filtering stats
        const noBuffer = frames.filter(f => !f.uint8Buffer && !f.float32Buffer && !f.rgbaBuffer).length;
        const noWidth = frames.filter(f => !f.width).length;
        const noHeight = frames.filter(f => !f.height).length;
        const noSharpness = frames.filter(f => !f.sharpness || f.sharpness <= 0).length;
        addLog(`Stacker input: ${frames.length} frames, filtering: noBuffer=${noBuffer}, noWidth=${noWidth}, noHeight=${noHeight}, noSharpness=${noSharpness}`);

        const validFrames = frames.filter(f => (f.uint8Buffer || f.float32Buffer || f.rgbaBuffer) && f.width && f.height && f.sharpness > 0);
        addLog(`Stacker: ${validFrames.length} valid frames after filtering`);

        if (validFrames.length === 0) {
            addLog('No valid frames with RGBA data for stacking');
            return null;
        }

        // Select reference frame: for round planets, pick most circular from top 1% sharpest
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);

        // Take top 1% of frames (minimum 1)
        const topCount = Math.max(1, Math.ceil(sortedFrames.length * 0.01));
        const topFrames = sortedFrames.slice(0, topCount);

        // Calculate average circularity to detect planet type
        const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

        let referenceFrame;
        if (avgCircularity > 0.7) {
            // Round planet (Jupiter, Mars, etc.) - pick most circular from top frames
            referenceFrame = topFrames.reduce((best, f) =>
                (f.circularity || 0) > (best.circularity || 0) ? f : best
            );
            addLog(`Round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting most circular reference frame`);
        } else {
            // Non-round (Saturn) or unclear - stick with sharpest
            referenceFrame = sortedFrames[0];
            addLog(`Non-round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting sharpest reference frame`);
        }

        // Ensure reference frame has a blob for preview display
        if (!referenceFrame.blob && referenceFrame.float32Buffer) {
            referenceFrame.blob = await float32ToBlob(referenceFrame.float32Buffer, referenceFrame.width, referenceFrame.height);
        } else if (!referenceFrame.blob && referenceFrame.uint8Buffer) {
            // Create blob from uint8Buffer
            const imageData = new ImageData(new Uint8ClampedArray(referenceFrame.uint8Buffer), referenceFrame.width, referenceFrame.height);
            const canvas = new OffscreenCanvas(referenceFrame.width, referenceFrame.height);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imageData, 0, 0);
            referenceFrame.blob = await canvas.convertToBlob({ type: 'image/png' });
        }
        emit('stacking-started', { referenceFrame });

        const drizzleStr = drizzleScale > 1 ? ` with ${drizzleScale}x drizzle` : '';
        addLog(`Sending ${validFrames.length} frames to stacking worker${drizzleStr}${useWebGPU ? ' (WebGPU)' : ''}`);

        // Prepare frame data - only include cloneable/transferable properties
        // Use uint8Buffer (GPU converts to Float32) - avoids slow JS conversion loops
        const frameData = [];
        for (let i = 0; i < validFrames.length; i++) {
            const f = validFrames[i];
            // Prefer uint8Buffer (new optimized path), fall back to float32Buffer or rgbaBuffer
            let buffer = f.uint8Buffer || f.float32Buffer || f.rgbaBuffer;
            const isUint8 = !!f.uint8Buffer || (!f.float32Buffer && !!f.rgbaBuffer);
            if (buffer && !(buffer instanceof ArrayBuffer)) {
                if (buffer.buffer instanceof ArrayBuffer) {
                    buffer = buffer.buffer;
                } else {
                    console.warn(`Frame ${i}: buffer is not an ArrayBuffer, skipping`);
                    continue;
                }
            }
            if (!buffer || buffer.byteLength === 0) {
                console.warn(`Frame ${i}: buffer is empty or detached, skipping`);
                continue;
            }
            frameData.push({
                uint8Buffer: isUint8 ? buffer : null,
                float32Buffer: isUint8 ? null : buffer,
                isUint8,
                width: f.width,
                height: f.height,
                sharpness: f.sharpness,
                subPixelOffset: { x: f.subPixelOffset?.x || 0, y: f.subPixelOffset?.y || 0 }
            });
        }

        if (frameData.length === 0) {
            addLog('Error: No valid frame buffers for stacking');
            return null;
        }
        addLog(`Prepared ${frameData.length} frames for stacking`);

        // WebGPU path: orchestrate GPU worker directly from main thread
        // Will throw WebGPUUnavailableError if GPU not available - caller should handle
        if (useWebGPU) {
            return await stackWithWebGPU(frameData, drizzleScale, addLog, emit, surfaceMode);
        }

        // CPU path: send everything to unified_analyze_worker
        return await stackWithCPU(frameData, drizzleScale, addLog, emit, surfaceMode);
    }

    /**
     * Stack using WebGPU for template matching (main thread orchestrates)
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackWithWebGPU(frameData, drizzleScale, addLog, emit, surfaceMode = false) {
        const { width, height } = frameData[0];
        resetStackingStats();

        // Step 1: Initialize GPU worker
        addLog('Initializing GPU worker...');
        emit('set-caption', 'Initializing GPU worker...');
        cancelled = false; // Reset cancellation flag

        const gpuWorker = trackWorker(new Worker(workerUrl('/webgpu_stacking_worker.js'), { type: 'module' }));

        try {
            // Init WebGPU worker
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebGPU worker timeout')), 10000);
                gpuWorker.onmessage = (e) => {
                    if (!e.data) { clearTimeout(timeout); reject(new Error('GPU worker crashed - try reloading the page')); return; }
                    if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                    else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                };
                gpuWorker.postMessage({ type: 'init' });
            });
            addLog('WebGPU worker ready');

            // Step 2: Prepare alignment points (pure JS, no OpenCV needed)
            emit('set-caption', 'Preparing alignment points...');

            // Find reference frame (highest sharpness) - only send this one frame
            const refIndex = frameData.reduce((bestIdx, f, idx, arr) =>
                f.sharpness > arr[bestIdx].sharpness ? idx : bestIdx, 0);
            const refFrame = frameData[refIndex];

            // Only clone the reference frame buffer for alignment preparation
            // Prefer uint8Buffer (new optimized path)
            let refBuffer = refFrame.uint8Buffer || refFrame.float32Buffer || refFrame.rgbaBuffer;
            if (!refBuffer) {
                throw new Error('Reference frame has no valid buffer');
            }
            refBuffer = refBuffer.slice(0);
            const isUint8Ref = !!refFrame.uint8Buffer || (!refFrame.float32Buffer && !!refFrame.rgbaBuffer);
            const refFrameData = {
                uint8Buffer: isUint8Ref ? refBuffer : undefined,
                float32Buffer: !isUint8Ref ? refBuffer : undefined,
                width: refFrame.width,
                height: refFrame.height,
                sharpness: refFrame.sharpness
            };

            // Prepare alignment data (pure JS, no OpenCV)
            const alignmentData = await prepareAlignmentWithReview(() => prepareAlignmentData(refFrameData, surfaceMode));
            const { alignmentPoints, refGrayData, patchSize, searchRadius, localWarp } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs, reference frame ${refIndex}`);
            // G3 checkpoint: AP grid ready.
            emit('stack-step', 'stack_ap_grid_built');

            // Step 3: Run template matching on GPU in batches
            emit('set-caption', 'GPU template matching...');
            const frameCount = frameData.length;
            const frameShifts = new Array(frameCount);

            // Calculate batch size based on frame size and memory limits
            // Each frame needs width*height*4 bytes for grayscale float data
            // Start aggressive, OOM handling will scale back if needed
            const frameBytes = width * height * 4;
            const { isLiteMode: checkLiteModeStack } = useLiteMode();
            const inLiteModeStack = checkLiteModeStack();
            const maxBatchMemory = inLiteModeStack ? (256 * 1024 * 1024) : (512 * 1024 * 1024);
            let batchSize = Math.min(128, Math.max(8, Math.floor(maxBatchMemory / frameBytes)));
            addLog(`Using batch size ${batchSize} for GPU template matching${inLiteModeStack ? ' (Lite mode)' : ''}`);

            // Pre-fill reference frame with zero shifts
            frameShifts[refIndex] = alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));

            // Build list of frames to process (excluding reference)
            let framesToProcess = [];
            for (let f = 0; f < frameCount; f++) {
                if (f !== refIndex) {
                    framesToProcess.push(f);
                }
            }

            // Surface mode: sort frames by original index for proper drift tracking
            // Quality selector may pick frames out of temporal order
            if (surfaceMode) {
                framesToProcess.sort((a, b) => {
                    const idxA = frameData[a].index || a;
                    const idxB = frameData[b].index || b;
                    return idxA - idxB;
                });
                addLog('Surface mode: processing frames in temporal order for drift tracking');
            }

            // Surface mode: track cumulative drift across batches
            let cumulativeDrift = { dx: 0, dy: 0 };

            // Process in batches
            let processedCount = 0;
            for (let batchStart = 0; batchStart < framesToProcess.length; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, framesToProcess.length);
                const batchIndices = framesToProcess.slice(batchStart, batchEnd);

                // Convert RGBA to grayscale for template matching
                const t0Gray = performance.now();
                const frameGrayDatas = batchIndices.map(f => {
                    const frame = frameData[f];
                    const buffer = frame.uint8Buffer || frame.float32Buffer || frame.rgbaBuffer;
                    const isFloat32 = !frame.isUint8 && !!frame.float32Buffer;
                    return rgbaToGrayscale(buffer, width, height, isFloat32);
                });
                stackingStats.grayscaleMs.push(performance.now() - t0Gray);

                // Send batch to GPU with searchOffset for drift tracking
                // searchOffset tells GPU to search around expected drifted position while
                // keeping template extraction at original AP positions
                const searchOffset = surfaceMode && (cumulativeDrift.dx !== 0 || cumulativeDrift.dy !== 0)
                    ? { dx: cumulativeDrift.dx, dy: cumulativeDrift.dy }
                    : null;

                const t0Match = performance.now();
                const batchShifts = await new Promise((resolve, reject) => {
                    const requestId = batchStart;
                    const handler = (e) => {
                        if (!e.data) {
                            gpuWorker.removeEventListener('message', handler);
                            reject(new Error('GPU worker crashed - try reloading the page'));
                            return;
                        }
                        if (e.data.requestId !== requestId) return;
                        gpuWorker.removeEventListener('message', handler);
                        if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                        else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'match-templates-batch',
                        requestId,
                        refGrayData,
                        frameGrayDatas,
                        width,
                        height,
                        alignmentPoints,
                        patchSize,
                        searchRadius,
                        searchOffset
                    });
                });
                stackingStats.templateMatchMs.push(performance.now() - t0Match);
                accumulateWarpShifts(batchShifts, searchOffset);

                // Store results at correct indices
                for (let i = 0; i < batchIndices.length; i++) {
                    frameShifts[batchIndices[i]] = batchShifts[i];
                }

                // Surface mode: update cumulative drift from this batch's results
                if (surfaceMode && batchShifts.length > 0) {
                    // Use median of last frame's shifts as the drift update
                    const lastFrameShifts = batchShifts[batchShifts.length - 1];
                    const goodShifts = lastFrameShifts.filter(s => s.quality > 0.3);
                    if (goodShifts.length > 3) {
                        const sortedDx = goodShifts.map(s => s.dx).sort((a, b) => a - b);
                        const sortedDy = goodShifts.map(s => s.dy).sort((a, b) => a - b);
                        const medianIdx = Math.floor(goodShifts.length / 2);
                        cumulativeDrift = {
                            dx: sortedDx[medianIdx],
                            dy: sortedDy[medianIdx]
                        };
                    }
                }

                processedCount += batchIndices.length;
                const progress = 5 + (processedCount / framesToProcess.length) * 45;
                emit('set-caption', `Aligning frames...`);
                emit('update-loading', { progress, current: processedCount, total: framesToProcess.length });
            }

            if (surfaceMode) {
                addLog(`GPU batch alignment complete (total drift: ${cumulativeDrift.dx.toFixed(1)}, ${cumulativeDrift.dy.toFixed(1)} px)`);
            } else {
                addLog('GPU batch alignment complete');
            }
            // G3 checkpoint: template matching done, accumulation next.
            emit('stack-step', 'stack_template_matched');

            // Step 4: GPU Stacking - stream frames in batches to avoid memory issues
            emit('set-caption', 'GPU stacking...');
            addLog('Starting GPU stacking');

            // Calculate total sharpness for weighting
            const totalSharpness = sumSharpness(frameData);
            if (!totalSharpness.usable) {
                addLog(`Sharpness weighting unavailable (all ${frameData.length} frames scored zero); stacking with equal weights.`);
            } else if (totalSharpness.bad > 0) {
                // These get weight 0 and contribute nothing. Silent before, so
                // a 100-frame job could quietly stack 10 frames.
                addLog(`${totalSharpness.bad}/${frameData.length} frames have no usable sharpness score and will not contribute to the stack.`);
            }

            // Calculate reference brightness (refFrame already defined above)
            // calcMeanBrightness returns 0-255 for Uint8, 0-1 for Float32
            const refFrameForBrightness = frameData[refIndex];
            const refBrightnessBuffer = refFrameForBrightness.uint8Buffer || refFrameForBrightness.float32Buffer || refFrameForBrightness.rgbaBuffer;
            const isFloat32Ref = !refFrameForBrightness.isUint8 && !!refFrameForBrightness.float32Buffer;
            let refBrightness = calcMeanBrightness(refBrightnessBuffer, width, height, isFloat32Ref);
            // Convert to 0-255 range if calculated from Float32 data (0-1 range)
            if (isFloat32Ref) {
                refBrightness *= 255;
            }

            // Initialize stacking
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({
                    type: 'init-stacking',
                    width, height, drizzleScale, alignmentPoints, patchSize, refBrightness, minApQuality: effectiveMinApQuality(localWarp),
                    pixfrac: drizzleScale > 1 ? getPixfrac() : 1.0
                });
            });

            // Stream frames in batches
            const stackBatchSize = 20;
            let stackedCount = 0;

            for (let batchStart = 0; batchStart < frameCount; batchStart += stackBatchSize) {
                const batchEnd = Math.min(batchStart + stackBatchSize, frameCount);

                const batchFrames = [];
                const batchShifts = [];
                const batchWeights = [];

                for (let i = batchStart; i < batchEnd; i++) {
                    const frame = frameData[i];
                    // GPU stacker handles both Uint8 and Float32 input (converts Uint8→Float32 on GPU)
                    let rgbaBuffer;
                    if (frame.isUint8 && frame.uint8Buffer) {
                        // Uint8 input - GPU converts to Float32
                        rgbaBuffer = new Uint8Array(frame.uint8Buffer);
                    } else if (frame.float32Buffer) {
                        // Float32 input - pass directly
                        rgbaBuffer = new Float32Array(frame.float32Buffer);
                    }
                    batchFrames.push({
                        rgbaBuffer,
                        sharpness: frame.sharpness
                    });
                    batchShifts.push(frameShifts[i]);
                    batchWeights.push(frameWeight(frame.sharpness, totalSharpness, frameCount));
                }

                const t0Accum = performance.now();
                await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'stack-batch-done') {
                            gpuWorker.removeEventListener('message', handler);
                            resolve();
                        } else if (e.data.type === 'stack-frame-error') {
                            gpuWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'stack-frame-batch-rgba',
                        frames: batchFrames,
                        shifts: batchShifts,
                        frameWeights: batchWeights
                    });
                });
                stackingStats.accumulateMs.push(performance.now() - t0Accum);

                stackedCount = batchEnd;
                const progress = 50 + (stackedCount / frameCount) * 40;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: stackedCount, total: frameCount });
            }

            addLog('GPU stacking complete, preparing image for Post Processor...');
            emit('set-caption', 'Preparing image for Post Processor...');
            emit('update-loading', { progress: 95, current: frameCount, total: frameCount });
            // G3 checkpoint: accumulation done, finalize next.
            emit('stack-step', 'stack_accumulated');

            // Finalize and get result
            const tFinalize = performance.now();
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({ type: 'finalize-stacking' });
            });
            addLog(`Image ready (${((performance.now() - tFinalize) / 1000).toFixed(1)}s)`);
            // G3 checkpoint: finalized blob back from GPU.
            emit('stack-step', 'stack_finalized');

            // Cleanup and terminate
            gpuWorker.postMessage({ type: 'cleanup' });
            untrackWorker(gpuWorker);
            gpuWorker.terminate();

            // Log performance summary
            stackingStats.totalFrames = frameCount;
            logWarpStats();
            logStackingStats();

            addLog(`Stacked image: ${result.width}x${result.height}, ${(result.blob.size / 1024).toFixed(1)} KB`);
            emit('set-caption', 'Stacking complete');

            // Capture unstacked image for comparison export
            captureUnstackedImage(result.blob);

            // Reconstruct Float32Array from transferred buffer
            const float32Data = result.float32Buffer ? new Float32Array(result.float32Buffer) : null;

            // Return full object with blob and float32Data for 16-bit post-processing
            return {
                blob: result.blob,
                float32Data,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            untrackWorker(gpuWorker);
            gpuWorker.terminate();

            // Check if this is a GPU unavailable error - throw specific error for user choice
            const gpuUnavailableErrors = ['No WebGPU adapter', 'WebGPU not available', 'Device', 'lost'];
            const isGpuUnavailable = gpuUnavailableErrors.some(msg => error.message?.includes(msg));

            if (isGpuUnavailable) {
                addLog(`GPU unavailable: ${error.message}`);
                throw new WebGPUUnavailableError(error.message);
            }

            throw error;
        }
    }

    /**
     * Stack using CPU (OpenCV) for template matching
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackWithCPU(frameData, drizzleScale, addLog, emit, surfaceMode = false) {
        cancelled = false; // Reset cancellation flag
        return new Promise((resolve, reject) => {
            addLog('Creating fresh worker for stacking...');
            const worker = trackWorker(new Worker(workerUrl('/unified_analyze_worker.js')));

            const initHandler = (e) => {
                if (!e.data) {
                    worker.removeEventListener('message', initHandler);
                    reject(new Error('Worker crashed - try reloading the page'));
                    return;
                }
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
            worker.postMessage({ type: 'init' });

            function proceedWithStacking() {
                let lastLoggedStage = '';
                const messageHandler = (e) => {
                    if (!e.data) {
                        worker.removeEventListener('message', messageHandler);
                        untrackWorker(worker);
                        worker.terminate();
                        reject(new Error('Worker crashed - try reloading the page'));
                        return;
                    }
                    const { type } = e.data;

                    if (type === 'stack-progress') {
                        emit('set-caption', e.data.stage);
                        emit('update-loading', {
                            progress: e.data.progress,
                            current: Math.round(e.data.progress),
                            total: 100
                        });
                        const stage = e.data.stage;
                        const stagePrefix = stage.replace(/\d+\/\d+/, '').trim();
                        if (stagePrefix !== lastLoggedStage) {
                            lastLoggedStage = stagePrefix;
                            addLog(stage);
                        }
                    }

                    if (type === 'stack-complete') {
                        const { blob, width, height, float32Buffer } = e.data;
                        addLog(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);
                        emit('set-caption', 'Stacking complete');

                        // Capture unstacked image for comparison export
                        captureUnstackedImage(blob);

                        // Reconstruct Float32Array from transferred buffer
                        const float32Data = float32Buffer ? new Float32Array(float32Buffer) : null;

                        worker.removeEventListener('message', messageHandler);
                        untrackWorker(worker);
                        worker.terminate();
                        // Return object with blob and float32Data for 16-bit post-processing
                        resolve({ blob, float32Data, width, height });
                    }

                    if (type === 'stack-error') {
                        addLog(`Stacking error: ${e.data.error}`);
                        emit('set-caption', 'Stacking failed');
                        worker.removeEventListener('message', messageHandler);
                        untrackWorker(worker);
                        worker.terminate();
                        reject(new Error(e.data.error));
                    }
                };

                worker.addEventListener('message', messageHandler);

                // Use Set to deduplicate - same buffer may be referenced by multiple frames
                // Include uint8Buffer, float32Buffer and rgbaBuffer for hybrid mode
                const transferables = [...new Set(
                    frameData.flatMap(f => [f.uint8Buffer, f.float32Buffer, f.rgbaBuffer]).filter(b => b instanceof ArrayBuffer && b.byteLength > 0)
                )];
                worker.postMessage({
                    type: 'stack-frames',
                    frames: frameData,
                    drizzleScale: drizzleScale,
                    surfaceMode: surfaceMode
                }, transferables);
            }
        });
    }

    /**
     * Incremental GPU stacking for Continuous mode
     * Avoids re-processing frames by keeping the accumulator state
     */
    async function stackContinuousLocally(frameMetadata, frameReReader, drizzleScale, useWebGPU, surfaceMode, snapshots, onSnapshot) {
        if (!useWebGPU) {
            throw new Error('Continuous stacking is only supported on WebGPU');
        }
        if (!frameReReader) {
            throw new Error('Continuous stacking requires a frameReReader to re-read frames from disk');
        }

        const frameCount = frameMetadata.length;
        resetStackingStats();
        stackingStats.analysisStartTime = frameReReader.analysisStartTime;

        const isSerFile = frameReReader.fileType === 'ser' || frameReReader.header;
        const isImageFile = frameReReader.fileType === 'image' || frameReReader.rgbaFrames;

        // See stackWithGpuPipelined: no crop region means full-frame output.
        let cropWidth, cropHeight, srcWidth, srcHeight, bayerPattern;
        if (isSerFile) {
            const { header, bayerChoice, cropRegion } = frameReReader;
            srcWidth = header.width;
            srcHeight = header.height;
            cropWidth = cropRegion?.size || srcWidth;
            cropHeight = cropRegion?.size || srcHeight;
            if (frameReReader.bayerPattern !== undefined) {
                bayerPattern = frameReReader.bayerPattern;
            } else {
                const bayerMap = {
                    'COLOR_BayerBG2RGB': 0, 'COLOR_BayerRG2RGB': 1,
                    'COLOR_BayerGB2RGB': 2, 'COLOR_BayerGR2RGB': 3,
                    'MONO': -1
                };
                bayerPattern = bayerMap[bayerChoice] ?? -1;
            }
        } else if (isImageFile) {
            srcWidth = frameReReader.srcWidth;
            srcHeight = frameReReader.srcHeight;
            cropWidth = frameReReader.cropRegion?.size || srcWidth;
            cropHeight = frameReReader.cropRegion?.size || srcHeight;
            bayerPattern = -1;
        }

        const is16bit = isSerFile && frameReReader.header?.pixelDepth > 8;
        addLog(`Incremental GPU stacking: ${frameCount} frames, ${cropWidth}x${cropHeight}`);
        cancelled = false;

        const gpuAnalyzeWorker = trackWorker(new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' }));
        const gpuStackWorker = trackWorker(new Worker(workerUrl('/webgpu_stacking_worker.js'), { type: 'module' }));

        try {
            // Init workers
            await Promise.all([
                new Promise((resolve, reject) => {
                    gpuAnalyzeWorker.onmessage = (e) => { if (e.data.type === 'ready') resolve(); };
                    gpuAnalyzeWorker.postMessage({ type: 'init' });
                }),
                new Promise((resolve, reject) => {
                    gpuStackWorker.onmessage = (e) => { if (e.data.type === 'ready') resolve(); };
                    gpuStackWorker.postMessage({ type: 'init', apSliceLimit: getApSliceLimit() });
                })
            ]);
            attachStackWorkerRelay(gpuStackWorker);

            // Surface mode does not crop, so the crop centre must be the frame centre.
            // Planetary keeps its centroid centres in every case — see the long note on
            // the same guard in stackWithGpuPipelined for why this is keyed on
            // surfaceMode rather than on whether a crop region exists.
            const frameCenter = { x: srcWidth / 2, y: srcHeight / 2 };
            const normalizeCenters = (centers) =>
                surfaceMode ? centers.map(() => ({ ...frameCenter })) : centers;

            // Helper to load batch (reused from stackWithGpuPipelined logic)
            async function loadRawBatch(batchFrames) {
                const frames = [];
                const centers = [];
                if (isSerFile && frameReReader.getFrame) {
                    const results = await Promise.all(batchFrames.map(f => frameReReader.getFrame(f)));
                    for (let i = 0; i < results.length; i++) {
                        if (results[i]) {
                            const data = frameReReader.header.pixelDepth > 8 ? new Uint16Array(results[i].frameBuffer) : new Uint8Array(results[i].frameBuffer);
                            frames.push({ data, index: batchFrames[i].index });
                            centers.push({ x: results[i].centerX, y: results[i].centerY });
                        }
                    }
                } else if (isImageFile && frameReReader.getFrame) {
                    const results = await Promise.all(batchFrames.map(f => frameReReader.getFrame(f.index)));
                    for (let i = 0; i < results.length; i++) {
                        if (results[i]) {
                            frames.push({ data: results[i].data, index: batchFrames[i].index });
                            // Use centers from getFrame() result if available (needed for
                            // pre-cropped in-memory frames), fall back to frame metadata
                            const cx = results[i].centerX ?? batchFrames[i].centerX;
                            const cy = results[i].centerY ?? batchFrames[i].centerY;
                            centers.push({ x: cx, y: cy });
                        }
                    }
                }
                return { frames, centers: normalizeCenters(centers) };
            }

            const isRawBayer = bayerPattern >= 0;

            // Helper to process RGBA batch via GPU analyze worker (crop + grayscale)
            async function processGpuBatch(frames, centers) {
                return new Promise((resolve, reject) => {
                    const requestId = Date.now() + Math.random();
                    const handler = (e) => {
                        if (!e.data) {
                            gpuAnalyzeWorker.removeEventListener('message', handler);
                            reject(new Error('GPU worker crashed'));
                            return;
                        }
                        if (e.data.requestId !== requestId) return;
                        gpuAnalyzeWorker.removeEventListener('message', handler);
                        if (e.data.type === 'crop-analyze-result') resolve(e.data.results);
                        else if (e.data.type === 'crop-analyze-error') reject(new Error(e.data.error));
                    };
                    gpuAnalyzeWorker.addEventListener('message', handler);
                    gpuAnalyzeWorker.postMessage({
                        type: 'crop-analyze-batch',
                        frames,
                        srcWidth, srcHeight, cropWidth, cropHeight, centers,
                        bayerPattern,
                        threshold: 0.1,
                        requestId,
                        metadataOnly: false
                    });
                });
            }

            // Reference frame handling
            const sortedBySharpness = [...frameMetadata].sort((a, b) => b.sharpness - a.sharpness);
            const refFrameMeta = sortedBySharpness[0];
            const { frames: refFrames, centers: refCenters } = await loadRawBatch([refFrameMeta]);

            let refBrightness, refGrayData;

            if (isRawBayer) {
                // VNG demosaic reference
                const vngResult = await new Promise((resolve) => {
                    const handler = (e) => { if (e.data.type === 'vng-demosaic-ref-done') resolve(e.data); };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'vng-demosaic-ref',
                        bayerData: refFrames[0].data,
                        srcWidth, srcHeight, cropWidth, cropHeight, center: refCenters[0],
                        bayerPattern, bitDepth: is16bit ? 16 : 8
                    });
                });
                refBrightness = calcMeanBrightness(vngResult.rgbaBuffer, cropWidth, cropHeight, true);
                refGrayData = new Uint8Array(vngResult.grayBuffer);
            } else {
                // RGBA: crop via analyze worker
                const refResults = await processGpuBatch(refFrames, refCenters);
                const refBuffer = refResults[0].float32Buffer || refResults[0].uint8Buffer;
                const isRefFloat = refBuffer instanceof Float32Array;
                refBrightness = calcMeanBrightness(refBuffer, cropWidth, cropHeight, isRefFloat);
                refGrayData = rgbaToGrayscale(refBuffer, cropWidth, cropHeight, isRefFloat);
            }

            // Prepare alignment points
            const alignmentData = await prepareAlignmentWithReview(() => prepareAlignmentDataWithGray(refGrayData, cropWidth, cropHeight, surfaceMode));
            const { alignmentPoints, patchSize, searchRadius, localWarp } = alignmentData;

            // Init stacking
            let deviceMaxBatch = Infinity;
            await new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data.type !== 'init-stacking-done') return;
                    if (Number.isFinite(e.data.maxBatch)) deviceMaxBatch = e.data.maxBatch;
                    resolve();
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({
                    type: 'init-stacking',
                    width: cropWidth, height: cropHeight, srcWidth, srcHeight, drizzleScale, alignmentPoints, patchSize, refBrightness, bayerPattern, bitDepth: is16bit ? 16 : 8,
                    minApQuality: effectiveMinApQuality(localWarp),
                    pixfrac: drizzleScale > 1 ? getPixfrac() : 1.0
                });
            });

            // Process frames in batches and take snapshots
            // Dynamic batch size based on crop size (same logic as stackWithGpuPipelined)
            const frameBytes = cropWidth * cropHeight * 16; // Float32 RGBA = 16 bytes/pixel
            const targetBatchMemory = 512 * 1024 * 1024;
            // Clamp to the device's per-buffer cap — see stackWithGpuPipelined.
            const batchSize = Math.min(
                Math.max(4, Math.min(64, Math.floor(targetBatchMemory / frameBytes))),
                deviceMaxBatch
            );
            const totalSharpness = sumSharpness(frameMetadata);
            if (!totalSharpness.usable) {
                addLog(`Sharpness weighting unavailable (all ${frameMetadata.length} frames scored zero); stacking with equal weights.`);
            } else if (totalSharpness.bad > 0) {
                // These get weight 0 and contribute nothing. Silent before, so
                // a 100-frame job could quietly stack 10 frames.
                addLog(`${totalSharpness.bad}/${frameMetadata.length} frames have no usable sharpness score and will not contribute to the stack.`);
            }
            let processedCount = 0;

            for (let i = 0; i < frameCount; i += batchSize) {
                if (cancelled) break;

                const batchEnd = Math.min(i + batchSize, frameCount);
                const batchFrames = frameMetadata.slice(i, batchEnd);
                const { frames: rawFrames, centers: batchCenters } = await loadRawBatch(batchFrames);

                const batchWeights = batchFrames.map(f => frameWeight(f.sharpness, totalSharpness, frameCount));

                if (isRawBayer) {
                    // RAW BAYER: VNG demosaic + crop + match + accumulate all on stack worker
                    const transferables = rawFrames.map(f => f.data.buffer).filter(b => b);
                    await new Promise((resolve, reject) => {
                        const handler = (e) => {
                            if (e.data.type === 'stack-batch-done') {
                                gpuStackWorker.removeEventListener('message', handler);
                                resolve();
                            } else if (e.data.type === 'stack-frame-error') {
                                gpuStackWorker.removeEventListener('message', handler);
                                reject(new Error(e.data.error));
                            }
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'stack-frame-batch',
                            frames: rawFrames.map((f, idx) => ({ data: f.data, sharpness: batchFrames[idx].sharpness })),
                            centers: batchCenters,
                            frameWeights: batchWeights,
                            refGrayData, searchRadius
                        }, transferables);
                    });
                } else {
                    // RGBA PATH: crop via analyze worker, then match + accumulate
                    const gpuResults = await processGpuBatch(rawFrames, batchCenters);
                    const frameGrayDatas = gpuResults.map(r => new Uint8Array(r.packedGrayBuffer || r.grayBuffer));

                    // Template matching
                    const batchShifts = await new Promise((resolve, reject) => {
                        const requestId = i;
                        const handler = (e) => {
                            if (!e.data) { gpuStackWorker.removeEventListener('message', handler); reject(new Error('GPU worker crashed')); return; }
                            if (e.data.requestId !== requestId) return;
                            gpuStackWorker.removeEventListener('message', handler);
                            if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                            else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'match-templates-batch',
                            requestId,
                            refGrayData,
                            frameGrayDatas,
                            width: cropWidth, height: cropHeight,
                            alignmentPoints, patchSize, searchRadius
                        });
                    });

                    accumulateWarpShifts(batchShifts);

                    // Accumulate
                    const rgbaFrames = gpuResults.map((r, idx) => {
                        const buf = r.float32Buffer || r.uint8Buffer;
                        return {
                            rgbaBuffer: buf instanceof Float32Array ? new Float32Array(buf) : new Uint8Array(buf),
                            sharpness: batchFrames[idx].sharpness
                        };
                    });
                    await new Promise((resolve, reject) => {
                        const handler = (e) => {
                            if (e.data.type === 'stack-batch-done') { gpuStackWorker.removeEventListener('message', handler); resolve(); }
                            else if (e.data.type === 'stack-frame-error') { gpuStackWorker.removeEventListener('message', handler); reject(new Error(e.data.error)); }
                        };
                        gpuStackWorker.addEventListener('message', handler);
                        gpuStackWorker.postMessage({
                            type: 'stack-frame-batch-rgba',
                            frames: rgbaFrames,
                            shifts: batchShifts,
                            frameWeights: batchWeights
                        });
                    });
                }

                processedCount = batchEnd;
                const currentPct = (processedCount / frameCount) * 100;

                // Check if we need to take a snapshot for any of the requested percentages
                for (const snapPct of snapshots) {
                    const prevPct = ((processedCount - batchFrames.length) / frameCount) * 100;
                    if (currentPct >= snapPct && prevPct < snapPct) {
                        addLog(`Taking snapshot at ${snapPct}%...`);
                        const snapshot = await new Promise((resolve, reject) => {
                            const handler = (e) => {
                                if (e.data.type === 'stack-snapshot-complete') {
                                    gpuStackWorker.removeEventListener('message', handler);
                                    resolve(e.data);
                                } else if (e.data.type === 'snapshot-error') {
                                    gpuStackWorker.removeEventListener('message', handler);
                                    reject(new Error(e.data.error));
                                }
                            };
                            gpuStackWorker.addEventListener('message', handler);
                            gpuStackWorker.postMessage({ type: 'get-stack-snapshot' });
                        });

                        await onSnapshot({
                            percentage: snapPct,
                            frameCount: processedCount,
                            blob: snapshot.blob,
                            float32Data: new Float32Array(snapshot.float32Buffer),
                            width: snapshot.width,
                            height: snapshot.height
                        });
                    }
                }

                emit('update-loading', { progress: (processedCount / frameCount) * 100, current: processedCount, total: frameCount });
            }

            // Finalize
            const finalResult = await new Promise((resolve) => {
                const handler = (e) => { if (e.data.type === 'stack-complete') resolve(e.data); };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({ type: 'finalize-stacking' });
            });

            untrackWorker(gpuAnalyzeWorker);
            untrackWorker(gpuStackWorker);
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();

            logWarpStats();

            return {
                blob: finalResult.blob,
                float32Data: new Float32Array(finalResult.float32Buffer),
                width: finalResult.width,
                height: finalResult.height
            };

        } catch (error) {
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();
            throw error;
        }
    }

    /**
     * Calculate the Tenengrad sharpness metric for a single image buffer
     * Reuses the webgpu_analyze_worker for consistent results with frame ranking
     */
    async function calculateSharpness(buffer, width, height) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(workerUrl('/webgpu_analyze_worker.js'), { type: 'module' });
            
            worker.onmessage = (e) => {
                if (!e.data) {
                    worker.terminate();
                    reject(new Error('Sharpness worker crashed'));
                    return;
                }
                
                if (e.data.type === 'ready') {
                    // Convert Float32 (0-1) to Uint8 (0-255) and compute Grayscale immediately
                    const float32Data = new Float32Array(buffer);
                    const pixelCount = width * height;
                    
                    // Temp buffer for grayscale to avoid per-pixel RGB math in the blur loop
                    const grayBuffer = new Uint8Array(pixelCount);
                    for (let i = 0; i < pixelCount; i++) {
                        const r = float32Data[i * 4];
                        const g = float32Data[i * 4 + 1];
                        const b = float32Data[i * 4 + 2];
                        // Standard Luminance weights: 0.299R + 0.587G + 0.114B
                        grayBuffer[i] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 255);
                    }

                    // Apply a weighted 3x3 Gaussian-like blur to the grayscale channel
                    // Kernel: [1 2 1, 2 4 2, 1 2 1] / 16
                    const analyzedRgba = new Uint8Array(pixelCount * 4);
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            let sum = 0;
                            let weightSum = 0;
                            
                            for (let dy = -1; dy <= 1; dy++) {
                                const ny = y + dy;
                                if (ny < 0 || ny >= height) continue;
                                
                                for (let dx = -1; dx <= 1; dx++) {
                                    const nx = x + dx;
                                    if (nx < 0 || nx >= width) continue;
                                    
                                    // Calculate kernel weight
                                    const kWeight = (dx === 0 && dy === 0) ? 4 : 
                                                   (dx === 0 || dy === 0) ? 2 : 1;
                                    
                                    sum += grayBuffer[ny * width + nx] * kWeight;
                                    weightSum += kWeight;
                                }
                            }
                            
                            const blurredGray = Math.round(sum / weightSum);
                            const idx = (y * width + x) * 4;
                            analyzedRgba[idx] = blurredGray;     // R
                            analyzedRgba[idx + 1] = blurredGray; // G
                            analyzedRgba[idx + 2] = blurredGray; // B
                            analyzedRgba[idx + 3] = 255;         // A
                        }
                    }

                    worker.postMessage({
                        type: 'analyze-batch',
                        frames: [{
                            data: analyzedRgba.buffer,
                            index: 0
                        }],
                        width,
                        height,
                        bayerPattern: -1, 
                        threshold: 0.1,
                        metadataOnly: true
                    }, [analyzedRgba.buffer]);
                }
 else if (e.data.type === 'analyze-result') {
                    worker.terminate();
                    // Results is an array, we sent 1 frame
                    resolve(e.data.results[0]);
                } else if (e.data.type === 'error' || e.data.type === 'init-error') {
                    worker.terminate();
                    reject(new Error(e.data.error || 'Sharpness analysis failed'));
                }
            };

            worker.onerror = (err) => {
                worker.terminate();
                reject(err);
            };

            worker.postMessage({ type: 'init' });
        });
    }

    return { stackFramesLocally, stackContinuousLocally, cancelProcessing, calculateSharpness };
}
