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
// Pinned by markLogStart() when processFiles knows a new job is beginning.
// resetLogCursor() prefers this value when set so pre-run addLog lines like
// "File: X.mp4" are captured, even though startStackPing runs much later.
// null = not pinned (fall back to "current tip").
let pinnedLogStart = null;
// Lines that were included in a ping delta whose fetch never landed. Prepended
// to the next successful delta. Capped so a run of consecutive failures doesn't
// grow this array unboundedly.
let unshippedLines = [];
const MAX_UNSHIPPED_LINES = 200;

export function useStackLogTelemetry() {
    const { logs } = useEventBus();

    // Pin the cursor at the moment a new job begins. Called from processFiles
    // right after startNewStackJob — before the "File: X.mp4" addLog and every
    // downstream reader log. logs.value never clears across the SPA lifetime,
    // so without this pin, resetLogCursor at startStackPing would set the
    // cursor to logs.value.length (past the filename) and pings would ship
    // nothing pre-run. Cleared by resetLogCursor after use.
    function markLogStart() {
        pinnedLogStart = logs.value.length;
    }

    function resetLogCursor() {
        // Prefer the pinned index so we capture the whole job's log stream from
        // its very first addLog. If nothing pinned (edge cases like the SER
        // color-profile flow that skips processFiles' entry point), fall back
        // to "current tip" — same behavior as before this change.
        lastLogCursor = pinnedLogStart != null ? pinnedLogStart : logs.value.length;
        pinnedLogStart = null;
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
        markLogStart,
        resetLogCursor,
        getLogDelta,
        handleDeltaAckFailure,
        getLogTail,
    };
}
