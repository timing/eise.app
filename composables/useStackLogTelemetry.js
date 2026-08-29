// Shared log-tail / log-delta state for stack telemetry.
//
// Module-scope (not per-composable-call): the same cursor and retry queue must
// be visible to app.vue (pings, finished, watchdog failures) AND to FileUploader
// / VideoFrameProcessor (cancels, event-driven failures), so all terminal sites
// can ship a defensive `logs_tail` without plumbing through the event bus.
//
// Semantics:
// - `getLogDelta()` slices [lastLogCursor..logs.length), plus any lines carried
//   over from a previously failed ping, capped at MAX_LOGS_PER_PING (freshest
//   wins on over-cap; oldest reported via `log_dropped`).
// - `handleDeltaAckFailure(delta)` pushes the delta's lines back into
//   `unshippedLines`, so the next ping re-ships them. Call after a ping fetch
//   rejects or returns a non-ok status.
// - `getLogTail(n)` reads logs.value.slice(-n) directly (no cursor state).
//   Called on terminals as belt-and-suspenders context.
// - `resetLogCursor()` is called at stack_start so pre-run logs aren't shipped.

import { useEventBus } from '@/composables/eventBus';

// Was 20 (see MEDIABUNNY_RELIABILITY.md notes on "1 log gap over-cap burst").
// 60 lines × 160 chars ≈ 10 KB, well under the 16 KB server prop cap.
export const MAX_LOGS_PER_PING = 60;
export const MAX_LOG_LINE_CHARS = 160;
export const MAX_LOGS_ON_FAILURE = 50;

let lastLogCursor = 0;
// Lines that were included in a ping delta whose fetch never landed. Prepended
// to the next successful delta. Capped so a run of consecutive failures doesn't
// grow this array unboundedly.
let unshippedLines = [];
const MAX_UNSHIPPED_LINES = 200;

export function useStackLogTelemetry() {
    const { logs } = useEventBus();

    function resetLogCursor() {
        lastLogCursor = logs.value.length;
        unshippedLines = [];
    }

    // Returns { logs, log_cursor, log_total, log_dropped } or null if nothing to
    // ship. Advances lastLogCursor optimistically. Caller MUST invoke
    // handleDeltaAckFailure(delta) if the underlying fetch does not succeed, so
    // the lines get re-tried on the next ping.
    function getLogDelta() {
        const cursor = lastLogCursor;
        const total = logs.value.length;
        const fresh = logs.value
            .slice(cursor)
            .map(l => String(l).slice(0, MAX_LOG_LINE_CHARS));

        // Drain the retry buffer into this ping. Freshest still wins under cap.
        const combined = unshippedLines.concat(fresh);
        unshippedLines = [];

        if (combined.length === 0) return null;

        let sliceStart = 0;
        let dropped = 0;
        if (combined.length > MAX_LOGS_PER_PING) {
            sliceStart = combined.length - MAX_LOGS_PER_PING;
            dropped = sliceStart;
        }
        const shipped = combined.slice(sliceStart);

        lastLogCursor = total;
        return {
            logs: shipped,
            log_cursor: cursor,
            log_total: total,
            log_dropped: dropped,
        };
    }

    // Rollback for a failed ping. Push its shipped lines back into the retry
    // buffer so the next getLogDelta prepends them. Capped to bound growth
    // during extended offline stretches — the freshest MAX_UNSHIPPED_LINES win.
    function handleDeltaAckFailure(delta) {
        if (!delta || !Array.isArray(delta.logs) || delta.logs.length === 0) return;
        const merged = unshippedLines.concat(delta.logs);
        if (merged.length > MAX_UNSHIPPED_LINES) {
            unshippedLines = merged.slice(merged.length - MAX_UNSHIPPED_LINES);
        } else {
            unshippedLines = merged;
        }
    }

    // Belt-and-suspenders tail for terminal events. Shipped even when no delta
    // was outstanding, so a stack_finished / stack_cancelled / stack_failed
    // still carries the pre-terminal log context if pings dropped.
    function getLogTail(n = MAX_LOGS_ON_FAILURE) {
        const total = logs.value.length;
        if (!total) return null;
        return {
            logs_tail: logs.value
                .slice(-n)
                .map(l => String(l).slice(0, MAX_LOG_LINE_CHARS)),
            log_total: total,
        };
    }

    return {
        resetLogCursor,
        getLogDelta,
        handleDeltaAckFailure,
        getLogTail,
    };
}
