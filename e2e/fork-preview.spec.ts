/*
 * End-to-end coverage for the fork preview confirm dialog. Drives the
 * production ForkPreviewDialog via the standalone fixture page (no hub):
 * the stub harness on `window.__forkPreviewE2E` counts cancel/confirm
 * callbacks, standing in for the real fork API call.
 */

import { expect, test, type Page } from '@playwright/test'

async function openFixture(page: Page): Promise<void> {
    await page.goto('/e2e-fixtures/fork-preview-fixture.html')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
}

test('shows the kept turns above the fork boundary and the new-session start below', async ({ page }) => {
    await openFixture(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('first question about pagination')).toBeVisible()
    await expect(dialog.getByText('second question about forking')).toBeVisible()
    await expect(dialog.getByTestId('fork-preview-boundary')).toBeVisible()
    await expect(dialog.getByTestId('fork-preview-boundary-message')).toContainText('third question')
})

test('cancel closes the dialog without confirming the fork', async ({ page }) => {
    await openFixture(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const harness = await page.evaluate(() => window.__forkPreviewE2E)
    expect(harness?.cancelled).toBe(1)
    expect(harness?.confirmed).toBe(0)
})

test('confirm runs the fork and closes the dialog', async ({ page }) => {
    await openFixture(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('fork-preview-confirm').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const harness = await page.evaluate(() => window.__forkPreviewE2E)
    expect(harness?.confirmed).toBe(1)
    expect(harness?.cancelled).toBe(0)
})

test('localizes the dialog in Chinese', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'zh-CN'))
    await openFixture(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '从这里开始一个新会话' })).toBeVisible()
    await expect(dialog.getByText('↑ 会复制到新会话中')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '在此分叉' })).toBeVisible()
})
