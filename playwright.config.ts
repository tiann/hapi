import { defineConfig, devices } from '@playwright/test'

const FIXTURE_PORT = 5179
const FIXTURE_BASE_URL = `http://localhost:${FIXTURE_PORT}`

const peerWebUrl = process.env.HAPI_PEER_WEB_URL?.replace(/\/$/, '')
const usePeerStack = Boolean(peerWebUrl)
const baseURL = peerWebUrl ?? FIXTURE_BASE_URL

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
                    args: ['--no-sandbox', '--disable-dev-shm-usage'],
                },
            },
        },
    ],
    webServer: usePeerStack
        ? undefined
        : {
            command: `bun run --cwd web dev -- --port ${FIXTURE_PORT} --strictPort`,
            url: `${FIXTURE_BASE_URL}/e2e-fixtures/scratchlist-fixture.html`,
            timeout: 60_000,
            reuseExistingServer: !process.env.CI,
            stdout: 'ignore',
            stderr: 'pipe',
        },
})
