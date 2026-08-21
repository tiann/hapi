/*
 * Playwright regression for the simplified scratchlist drawer. The old
 * promote-to-queue row action was intentionally removed; editing now starts
 * by clicking the entry text.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test, expect } from '@playwright/test'

const SCREENSHOT_PATH = resolve('localdocs/playwright-runs/959-scratchlist-exit-after-queue.png')

async function gotoFixture(page: import('@playwright/test').Page, sessionId: string): Promise<void> {
    await page.goto(`/e2e-fixtures/scratchlist-exit-mode-fixture.html?session=${encodeURIComponent(sessionId)}`)
    await expect(page.getByTestId('scratchlist-mode-toggle')).toBeVisible()
}

test.describe('scratchlist drawer inline editing', () => {
    test('removes send/promote actions and edits the row text in place', async ({ page }) => {
        await gotoFixture(page, 'scratchlist-inline-edit')

        await page.getByTestId('scratchlist-mode-toggle').click()
        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
        const drawer = page.getByTestId('scratchlist-drawer')
        await expect(drawer).toBeVisible()
        await expect(page.getByTestId('composer-send-mode')).toHaveAttribute('data-scratchlist-routing', 'active')

        const drawerBox = await drawer.boundingBox()
        const noteIconBox = await drawer.getByTestId('scratchlist-note-icon').boundingBox()
        const questionIconBox = await drawer.getByTestId('scratchlist-question-icon').boundingBox()
        expect(drawerBox).not.toBeNull()
        expect(noteIconBox).not.toBeNull()
        expect(questionIconBox).not.toBeNull()
        const leftInset = noteIconBox!.x - drawerBox!.x
        const rightInset = drawerBox!.x + drawerBox!.width - (questionIconBox!.x + questionIconBox!.width)
        expect(Math.abs(leftInset - rightInset)).toBeLessThan(0.01)

        const help = page.getByRole('button', { name: 'Show scratchlist usage tips' })
        const tooltip = page.getByRole('tooltip', { hidden: true })
        await expect(page.getByText('held — not sent', { exact: true })).toHaveCount(0)
        await expect(help).toHaveAttribute('aria-expanded', 'false')
        await help.click()
        await expect(help).toHaveAttribute('aria-expanded', 'true')
        await expect(tooltip).toContainText('Use the composer below to add a draft.')

        await page.getByLabel('Add scratchlist entry').fill('Edit this note')
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Send to queue' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Copy into composer' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Move entry up' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Move entry down' })).toHaveCount(0)

        await page.getByTestId('scratchlist-entry-text').click()
        const editor = page.getByRole('textbox', { name: 'Edit scratchlist entry' })
        await editor.fill('Edited in place')
        await editor.press('Enter')
        await expect(page.getByTestId('scratchlist-entry-text')).toHaveText('Edited in place')
        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'true')

        mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true })
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false })
    })

    test('opens row actions from the PC context menu and deletes without confirmation', async ({ page }) => {
        await gotoFixture(page, 'scratchlist-row-actions')

        await page.getByTestId('scratchlist-mode-toggle').click()
        await page.getByLabel('Add scratchlist entry').fill('Confirm this deletion')
        await page.getByRole('button', { name: 'Add', exact: true }).click()

        const row = page.getByTestId('scratchlist-entry')
        await row.click({ button: 'right' })
        await expect(page.getByRole('menu')).toBeVisible()
        await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
        await expect(page.getByRole('menuitem', { name: 'Delete entry' })).toBeVisible()

        await page.getByRole('menuitem', { name: 'Delete entry' }).click()
        await expect(page.getByTestId('scratchlist-entry')).toHaveCount(0)
    })

    test('long-press drag reorders rows in the drawer', async ({ page }) => {
        await gotoFixture(page, 'scratchlist-long-press')

        await page.getByTestId('scratchlist-mode-toggle').click()
        for (const text of ['First note', 'Second note', 'Third note']) {
            await page.getByLabel('Add scratchlist entry').fill(text)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
        }

        const rows = page.getByTestId('scratchlist-entry')
        const source = rows.nth(0)
        const destination = rows.nth(2)
        const sourceBox = await source.boundingBox()
        const destinationBox = await destination.boundingBox()
        expect(sourceBox).not.toBeNull()
        expect(destinationBox).not.toBeNull()
        await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
        await page.mouse.down()
        await page.waitForTimeout(550)
        await page.mouse.move(destinationBox!.x + destinationBox!.width / 2, destinationBox!.y + destinationBox!.height / 2)
        await page.mouse.up()

        await expect(rows.nth(0)).toContainText('Second note')
        await expect(rows.nth(1)).toContainText('First note')
        await expect(rows.nth(2)).toContainText('Third note')
        await expect(page.getByTestId('scratchlist-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('scratchlist-drawer')).toBeVisible()
    })

    test('keeps row geometry stable when the scrollbar appears', async ({ page }) => {
        for (const [width, height] of [[1280, 800], [390, 844]] as const) {
            await page.setViewportSize({ width, height })
            await gotoFixture(page, `scratchlist-scroll-${width}`)

            await page.getByTestId('scratchlist-mode-toggle').click()
            for (let index = 0; index < 6; index += 1) {
                await page.getByLabel('Add scratchlist entry').fill('@')
                await page.getByRole('button', { name: 'Add', exact: true }).click()
            }

            const viewport = page.getByTestId('scratchlist-scroll-viewport')
            const firstRow = page.getByTestId('scratchlist-entry').first()
            await expect(firstRow).toBeVisible()
            const before = await firstRow.boundingBox()
            expect(before).not.toBeNull()

            await page.getByLabel('Add scratchlist entry').fill('@')
            await page.getByRole('button', { name: 'Add', exact: true }).click()
            await expect(page.getByTestId('scratchlist-entry')).toHaveCount(7)
            await expect.poll(async () => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

            const after = await firstRow.boundingBox()
            expect(after).not.toBeNull()
            expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(0.5)
            expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(0.5)

            const visibleGeometry = await viewport.evaluate((element) => {
                const row = element.querySelector<HTMLElement>('[data-testid="scratchlist-entry"]')
                if (!row) return null
                const viewportRect = element.getBoundingClientRect()
                const rowRect = row.getBoundingClientRect()
                return {
                    rowLeft: rowRect.left,
                    rowRight: rowRect.right,
                    viewportLeft: viewportRect.left,
                    viewportClientRight: viewportRect.left + element.clientWidth,
                }
            })
            expect(visibleGeometry).not.toBeNull()
            expect(Math.abs(visibleGeometry!.rowLeft - visibleGeometry!.viewportLeft)).toBeLessThanOrEqual(0.5)
            expect(visibleGeometry!.rowRight).toBeLessThanOrEqual(visibleGeometry!.viewportClientRight + 0.5)

            const drawerGeometry = await page.getByTestId('scratchlist-drawer').evaluate((element) => {
                const drawerRect = element.getBoundingClientRect()
                const row = element.querySelector<HTMLElement>('[data-testid="scratchlist-entry"]')
                if (!row) return null
                const rowRect = row.getBoundingClientRect()
                return {
                    leftInset: rowRect.left - drawerRect.left,
                    rightInset: drawerRect.right - rowRect.right,
                }
            })
            expect(drawerGeometry).not.toBeNull()
            expect(Math.abs(drawerGeometry!.leftInset - drawerGeometry!.rightInset)).toBeLessThanOrEqual(0.5)
        }
    })
})
