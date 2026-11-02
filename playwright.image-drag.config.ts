import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
    ...base,
    testMatch: '**/composer-image-drag.spec.ts',
    timeout: 60_000,
    projects: [
        ...base.projects!,
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
})
