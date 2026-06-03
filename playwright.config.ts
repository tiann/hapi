import { defineConfig, devices } from '@playwright/test'

const PORT = 5179
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: BASE_URL,
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
                    args: ['--no-sandbox'],
                },
            },
        },
    ],
    webServer: {
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
