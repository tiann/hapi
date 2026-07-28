import { defineConfig, devices } from '@playwright/test'

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH

/** Live hub session tests — no Vite; hits HAPI_URL with HAPI_LIVE=1. */
export default defineConfig({
    testDir: './e2e',
    testMatch: 'mermaid-lightbox-session.spec.ts',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1100 },
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
