import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const runnerIntegration = process.env.HAPI_RUNNER_INTEGRATION === '1'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: runnerIntegration
            ? ['src/runner/runner.integration.test.ts']
            : ['src/**/*.test.ts'],
        exclude: runnerIntegration
            ? []
            : ['src/runner/runner.integration.test.ts'],
        ...(runnerIntegration ? { hookTimeout: 45_000, teardownTimeout: 45_000 } : {}),
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
        env: {
            ...process.env,
        }
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
