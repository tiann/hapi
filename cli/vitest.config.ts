import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        exclude: [
            // Runner integration tests spawn real detached runner/session
            // process trees and must run serially through the dedicated
            // integration project (`bun run test:integration`, see
            // vitest.integration.config.ts), not inside the parallel
            // unit-test suite.
            '**/runner.integration.test.ts',
        ],
        globalSetup: './src/test/globalSetup.ts',
        setupFiles: './src/test/setup.ts',
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
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
