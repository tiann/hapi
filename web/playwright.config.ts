import { defineConfig, devices } from '@playwright/test'

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH

export default defineConfig({
    testDir: './e2e',
    timeout: 45_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:5173',
        viewport: { width: 1440, height: 900 },
        ...(chromePath
            ? {
                launchOptions: {
                    executablePath: chromePath,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                },
            }
            : {}),
    },
    webServer: {
        command: 'npm run dev',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
})
