import { defineConfig } from 'vitest/config'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

import dotenv from 'dotenv'

const testEnv = dotenv.config({
    path: '.env.integration-test'
}).parsed

const defaultIsolatedHome = join(
    tmpdir(),
    `zs-integration-test-${process.pid}-${process.cwd().replace(/[\\/]/g, '_')}`
)

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts'],
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
            ...testEnv,
            ZS_HOME: process.env.ZS_HOME || testEnv?.ZS_HOME || defaultIsolatedHome,
        },
        alias: {
            // Mock bun-pty for test environment (vitest runs in Node.js, not Bun)
            // bun-pty depends on bun:ffi which is not available in Node.js
            'bun-pty': resolve('./src/__mocks__/bun-pty.ts'),
        }
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
