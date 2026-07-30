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

    test('exposes one visible preview trigger, share-safe toggles, and wrapping geometry in inline diff surfaces', async ({ page }) => {
        await page.goto(fixtureUrl)

        const preview = page.getByTestId('diff-preview')
        const wrapToggle = preview.locator('[data-hapi-code-wrap-toggle="true"]')
        await expect(wrapToggle).toHaveCount(1)
        await expect(preview.locator('button button')).toHaveCount(0)
        await expect(preview.getByRole('button', { name: /open diff for src\/mobile-terminal\.ts/i })).toHaveCount(1)
        await expect(wrapToggle).toHaveAttribute('data-hapi-share-export-exclude', 'true')

        await wrapToggle.click()
        await expect(wrapToggle).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('[data-hapi-code-grid="true"]')).toHaveAttribute('style', /minmax\(0px, 1fr\)/)

        const inline = page.getByTestId('diff-inline')
        await expect(inline.locator('.whitespace-pre-wrap')).toHaveCount(2)
        const inlineGeometry = await inline.evaluate((element) => {
            const wrapped = element.querySelector<HTMLElement>('.whitespace-pre-wrap')!
            const range = document.createRange()
            range.selectNodeContents(wrapped)
            const root = element.getBoundingClientRect()
            const row = wrapped.parentElement!
            return {
                row: { clientWidth: row.clientWidth, scrollWidth: row.scrollWidth },
                rootRight: root.right,
                fragments: Array.from(range.getClientRects()).map((rect) => ({ right: rect.right, top: rect.top })),
            }
        })
        await expect(inline.locator('.overflow-x-auto')).toHaveCount(0)
        expect(inlineGeometry.row.scrollWidth).toBe(inlineGeometry.row.clientWidth)
        expect(inlineGeometry.fragments.length).toBeGreaterThan(1)
        expect(Math.max(...inlineGeometry.fragments.map((fragment) => fragment.right))).toBeLessThanOrEqual(inlineGeometry.rootRight + 1)

        const codexDiff = page.getByTestId('toolcard-codex-diff')
        await expect(codexDiff.locator('[role="button"] button')).toHaveCount(0)
        const codexWrapToggle = codexDiff.locator('[data-hapi-code-wrap-toggle="true"]')
        await expect(codexWrapToggle).toHaveCount(1)
        await codexWrapToggle.click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await codexWrapToggle.click()
        await codexDiff.getByRole('button', { name: 'Open diff preview' }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

        const previewTrigger = preview.getByRole('button', { name: /open diff for src\/mobile-terminal\.ts/i })
        await previewTrigger.click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('button', { pressed: true })).toHaveCount(1)
        await dialog.getByRole('button', { name: 'Close' }).click()
        await expect(previewTrigger).toBeFocused()
    })
})
