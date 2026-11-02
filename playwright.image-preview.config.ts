import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
    ...base,
    testMatch: '**/composer-image-preview.spec.ts',
    projects: [
        ...base.projects!,
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
})
