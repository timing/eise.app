import * as Sentry from '@sentry/vue';

export default defineNuxtPlugin(async (nuxtApp) => {
    const router = useRouter();
    const release = useRuntimeConfig().public.sentryRelease;

    Sentry.init({
        app: nuxtApp.vueApp,
        dsn: 'https://334d6e6c9fb38f64b8405f6221dc9984@o4510708370571264.ingest.de.sentry.io/4510708376141904',
        release,
        integrations: [
            Sentry.browserTracingIntegration({ router }),
            Sentry.feedbackIntegration({
                colorScheme: 'dark',
                buttonLabel: 'Feedback',
                submitButtonLabel: 'Send Feedback',
                formTitle: 'Send Feedback',
                messagePlaceholder: 'What went wrong? Or any suggestions?',
                successMessageText: 'Thank you for your feedback!',
                showBranding: false,
                isEmailRequired: true,
            }),
        ],
        tracesSampleRate: 1.0, // 100% of transactions
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,

        // Only report errors in production
        enabled: process.env.NODE_ENV === 'production',
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
