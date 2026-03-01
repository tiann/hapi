import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.HAPI_E2E_PORT ?? '3906')
const baseUrl = process.env.HAPI_E2E_BASE_URL ?? `http://127.0.0.1:${port}`
const hapiHome = process.env.HAPI_E2E_HAPI_HOME ?? `/tmp/hapi-playwright-session-sort-${port}`
const cliApiToken = process.env.HAPI_E2E_CLI_TOKEN ?? 'pw-test-token'
const bunBin = process.env.BUN_BIN ?? 'bun'

export default defineConfig({
    testDir: './e2e',
    timeout: 180_000,
    expect: {
        timeout: 20_000
    },
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['github'], ['line']] : 'line',
    use: {
        baseURL: baseUrl,
        trace: 'on-first-retry',
        locale: 'en-US'
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] }
        }
    ],
    webServer: {
        command: `${bunBin} run build && rm -rf "${hapiHome}" && mkdir -p "${hapiHome}" && CLI_API_TOKEN=${cliApiToken} HAPI_HOME="${hapiHome}" HAPI_LISTEN_HOST=127.0.0.1 HAPI_LISTEN_PORT=${port} ${bunBin} run --cwd ../hub src/index.ts`,
        url: `${baseUrl}/health`,
        timeout: 120_000,
        reuseExistingServer: false
    }
})
