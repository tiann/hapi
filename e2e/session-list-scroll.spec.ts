import { expect, test } from '@playwright/test'

for (const nativeAnchoring of [true, false]) {
    test.describe(`native scroll anchoring: ${nativeAnchoring}`, () => {
        test.beforeEach(async ({ page }) => {
            if (!nativeAnchoring) {
                await page.addInitScript(() => {
                    const style = document.createElement('style')
                    style.textContent = '* { overflow-anchor: none !important; }'
                    document.addEventListener('DOMContentLoaded', () => document.head.append(style))
                })
            }
        })

        test('keeps the visible session in place across background pin and activity changes', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-list-scroll-fixture.html')
            const row = page.getByRole('button', { name: /^Session 20 / })
            await row.waitFor()
            await row.evaluate(element => element.scrollIntoView({ block: 'center' }))
            const before = (await row.boundingBox())!.y
            for (const patch of [
                { pinned: false, active: true, thinking: true },
                { thinking: false },
                { active: false },
                { globalPinned: true },
                { globalPinned: false, pinned: true },
            ]) {
                await page.evaluate(patch => window.updateSession('session-0', patch), patch)
                await page.waitForTimeout(350) // Include directory collapse transitions and native anchoring.
                expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThan(2)
            }
        })

        test('keeps a neighboring row in place when the first visible project moves to pinned', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-list-scroll-fixture.html')
            const row = page.getByRole('button', { name: /^Session 20 / })
            await row.waitFor()
            await page.locator('[title="/project-19"]').evaluate(element => element.scrollIntoView({ block: 'start' }))
            const before = (await row.boundingBox())!.y
            await page.evaluate(() => window.updateSession('session-19', { pinned: false, active: true, thinking: true }))
            await page.waitForTimeout(350)
            expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThan(2)
        })

        test('does not follow a visible project when unpinning moves it to the bottom', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-list-scroll-fixture.html')
            const row = page.getByRole('button', { name: /^Session 20 / })
            await row.waitFor()
            await page.locator('[title="/project-19"]').evaluate(element => element.scrollIntoView({ block: 'start' }))
            const before = (await row.boundingBox())!.y
            await page.evaluate(() => window.updateSession('session-19', { pinned: false }))
            await page.waitForTimeout(350)
            expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThan(2)
        })

        test('preserves the viewport when a project automatically collapses after unpinning', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-list-scroll-fixture.html?mixed')
            const row = page.getByRole('button', { name: /^Session 20 / })
            await row.waitFor()
            await row.evaluate(element => element.scrollIntoView({ block: 'center' }))
            const before = (await row.boundingBox())!.y
            await page.evaluate(() => window.updateSession('session-0', { pinned: false }))
            await page.waitForTimeout(350)
            expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThan(2)
        })

        test('preserves collapsed project headers and respects subsequent user scrolling', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-list-scroll-fixture.html?collapsed')
            const header = page.locator('[title="/project-20"]')
            await header.waitFor()
            await header.evaluate(element => element.scrollIntoView({ block: 'center' }))
            const before = (await header.boundingBox())!.y
            await page.evaluate(() => window.updateSession('session-0', { globalPinned: true }))
            await page.waitForTimeout(350)
            expect(Math.abs((await header.boundingBox())!.y - before)).toBeLessThan(2)
            const scroller = page.locator('.session-list-scrollbar-left')
            await scroller.evaluate(element => { element.scrollTop = 0 })
            await page.evaluate(() => window.updateSession('session-1', { globalPinned: true }))
            await page.waitForTimeout(350)
            expect(await scroller.evaluate(element => element.scrollTop)).toBe(0)
        })

    })
}
