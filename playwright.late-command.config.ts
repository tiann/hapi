import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({ ...base,
    testMatch: ['late-codex-command-results.spec.ts'],
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--no-sandbox'] } } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ]
})
