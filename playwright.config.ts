import { defineConfig, devices } from '@playwright/test'
import {
    annotatedVideoUseOption,
    shouldRecordAnnotatedVideo,
} from './scripts/dev/playwright-annotated-video.mjs'

const PORT = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 5179)
const BASE_URL = `http://localhost:${PORT}`

const peerWebUrl = process.env.HAPI_PEER_WEB_URL?.replace(/\/$/, '')
const usePeerStack = Boolean(peerWebUrl)
const baseURL = peerWebUrl ?? BASE_URL

export default defineConfig({
    testDir: './e2e',
    // Peer-stack specs need HAPI_PEER_* + mirror tooling; run via playwright.peer.config.ts only.
    testIgnore: ['**/peer/**'],
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
                    // The CI runner and most sandboxed dev environments
                    // run as root or under restricted user namespaces;
                    // without --no-sandbox chromium silently exits 0 a
                    // few seconds after launch and the page handshake
                    // times out. Keep the flag scoped to launchOptions
                    // so this is the only place a future maintainer has
                    // to revisit if they harden the runner.
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
            // The fixture page mounts ScratchlistPanel in isolation; no hub
            // is required, which is why this dev server doesn't proxy /api.
            command: `bun run --cwd web dev -- --port ${PORT} --strictPort`,
            url: `${BASE_URL}/e2e-fixtures/scratchlist-fixture.html`,
            timeout: 60_000,
            reuseExistingServer: !process.env.CI,
            stdout: 'ignore',
            stderr: 'pipe',
        },
})
