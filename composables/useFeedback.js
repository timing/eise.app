import * as Sentry from '@sentry/vue';
import { logs } from './eventBus';
import { useProcessingState } from './useProcessingState';

// Track if feedback has been shown this session (per page view)
let feedbackShownThisSession = false;

/**
 * Composable for triggering Sentry feedback modal
 */
export function useFeedback() {
    /**
     * Open the feedback modal programmatically
     * @param {Object} options - Optional configuration
     * @param {string} options.formTitle - Title for the feedback form
     * @param {string} options.messagePlaceholder - Placeholder text
     */
    async function openFeedback(options = {}) {
        const feedback = Sentry.getFeedback();
        if (!feedback) {
            console.warn('Sentry feedback not available');
            return;
        }

        // Attach session logs and filename as context before opening feedback
        const { getInputFilename } = useProcessingState();
        const filename = getInputFilename();
        if (filename) {
            Sentry.setTag('input_file', filename);
        }
        if (logs.value && logs.value.length > 0) {
            Sentry.setContext('session_logs', {
                logs: logs.value.slice(-50),
                total_log_count: logs.value.length
            });
        }

        try {
            const form = await feedback.createForm({
                formTitle: options.formTitle || 'Send Feedback',
                messagePlaceholder: options.messagePlaceholder || 'How was your experience? Any issues or suggestions?',
            });
            form.appendToDom();
            form.open();
        } catch (e) {
            console.warn('Failed to open feedback form:', e);
        }
    }

    /**
     * Open feedback after a successful download (only once per session)
     */
    async function openFeedbackAfterDownload() {
        if (feedbackShownThisSession) return;
        feedbackShownThisSession = true;

        // Small delay so user sees the download started
        setTimeout(() => {
            openFeedback({
                formTitle: 'How was your result?',
                messagePlaceholder: 'Happy with the output? Any issues or suggestions for improvement?',
            });
        }, 1500);
    }

    /**
     * Reset the feedback shown flag (e.g., when starting a new stack)
     */
    function resetFeedbackShown() {
        feedbackShownThisSession = false;
    }

    return {
        openFeedback,
        openFeedbackAfterDownload,
        resetFeedbackShown,
    };
}
