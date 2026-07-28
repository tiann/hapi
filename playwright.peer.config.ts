import { defineConfig, devices } from '@playwright/test'

const peerWebUrl = (process.env.HAPI_PEER_WEB_URL ?? '').replace(/\/$/, '')

export default defineConfig({
    testDir: './e2e/peer',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: peerWebUrl || 'http://127.0.0.1:3104',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        ...devices['Desktop Chrome'],
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },
})
