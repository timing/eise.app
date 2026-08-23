import * as Sentry from '@sentry/vue';

// Skip Sentry entirely for clients that only generate noise:
//   - Headless bots / crawlers (EISE-J8: Sentry feedback widget crashes when document.body isn't ready)
//   - Browsers missing modern JS features Sentry SDK itself uses (EISE-HR: Array.prototype.at on Chrome 87)
//   - Known problematic in-app WebViews (EISE-H8: TikTok/Doubao Chrome 103 WebView)
function shouldSkipSentry() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
    if (/HeadlessChrome|Puppeteer|Playwright|PhantomJS/i.test(ua)) return true;
    if (typeof [].at !== 'function' || typeof ''.matchAll !== 'function') return true;
    if (/BytedanceWebview|Falkon|QtWebEngine/i.test(ua)) return true;
    return false;
}

export default defineNuxtPlugin(async (nuxtApp) => {
    const router = useRouter();
    const release = useRuntimeConfig().public.sentryRelease;

    // Only include the feedback widget when the DOM is ready to receive it.
    // In pre-render / very early load the widget's setupOnce calls appendChild(null) and throws.
    const integrations = [Sentry.browserTracingIntegration({ router })];
    if (typeof document !== 'undefined' && document.body) {
        integrations.push(Sentry.feedbackIntegration({
            colorScheme: 'dark',
            buttonLabel: 'Feedback',
            submitButtonLabel: 'Send Feedback',
            formTitle: 'Send Feedback',
            messagePlaceholder: 'What went wrong? Or any suggestions?',
            successMessageText: 'Thank you for your feedback!',
            showBranding: false,
            isEmailRequired: true,
        }));
    }

    Sentry.init({
        app: nuxtApp.vueApp,
        dsn: 'https://334d6e6c9fb38f64b8405f6221dc9984@o4510708370571264.ingest.de.sentry.io/4510708376141904',
        release,
        integrations,
        tracesSampleRate: 1.0, // 100% of transactions
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,

        // Only report errors in production, and never for bots / unsupported browsers.
        enabled: process.env.NODE_ENV === 'production' && !shouldSkipSentry(),

        // Drop errors that we already surface to the user in-app so they don't
        // dominate the Sentry dashboard.
        //   - abort(OOM): async FFmpeg-WASM pthread abort — handled via the
        //     streamed-extract fallback and shown to the user as a load error.
        //   - SharedArrayBuffer missing: known browser capability gap — user
        //     sees the "browser can't run FFmpeg" alternatives UI.
        //   - pthread sent an error: same underlying FFmpeg worker failure.
        beforeSend(event, hint) {
            const err = hint?.originalException;
            const msg = (err && (err.message || String(err))) || event?.message || '';
            if (typeof msg !== 'string') return event;
            if (/abort\(OOM\)|pthread sent an error/i.test(msg)) return null;
            if (/SharedArrayBuffer is not defined|Can't find variable: SharedArrayBuffer/i.test(msg)) return null;
            if (err && err.name === 'FFmpegUnsupportedError') return null;
            return event;
        },
    });

    // Set WebGPU support tag
    const hasWebGPU = !!navigator.gpu;
    Sentry.setTag('webgpu_support', hasWebGPU ? 'yes' : 'no');

    // Try to get adapter info for more detail
    if (hasWebGPU) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                Sentry.setTag('webgpu_adapter', 'available');
            } else {
                Sentry.setTag('webgpu_adapter', 'no_adapter');
            }
        } catch (e) {
            Sentry.setTag('webgpu_adapter', 'error');
        }
    }
});
