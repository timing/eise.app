// composables/sentryErrorBudget.js
//
// Bounds how many error events one visitor can send to Sentry. Dependency-free
// on purpose so scripts/test-sentry-budget.mjs can import it under plain node
// (same arrangement as gpuConditions.js and libRawCfa.js).
//
// Background: in the 30 days to 2026-09-28, 1,773 of ~5,100 error events came
// from FOUR days. Every other day was zero. They were not a widespread bug but
// single sessions emitting 300-600 events each, against a free-plan quota of
// 5,000/month. One buffer that fails to unmap makes every later operation
// raise its own error, so a single stack can produce hundreds.
//
// The per-call-site caps we already have (3 in useStacker's relay, a few in
// useWebGpuAnalyzeWorker) only bound the bugs we have already met. This bounds
// the ones we have not.

// Per stack attempt. Reset by startNewStackJob() on a genuine new file
// selection, so a user who tries a different file always gets a fresh look
// even though the SPA never reloads between attempts.
export const MAX_ERRORS_PER_ATTEMPT = 10;

// Per pageload, as a backstop against a retry loop: ten attempts at ten events
// each is still 100. Deliberately generous rather than tight, because the
// Electron app runs for hours without ever reloading and going permanently
// blind mid-session would be worse than the quota cost.
export const MAX_ERRORS_PER_PAGELOAD = 100;

let sentThisAttempt = 0;
let sentThisPageload = 0;

/**
 * Start of a genuine new stack attempt. Refills the per-attempt budget; the
 * per-pageload ceiling deliberately survives.
 */
export function resetErrorBudget() {
    sentThisAttempt = 0;
}

/**
 * @returns {{ send: boolean, last: boolean }} `send` false means drop the
 *   event. `last` marks the final event a budget allows, so the caller can tag
 *   it and we can tell "the bug stopped" from "we stopped listening".
 */
export function claimErrorBudget() {
    if (sentThisPageload >= MAX_ERRORS_PER_PAGELOAD) return { send: false, last: false };
    if (sentThisAttempt >= MAX_ERRORS_PER_ATTEMPT) return { send: false, last: false };
    sentThisAttempt++;
    sentThisPageload++;
    return {
        send: true,
        last: sentThisAttempt === MAX_ERRORS_PER_ATTEMPT
            || sentThisPageload === MAX_ERRORS_PER_PAGELOAD,
    };
}

/** Test seam. Not called by app code. */
export function _resetErrorBudgetForTests() {
    sentThisAttempt = 0;
    sentThisPageload = 0;
}
