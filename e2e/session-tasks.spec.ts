import { expect, test } from '@playwright/test'

test('a checked Claude plan step counts as completed and leaves the active list', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-tasks-fixture.html')
    const tasks = page.locator('summary').filter({ hasText: 'Tasks · 1/2' })
    await expect(tasks).toBeVisible()
    await tasks.click()
    await expect(page.getByText('☐ Implement', { exact: true })).toBeVisible()
    await expect(page.getByText('Inspect')).toHaveCount(0)
    await expect(page.getByText('[ ] Implement')).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/1523-markdown-plan-task-status.png` })
})
