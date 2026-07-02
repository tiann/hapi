import { defineConfig, devices } from '@playwright/test'
import {
    annotatedVideoUseOption,
    shouldRecordAnnotatedVideo,
} from './scripts/dev/playwright-annotated-video.mjs'

const PORT = 5179
const BASE_URL = `http://localhost:${PORT}`

const peerWebUrl = process.env.HAPI_PEER_WEB_URL?.replace(/\/$/, '')
const usePeerStack = Boolean(peerWebUrl)
const baseURL = peerWebUrl ?? BASE_URL

export default defineConfig({
    testDir: './e2e',
    timeout: usePeerStack ? 60_000 : 30_000,
    expect: { timeout: usePeerStack ? 10_000 : 5_000 },
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: shouldRecordAnnotatedVideo()
            ? annotatedVideoUseOption('on', usePeerStack ? { width: 1440, height: 900 } : undefined)
            : 'off',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: usePeerStack
                        ? ['--no-sandbox', '--disable-dev-shm-usage']
                        : ['--no-sandbox'],
                },
            },
        },
    ],
    webServer: usePeerStack
        ? undefined
        : {
            command: `bun run --cwd web dev -- --port ${PORT} --strictPort`,
            url: `${BASE_URL}/e2e-fixtures/scratchlist-fixture.html`,
            timeout: 60_000,
            reuseExistingServer: !process.env.CI,
            stdout: 'ignore',
            stderr: 'pipe',
        },
})
