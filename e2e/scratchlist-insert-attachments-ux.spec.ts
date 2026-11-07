import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 320, height: 568 }, hasTouch: true })

test('inserts a file from the attachment plus and restores it after reload', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-lang', 'zh-CN')
    })
    await page.goto('/e2e-fixtures/scratchlist-attachments-fixture.html')
    await page.getByRole('button', { name: 'Single file', exact: true }).click()

    const more = page.locator('[data-scratchlist-action="menu"]')
    await more.click()
    const menu = page.getByTestId('scratchlist-action-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('[data-scratchlist-action="insert-attachments"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    const plus = page.getByTestId('scratchlist-insert-attachment-plus')
    await expect(plus).toBeVisible()
    await expect(plus).toHaveAccessibleName('插入附件')
    await page.screenshot({ path: testInfo.outputPath('01-plus-control.png'), fullPage: true })
    const chooserPromise = page.waitForEvent('filechooser')
    await plus.click()
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

test('inactive session keeps copy and delete while omitting resume-dependent sends', async ({ page }, testInfo) => {
    await page.goto('/e2e-fixtures/scratchlist-attachments-fixture.html')
    await page.getByRole('button', { name: 'Toggle inactive session actions' }).click()
    await page.getByRole('button', { name: 'More actions' }).click()
    const menu = page.getByTestId('scratchlist-action-menu')
    await expect(menu.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Delete entry' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Send now' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Schedule send' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('inactive-session-menu.png'), fullPage: true })
})
