import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

function pngSize(bytes: Buffer): { width: number; height: number } {
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

for (const viewport of [
    { name: 'desktop', width: 1280, height: 2200, theme: 'light' },
    { name: 'mobile', width: 390, height: 844, theme: 'light' },
    { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' }
]) {
    test(`exports a populated wide PNG on ${viewport.name}`, async ({ page }, testInfo) => {
        let stylesheetRequests = 0
        await page.route('**/share-turn-extra.css', async (route) => {
            stylesheetRequests += 1
            if (stylesheetRequests === 1) {
                await route.fulfill({
                    contentType: 'text/css',
                    headers: { 'cache-control': 'no-store' },
                    body: '.share-turn-network-style{border-left:5px solid rgb(124 58 237);border-radius:14px;background:rgb(124 58 237 / 10%);padding:12px 16px}'
                })
                return
            }
            await route.abort()
        })
        await page.setViewportSize(viewport)
        await page.goto(`/e2e-fixtures/share-turn-fixture.html?theme=${viewport.theme}`)

        await expect(page.getByText('Complex response fixture')).toBeVisible()
        await expect(page.getByText('Excluded tool output')).toBeVisible()
        await expect(page.getByText(/type ExportResult/)).toBeVisible()
        await page.getByTestId('source-turn').screenshot({ path: testInfo.outputPath(`source-${viewport.name}.png`) })
        await page.getByRole('button', { name: 'Open share preview' }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByRole('dialog').getByText('Excluded tool output')).toHaveCount(0)
        if (viewport.name === 'desktop') {
            const styles = await page.evaluate(() => {
                const source = document.querySelector<HTMLElement>('[data-testid="source-turn"]')
                const preview = document.querySelector<HTMLElement>('[data-hapi-share-body="true"]')
                if (!source || !preview) throw new Error('Missing comparison roots')
                const selectors = ['.happy-user-bubble', 'h2', 'blockquote', 'table', 'pre']
                const properties = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderRadius'] as const
                return selectors.map((selector) => {
                    const sourceElement = source.querySelector<HTMLElement>(selector)
                    const previewElement = preview.querySelector<HTMLElement>(selector)
                    if (!sourceElement || !previewElement) throw new Error(`Missing ${selector}`)
                    const sourceStyle = getComputedStyle(sourceElement)
                    const previewStyle = getComputedStyle(previewElement)
                    return properties.map((property) => [sourceStyle[property], previewStyle[property]])
                })
            })
            for (const pairs of styles) {
                for (const [sourceValue, previewValue] of pairs) {
                    expect(previewValue).toBe(sourceValue)
                }
            }
        }
        const downloadPromise = page.waitForEvent('download')
        await page.getByRole('button', { name: /Download PNG|下载 PNG/ }).click()
        const download = await downloadPromise
        const path = testInfo.outputPath(`share-turn-${viewport.name}.png`)
        await download.saveAs(path)

        const bytes = await readFile(path)
        const size = pngSize(bytes)
        expect(download.suggestedFilename()).toMatch(/^HAPI-\d{14}\.png$/)
        expect(bytes.byteLength).toBeGreaterThan(80_000)
        expect(size.width).toBe(1920)
        expect(size.height).toBeGreaterThan(1_000)
        expect(stylesheetRequests).toBe(1)
    })
}
