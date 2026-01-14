import * as Sentry from '@sentry/vue';

export default defineNuxtPlugin((nuxtApp) => {
    const router = useRouter();

    Sentry.init({
        app: nuxtApp.vueApp,
        dsn: 'https://334d6e6c9fb38f64b8405f6221dc9984@o4510708370571264.ingest.de.sentry.io/4510708376141904',
        integrations: [
            Sentry.browserTracingIntegration({ router }),
        ],
        // Set sample rates
        tracesSampleRate: 0.1, // 10% of transactions for performance monitoring
        replaysSessionSampleRate: 0, // Disable session replay
        replaysOnErrorSampleRate: 0, // Disable replay on error

        // Only report errors in production
        enabled: process.env.NODE_ENV === 'production',
    });
});
