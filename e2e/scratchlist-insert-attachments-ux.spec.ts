import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 320, height: 568 }, hasTouch: true })

test('inserts a file from the draft menu and restores it after reload', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-lang', 'zh-CN')
    })
    await page.goto('/e2e-fixtures/scratchlist-attachments-fixture.html')
    await page.getByRole('button', { name: 'Single file', exact: true }).click()

    const more = page.locator('[data-scratchlist-action="menu"]')
    await more.click()
    const menu = page.getByTestId('scratchlist-action-menu')
    await expect(menu).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('01-open-menu.png'), fullPage: true })

    const chooserPromise = page.waitForEvent('filechooser')
    await menu.locator('[data-scratchlist-action="insert-attachments"]').click()
    const chooser = await chooserPromise
    await chooser.setFiles({
        name: 'inserted-ux.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('attachment inserted through the scratchlist menu'),
    })

    await expect(menu).toHaveCount(0)
    const inserted = page.locator('[data-scratchlist-attachment-id="uploaded-1"]')
    await expect(inserted).toContainText('inserted-ux.txt')
    await expect(page.getByTestId('order')).toHaveText('["file","uploaded-1"]')
    await expect(page.getByTestId('updates')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath('02-inserted.png'), fullPage: true })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-scratchlist-attachment-id="uploaded-1"]')).toContainText('inserted-ux.txt')
    await expect(page.getByTestId('order')).toHaveText('["file","uploaded-1"]')
    await page.screenshot({ path: testInfo.outputPath('03-after-reload.png'), fullPage: true })
})
