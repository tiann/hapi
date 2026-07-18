import { defineConfig, devices } from '@playwright/test'

const port = 4178
const apiPort = 4179

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    workers: 1,
    timeout: 90_000,
    expect: {
        timeout: 5_000,
    },
    reporter: [['list']],
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: [
        {
            command: 'bun run ../hub/scripts/message-window-e2e-server.ts',
            env: { HAPI_E2E_API_PORT: `${apiPort}` },
            url: `http://127.0.0.1:${apiPort}/api/__e2e/health`,
            reuseExistingServer: false,
            timeout: 120_000,
        },
        {
            command: `bun run dev --host 127.0.0.1 --port ${port}`,
            env: { VITE_HUB_PROXY: `http://127.0.0.1:${apiPort}` },
            url: `http://127.0.0.1:${port}/e2e/fixtures/message-window.html`,
            reuseExistingServer: false,
            timeout: 120_000,
        },
    ],
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
})
