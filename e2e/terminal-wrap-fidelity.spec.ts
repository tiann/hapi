import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 })

const fixtureUrl = '/e2e-fixtures/terminal-wrap-fixture.html'

test.describe('terminal wrap fidelity', () => {
    test('wrap-on keeps 1-, 2-, and 3-digit gutter numbers left of code text on mobile', async ({ page }, testInfo) => {
        await page.addInitScript(() => window.localStorage.setItem('hapi-code-wrap', '1'))
        await page.goto(fixtureUrl)

        await page.getByRole('button', { name: /node scripts\/render-report/i }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()

        const metrics = await dialog.evaluate((element) => {
            const body = element.querySelector<HTMLElement>('[data-hapi-code-body="true"]')!
            const grid = element.querySelector<HTMLElement>('[data-hapi-code-grid="true"]')!
            const cells = Array.from(element.querySelectorAll<HTMLElement>('[data-code-cell]'))
            const gutters = Array.from(element.querySelectorAll<HTMLElement>('[data-line-number]'))
            const measure = (needle: string) => {
                const index = cells.findIndex((cell) => cell.textContent?.includes(needle))
                const codeCell = cells[index]!
                const textRange = document.createRange()
                textRange.selectNodeContents(codeCell)
                const numberRange = document.createRange()
                numberRange.selectNodeContents(gutters[index]!)
                const textRects = Array.from(textRange.getClientRects()).filter((rect) => rect.width > 0)
                const numberRects = Array.from(numberRange.getClientRects()).filter((rect) => rect.width > 0)
                const gutterRect = gutters[index]!.getBoundingClientRect()
                return {
                    line: gutters[index]!.textContent,
                    gutter: { left: gutterRect.left, right: gutterRect.right, width: gutterRect.width },
                    numberRight: Math.max(...numberRects.map((rect) => rect.right)),
                    numberWidth: Math.max(...numberRects.map((rect) => rect.width)),
                    codeTextLeft: Math.min(...textRects.map((rect) => rect.left)),
                }
            }
            return {
                body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
                grid: { clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth },
                dialog: { right: element.getBoundingClientRect().right, viewportWidth: window.innerWidth },
                rows: [measure('node scripts/render-report'), measure('row-001 | value'), measure('row-100 | value')],
            }
        })
        await writeFile(testInfo.outputPath('terminal-gutter-geometry.json'), JSON.stringify(metrics, null, 2))
        await page.screenshot({ path: testInfo.outputPath('terminal-gutter.png') })

        expect(metrics.body.scrollWidth).toBe(metrics.body.clientWidth)
        expect(metrics.grid.scrollWidth).toBe(metrics.grid.clientWidth)
        expect(metrics.dialog.right).toBeLessThanOrEqual(metrics.dialog.viewportWidth)
        expect(metrics.rows.map((row) => row.line?.length)).toEqual([1, 2, 3])
        for (const row of metrics.rows) {
            expect(row.numberRight).toBeLessThan(row.codeTextLeft)
            expect(row.codeTextLeft - row.gutter.left).toBeGreaterThanOrEqual(row.numberWidth + 24)
            expect(row.gutter.width).toBeCloseTo(metrics.rows[0]!.gutter.width, 2)
        }
    })
})
