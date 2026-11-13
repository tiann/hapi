import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

test('session and composer pending indicators locate distinct requests', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
    await page.goto('/e2e-fixtures/pending-request-navigation-fixture.html')

    const status = page.getByRole('button', { name: '2 pending requests' })
    await expect(status).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approval required' })).toHaveCount(0)

    const listIndicator = page.locator('[data-session-pending-request-id="question"]').first()
    await expect(listIndicator).toBeVisible()
    await listIndicator.click()
    await expect(page.locator('#last-action')).toHaveText('Located request: question')

    await page.reload()
    await status.click()
    const screenshotDir = process.env.HAPI_SCREENSHOT_DIR
    if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true })
        await page.screenshot({ path: resolve(screenshotDir, 'pending-request-menu.png') })
    }

    await page.getByRole('button').filter({ hasText: 'Awaiting your answer' }).click()
    const card = page.locator('[data-request-card="question"]')
    await expect(page.locator('#last-action')).toHaveText('Located request: question')
    await expect(card).toHaveAttribute('data-selected', 'true')
    await expect(card).toBeInViewport()
    await expect(card.getByText('Which implementation approach should I use?').first()).toBeVisible()

    if (screenshotDir) {
        await page.screenshot({ path: resolve(screenshotDir, 'pending-request-target.png') })
    }
})

test('mobile composer pending menu remains usable without overflow', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/pending-request-navigation-fixture.html')

    await page.getByRole('button', { name: '2 pending requests' }).click()
    const menuBox = await page.getByRole('dialog').boundingBox()
    expect(menuBox).not.toBeNull()
    expect(menuBox!.x).toBeCloseTo(12, 0)
    expect(menuBox!.x + menuBox!.width).toBeCloseTo(378, 0)
    await page.getByRole('button').filter({ hasText: 'Approval required' }).click()

    const card = page.locator('[data-request-card="approval"]')
    await expect(card).toHaveAttribute('data-selected', 'true')
    await expect(card).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const screenshotDir = process.env.HAPI_SCREENSHOT_DIR
    if (screenshotDir) {
        await page.screenshot({ path: resolve(screenshotDir, 'pending-request-mobile.png') })
    }
})
