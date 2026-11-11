import { expect, test } from '@playwright/test'

test('keeps the jump-to-bottom button visible while scrolling up', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1')
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    await page.waitForTimeout(3500)
    const viewport = page.locator('.chat-scroll-y')
    const button = page.getByRole('button', { name: 'Scroll to bottom', exact: true })
    await expect(button).toHaveCount(0)
    await viewport.hover()
    await page.mouse.wheel(0, -500)
    await expect(button).toBeVisible()
    await page.mouse.wheel(0, -500)
    await expect(button).toBeVisible()
    if (process.env.HAPI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.HAPI_SCREENSHOT_PATH })
    await button.click()
    await expect(button).toHaveCount(0)
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1)
})
