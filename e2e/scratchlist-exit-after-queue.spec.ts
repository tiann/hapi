/*
 * Playwright smoke for tiann/hapi#959 — after Send to queue from scratchlist,
 * scratchlist mode must turn off so the operator can continue normal chat.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test, expect } from '@playwright/test'

const SCREENSHOT_PATH = resolve('localdocs/playwright-runs/959-scratchlist-exit-after-queue.png')

async function gotoFixture(page: import('@playwright/test').Page, sessionId: string): Promise<void> {
    await page.goto(`/e2e-fixtures/scratchlist-exit-mode-fixture.html?session=${encodeURIComponent(sessionId)}`)
    await expect(page.getByTestId('scratchlist-mode-toggle')).toBeVisible()
}

test.describe('scratchlist exit after queue send (#959)', () => {
    test('successful promote-to-queue exits scratchlist mode', async ({ page }) => {
        await gotoFixture(page, '959-exit-after-queue')

        // Enter scratchlist mode — drawer mounts, send routing goes amber-ish.
        await page.getByTestId('scratchlist-mode-toggle').click()
        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('scratchlist-drawer')).toBeVisible()
        await expect(page.getByTestId('composer-send-mode')).toHaveAttribute('data-scratchlist-routing', 'active')

        // Seed an entry through the fixture add control.
        await page.getByLabel('Add scratchlist entry').fill('Queue this note from scratchlist')
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(page.getByText('Queue this note from scratchlist')).toBeVisible()

        // Promote to queue — production ScratchlistDrawerHost should exit mode on success.
        await page.getByRole('button', { name: 'Send to queue' }).first().click()
        await expect(page.getByText('Queue this note from scratchlist')).toHaveCount(0)

        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'false')
        await expect(page.getByTestId('scratchlist-drawer')).toHaveCount(0)
        await expect(page.getByTestId('composer-send-mode')).toHaveAttribute('data-scratchlist-routing', 'inactive')

        const harness = await page.evaluate(() => window.__scratchlistExitModeE2E)
        expect(harness?.queuedTexts).toEqual(['Queue this note from scratchlist'])
        expect(harness?.scratchlistMode).toBe(false)

        mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true })
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false })
    })

    test('rejected promote-to-queue keeps scratchlist mode on', async ({ page }) => {
        await gotoFixture(page, '959-keep-mode-on-failure')

        await page.getByTestId('scratchlist-mode-toggle').click()
        await page.getByLabel('Queue send mode').selectOption('failure')
        await page.getByLabel('Add scratchlist entry').fill('This send will fail')
        await page.getByRole('button', { name: 'Add', exact: true }).click()

        await page.getByRole('button', { name: 'Send to queue' }).first().click()
        await expect(page.getByText('This send will fail')).toBeVisible()
        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('scratchlist-drawer')).toBeVisible()
    })
})
