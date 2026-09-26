import { defineConfig, devices } from '@playwright/test'

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH

/** Live Hub session-content-search tests — no Vite; hits HAPI_URL with HAPI_LIVE=1. */
export default defineConfig({
    testDir: './e2e',
    testMatch: 'session-content-search-jump.spec.ts',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        ...(chromePath
            ? {
                launchOptions: {
                    executablePath: chromePath,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                },
            }
            : {}),
    },
})
