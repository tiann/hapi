import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
    ...base,
    testMatch: '**/attachment-removal.spec.ts',
    retries: 0,
    timeout: 60_000,
    reporter: 'list',
    outputDir: process.env.HAPI_E2E_ARTIFACT_DIR ?? 'test-results/attachments',
    use: { ...base.use, serviceWorkers: 'block', video: process.env.HAPI_RECORD_E2E ? 'on' : 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 5'] } },
        { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
        ...(process.env.HAPI_TEST_EDGE ? [{ name: 'edge', use: { channel: 'msedge' as const } }] : []),
    ],
})
