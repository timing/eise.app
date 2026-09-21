/**
 * Utility to report caught errors to Sentry while still handling them gracefully
 * Use this for errors that are caught and handled but should still be visible in Sentry
 */

import * as Sentry from '@sentry/vue';
import { useProcessingState } from './useProcessingState';
import { useTracking } from './useTracking';
import { classifyGpuCondition } from './gpuConditions';
import { logs } from './eventBus';

/**
 * Error for invalid user input (e.g. incompatible file selection). Not sent to Sentry.
 * `details` can carry structured info (e.g. { mismatchedFileNames: [...] }) so the UI can
 * highlight or offer inline recovery.
 */
export class UserError extends Error {
    constructor(message, details = null) {
        super(message);
        this.name = 'UserError';
        this.details = details;
    }
}

// One analytics event per condition kind per page session. Without this cap we
// would just move the firehose from Sentry to our own beacon: a cascade fires
// hundreds of times in a single stack. First occurrence carries the most
// diagnostic message (the root), so that is the one we keep.
const trackedGpuConditions = new Set();

function trackGpuCondition(kind, message, context) {
    if (trackedGpuConditions.has(kind)) return;
    trackedGpuConditions.add(kind);
    try {
        const { track } = useTracking();
        track('gpu_condition', {
            kind,
            // Kept long enough to preserve the dimensions the guard messages
            // embed (buffer name, MB, device limits, frame size).
            message: String(message).slice(0, 300),
            component: context.component || null,
            action: context.action || null,
        });
    } catch (_) {
        // Analytics must never break the caller's error handling.
    }
}

/**
 * Report an error to Sentry with optional context
 * @param {Error} error - The error to report
 * @param {Object} context - Optional context to add to the error
 * @param {string} context.component - Component or function where error occurred
 * @param {string} context.action - What action was being performed
 * @param {string} context.filename - The file being processed (auto-fetched if not provided)
 * @param {string[]} context.logs - Log messages from the session (auto-fetched if not provided)
 * @param {Object} context.extra - Additional data to include
 */
export function reportError(error, context = {}) {
    if (error instanceof UserError) return;

    // Expected GPU conditions go to analytics instead of Sentry. Routing here
    // rather than in beforeSend means every existing reportError call site is
    // covered at once, and the event still gets counted.
    const gpuCondition = classifyGpuCondition(error?.message || String(error || ''));
    if (gpuCondition) {
        trackGpuCondition(gpuCondition, error?.message || error, context);
        return;
    }

    // Auto-fetch filename from processing state if not provided
    const { getInputFilename } = useProcessingState();
    const filename = context.filename || getInputFilename();

    // Auto-fetch logs from eventBus if not provided
    const sessionLogs = context.logs || logs.value;

    Sentry.withScope((scope) => {
        if (context.component) {
            scope.setTag('component', context.component);
        }
        if (context.action) {
            scope.setTag('action', context.action);
        }
        if (filename) {
            scope.setTag('input_file', filename);
            // Extract file extension for easier filtering
            const ext = filename.split('.').pop()?.toLowerCase();
            if (ext) {
                scope.setTag('file_extension', ext);
            }
        }
        if (sessionLogs && sessionLogs.length > 0) {
            // Include last 50 log entries to avoid huge payloads
            const recentLogs = sessionLogs.slice(-50);
            scope.setContext('session_logs', {
                logs: recentLogs,
                total_log_count: sessionLogs.length
            });
        }
        if (context.extra) {
            scope.setContext('extra', context.extra);
        }
        Sentry.captureException(error);
    });
}
