/*
 * Playwright smoke for issue #954 — markdown Source | Preview toggle in
 * the session file pane. Drives the Vite fixture that mounts the same
 * MarkdownRenderer + toggle affordance as production `file.tsx`.
 */

import { test, expect } from '@playwright/test'
import path from 'node:path'

const SCREENSHOT_PATH = path.resolve(
    process.env.HOME ?? '',
    'coding/hapi/localdocs/playwright-runs/954-file-md-preview.png'
)

test.describe('file markdown preview e2e', () => {
    test('preview renders heading and table; source shows raw markdown', async ({ page }) => {
        await page.goto('/e2e-fixtures/file-md-preview-fixture.html')
        await expect(page.getByTestId('file-md-preview-fixture')).toBeVisible()

        await expect(page.getByRole('heading', { name: 'Teams and channels' })).toBeVisible()
        await expect(page.getByRole('cell', { name: 'general' })).toBeVisible()

        await page.getByTestId('markdown-mode-source').click()
        await expect(page.getByTestId('markdown-source-view')).toContainText('# Teams and channels')
        await expect(page.getByRole('heading', { name: 'Teams and channels' })).toHaveCount(0)

        await page.getByTestId('markdown-mode-preview').click()
        await expect(page.getByRole('heading', { name: 'Teams and channels' })).toBeVisible()

        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true })
    })
})
