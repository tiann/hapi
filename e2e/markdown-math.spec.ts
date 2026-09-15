import { expect, test } from '@playwright/test'

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
]) {
    test(`renders TeX bracket delimiters and preserves code blocks at ${viewport.width}px`, async ({ page }) => {
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        await page.setViewportSize(viewport)

        await page.goto('/e2e-fixtures/markdown-math-fixture.html')

        const fixture = page.getByTestId('markdown-math-fixture')
        await expect(fixture).toBeVisible()
        await expect(fixture.locator('.katex-display')).toHaveCount(1)
        await expect(fixture.locator('.katex')).toHaveCount(2)

        const codeBody = fixture.locator('[data-hapi-code-body="true"]')
        await expect(codeBody).toBeVisible()
        await expect(codeBody).toContainText('\\[x^2\\]')
        await expect(codeBody.locator('.katex')).toHaveCount(0)
        const pageFitsViewport = await page.evaluate(() => (
            document.documentElement.scrollWidth <= window.innerWidth
        ))
        expect(pageFitsViewport).toBe(true)
        expect(pageErrors).toEqual([])
    })
}
