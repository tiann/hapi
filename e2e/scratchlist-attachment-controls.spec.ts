import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
const items = (page: Page) => page.locator('[data-scratchlist-attachment-id]')
const item = (page: Page, id: string) => page.locator(`[data-scratchlist-attachment-id="${id}"]`)
const handles = (page: Page) => page.getByTestId('scratchlist-attachment-drag-handle')

for (const touch of [false, true]) {
    test.describe(touch ? 'touch' : 'desktop', () => {
        test.use({ viewport: { width: touch ? 390 : 1000, height: 800 }, hasTouch: touch })
        test.beforeEach(async ({ page }) => {
            await page.goto('/e2e-fixtures/scratchlist-attachments-fixture.html', { waitUntil: 'domcontentloaded' })
        })

        for (const kind of ['image', 'file']) {
            test(`single ${kind} keeps removal and balanced chip layout without a drag handle`, async ({ page }, testInfo) => {
                await page.getByRole('button', { name: `Single ${kind}`, exact: true }).click()
                await expect(items(page)).toHaveCount(1)
                await expect(handles(page)).toHaveCount(0)
                await items(page).hover()
                const remove = items(page).getByRole('button', { name: /^Remove attachment/ })
                await expect(remove).toHaveCSS('opacity', '1')
                await expect(remove).toHaveCSS('width', kind === 'image' ? '32px' : '24px')
                if (kind === 'image') {
                    await expect(items(page).getByRole('img')).toHaveCSS('opacity', '1')
                    await items(page).getByTitle('Click to zoom').click()
                    await expect(page.getByRole('dialog', { name: 'photo.png' })).toBeVisible()
                    await page.getByRole('dialog').getByTitle('Close', { exact: true }).click()
                } else {
                    const padding = await items(page).evaluate((el) => {
                        const chip = el.getBoundingClientRect()
                        const name = el.querySelector('span')!.getBoundingClientRect()
                        const icon = el.querySelector('button svg')!.getBoundingClientRect()
                        return { left: name.left - chip.left, right: chip.right - icon.right + 2 }
                    })
                    expect(padding.left).toBeCloseTo(padding.right, 1)
                }
                await items(page).hover()
                await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath(`single-${kind}.png`) })
                await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
                await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath(`single-${kind}-dark.png`) })
                await remove.click()
                await expect(page.getByRole('dialog', { name: 'Delete attachment?' })).toBeVisible()
                await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
                await expect(items(page)).toHaveCount(0)
                await expect(page.getByTestId('scratchlist-entry-text')).toHaveText('Draft note')
            })
        }

        test('mixed attachment order persists after keyboard sorting and reload, then hides at 2 → 1', async ({ page }, testInfo) => {
            await page.getByRole('button', { name: 'Mixed attachments', exact: true }).click()
            await expect(handles(page)).toHaveCount(2)
            await page.mouse.move(980, 760)
            const imageHandle = item(page, 'photo').getByTestId('scratchlist-attachment-drag-handle')
            await expect(imageHandle).toHaveCSS('opacity', touch ? '1' : '0')
            await item(page, 'photo').hover()
            await expect(imageHandle).toHaveCSS('opacity', '1')
            await expect(item(page, 'photo').getByRole('img')).toHaveCSS('opacity', '1')
            await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath('mixed.png') })
            await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
            await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath('mixed-dark.png') })
            await item(page, 'file').getByTestId('scratchlist-attachment-drag-handle').press('Home')
            await expect(page.getByTestId('order')).toHaveText('["file","photo"]')
            await expect(page.getByTestId('updates')).toHaveText('1')
            await page.reload({ waitUntil: 'domcontentloaded' })
            await expect(items(page).first()).toHaveAttribute('data-scratchlist-attachment-id', 'file')
            await item(page, 'file').getByRole('button', { name: /^Remove attachment/ }).click()
            await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
            await expect(handles(page)).toHaveCount(0)
            await expect(page.getByTestId('order')).toHaveText('["photo"]')
        })

        for (const kind of ['images', 'files']) {
            test(`two ${kind} support pointer sorting without moving the draft row`, async ({ page }) => {
                const errors: string[] = []
                page.on('pageerror', (error) => errors.push(error.message))
                await page.getByRole('button', { name: `Two ${kind}`, exact: true }).click()
                await expect(handles(page)).toHaveCount(2)
                const active = items(page).first()
                await active.hover()
                const handle = await active.getByTestId('scratchlist-attachment-drag-handle').boundingBox()
                const target = await items(page).last().boundingBox()
                await page.mouse.move(handle!.x + 10, handle!.y + 10)
                await page.mouse.down()
                await page.mouse.move(target!.x + target!.width - 3, target!.y + target!.height / 2, { steps: 8 })
                await page.mouse.up()
                await expect(page.getByTestId('updates')).toHaveText('1')
                await expect(page.getByTestId('order')).toHaveText(kind === 'images' ? '["second","photo"]' : '["second-file","file"]')
                await expect(page.getByRole('dialog')).toHaveCount(0)
                expect(errors).toEqual([])
            })
        }

        test('failed ordering rolls back without closing an open image preview', async ({ page }) => {
            await page.getByRole('button', { name: 'Mixed attachments', exact: true }).click()
            await item(page, 'photo').getByTitle('Click to zoom').click()
            await page.getByRole('dialog').getByTitle('Zoom in', { exact: true }).click()
            // Parent updates arrive while an image viewer is open.
            await page.getByRole('button', { name: 'Toggle save failure' }).evaluate((button: HTMLButtonElement) => button.click())
            await item(page, 'file').getByTestId('scratchlist-attachment-drag-handle').dispatchEvent('keydown', { key: 'Home' })
            await expect(page.getByRole('alert')).toHaveText('Save failed')
            await expect(page.getByTestId('order')).toHaveText('["photo","file"]')
            await expect(page.getByRole('dialog', { name: 'photo.png' })).toBeVisible()
            await expect(page.getByRole('dialog').getByTitle('Reset zoom')).toHaveText('125%')
        })

        test('native touch handle drag persists order and pointer cancellation does not', async ({ page, browserName }) => {
            test.skip(!touch || browserName !== 'chromium', 'Native touch injection requires Chromium CDP and the touch context.')
            await page.getByRole('button', { name: 'Two images', exact: true }).click()
            const active = await handles(page).first().boundingBox()
            const target = await items(page).last().boundingBox()
            const cdp = await page.context().newCDPSession(page)
            const x = active!.x + 10
            const y = active!.y + 10
            const toX = target!.x + target!.width - 3
            const toY = target!.y + target!.height / 2
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: toX, y: toY, id: 1 }] })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
            await expect(page.getByTestId('order')).toHaveText('["photo","second"]')
            await expect(page.getByTestId('updates')).toHaveText('0')
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: toX, y: toY, id: 1 }] })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await expect(page.getByTestId('order')).toHaveText('["second","photo"]')
            await expect(page.getByTestId('updates')).toHaveText('1')
            await cdp.detach()
        })
    })
}
