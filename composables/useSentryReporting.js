/**
 * Utility to report caught errors to Sentry while still handling them gracefully
 * Use this for errors that are caught and handled but should still be visible in Sentry
 */

import * as Sentry from '@sentry/vue';
import { useProcessingState } from './useProcessingState';
import { logs } from './eventBus';

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
