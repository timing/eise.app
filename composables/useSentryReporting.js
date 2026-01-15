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
        if (context.extra) {
            scope.setContext('extra', context.extra);
        }
        Sentry.captureException(error);
    });
}
