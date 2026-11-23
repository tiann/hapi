/**
 * Dedicated, serial project for the runner integration suite.
 *
 * `runner.integration.test.ts` and `lateRunnerWebhook.integration.test.ts`
 * start real detached runner/session process trees against the isolated
 * temporary hub. They must never run inside the default parallel unit-test
 * suite (see the exclude in `vitest.config.ts`); run them explicitly with:
 *
 *   bun run test:integration            # serial runner lifecycle coverage
 *   bun run test:integration:stress     # + the 20-session stress test
 *
 * The files run one after another in a single worker
 * (`fileParallelism: false`) so resource ownership stays unambiguous and the
 * suite-level registry cleanup (see `src/test/processRegistry.ts`) is
 * authoritative.
 */
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: [
            'src/runner/runner.integration.test.ts',
            'src/runner/lateRunnerWebhook.integration.test.ts',
        ],
        globalSetup: './src/test/globalSetup.ts',
        setupFiles: './src/test/setup.ts',
        // Real detached process trees: never parallelize this suite.
        fileParallelism: false,
        // beforeEach starts a real runner (state-file wait can exceed the
        // default 5s hook budget on slow machines); afterEach runs the
        // two-stage cleanup + marker sweep, which can take longer on hosts
        // with slow process teardown.
        testTimeout: 20_000,
        hookTimeout: 60_000,
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
