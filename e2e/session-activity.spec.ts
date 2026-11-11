import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

for (const theme of ['light', 'dark', 'oled']) {
    for (const width of [390, 1280]) {
        test(`${theme} at ${width}px: activity, unread, and read transitions`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 })
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto(`/e2e-fixtures/session-activity-fixture.html?theme=${theme}`)
            const row = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) })
            const working = row('Working · all output read')
            const spinner = working.getByTestId('session-activity').locator('svg')
            await expect(spinner).toBeVisible()
            await expect(spinner).toHaveCSS('animation-name', 'spin')
            await expect(working.getByTestId('session-unread')).toHaveCount(0)
            const grey = await spinner.evaluate(el => getComputedStyle(el).color)
            const unreadSpinner = row('Working · unread output').getByTestId('session-activity').locator('svg')
            await expect(unreadSpinner).toBeVisible()
            await expect(unreadSpinner).toHaveCSS('animation-name', 'spin')
            expect(await unreadSpinner.evaluate(el => getComputedStyle(el).color)).not.toBe(grey)
            const dot = row('Finished · unread output').getByTestId('session-unread')
            await expect(dot).toBeVisible()
            const foreground = await row('Finished · unread output').locator('[title="Finished · unread output"]').evaluate(el => getComputedStyle(el).color)
            await expect(dot).toHaveCSS('background-color', foreground)
            await expect(row('Finished · all output read').getByTestId('session-unread')).toHaveCount(0)
            await expect(row('Waiting for permission').getByTestId('session-unread')).toHaveCount(0)
            await expect(row('Waiting for permission').getByTestId('session-activity')).toBeVisible()
            await expect(row('Waiting for permission').locator('[aria-label="pending"], [aria-label="Permission required"]').first()).toBeVisible()
            await expect(row('Background work').getByTestId('session-activity')).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

            if (process.env.HAPI_SCREENSHOT_DIR) {
                await mkdir(process.env.HAPI_SCREENSHOT_DIR, { recursive: true })
                await page.screenshot({ path: resolve(process.env.HAPI_SCREENSHOT_DIR, `${theme}-${width}.png`), fullPage: true })
            }

            await page.evaluate(() => window.activityFixture.patch('running-read', { contentRevision: 3 }))
            await expect(spinner).toHaveCSS('color', await unreadSpinner.evaluate(el => getComputedStyle(el).color))
            await page.evaluate(() => window.activityFixture.read('running-read'))
            await expect(spinner).toHaveCSS('color', grey)
            await page.evaluate(() => window.activityFixture.unread('running-read'))
            await expect(spinner).not.toHaveCSS('color', grey)
            await page.evaluate(() => window.activityFixture.patch('running-read', { thinking: false }))
            await expect(working.getByTestId('session-activity')).toHaveCount(0)
            await expect(working.getByTestId('session-unread')).toBeVisible()
            await page.evaluate(() => window.activityFixture.read('running-read'))
            await expect(working.getByTestId('session-unread')).toHaveCount(0)
            expect(errors).toEqual([])
        })
    }
}

test('keeps the combined indicator in the pinned in-progress layout', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-activity-fixture.html?theme=dark&pinned')
    const row = page.getByRole('button', { name: /^Working · unread output/ })
    await expect(row.getByTestId('session-activity')).toBeVisible()
    await expect(row.getByTestId('session-unread')).toHaveCount(0)
})
