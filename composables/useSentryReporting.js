/**
 * Utility to report caught errors to Sentry while still handling them gracefully
 * Use this for errors that are caught and handled but should still be visible in Sentry
 */

import * as Sentry from '@sentry/vue';

/**
 * Report an error to Sentry with optional context
 * @param {Error} error - The error to report
 * @param {Object} context - Optional context to add to the error
 * @param {string} context.component - Component or function where error occurred
 * @param {string} context.action - What action was being performed
 * @param {string} context.filename - The file being processed
 * @param {string[]} context.logs - Log messages from the session
 * @param {Object} context.extra - Additional data to include
 */
export function reportError(error, context = {}) {
    Sentry.withScope((scope) => {
        if (context.component) {
            scope.setTag('component', context.component);
        }
        if (context.action) {
            scope.setTag('action', context.action);
        }
        if (context.filename) {
            scope.setTag('filename', context.filename);
            // Extract file extension for easier filtering
            const ext = context.filename.split('.').pop()?.toLowerCase();
            if (ext) {
                scope.setTag('file_extension', ext);
            }
        }
        if (context.logs && context.logs.length > 0) {
            // Include last 50 log entries to avoid huge payloads
            const recentLogs = context.logs.slice(-50);
            scope.setContext('session_logs', {
                logs: recentLogs,
                total_log_count: context.logs.length
            });
        }
        if (context.extra) {
            scope.setContext('extra', context.extra);
        }
        Sentry.captureException(error);
    });
}
