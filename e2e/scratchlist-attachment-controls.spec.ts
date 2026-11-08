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
                const add = page.getByTestId('scratchlist-insert-attachment-plus')
                const [itemBox, addBox] = await Promise.all([items(page).boundingBox(), add.boundingBox()])
                expect(addBox!.width).toBeCloseTo(40, 0)
                expect(addBox!.height).toBeCloseTo(addBox!.width, 1)
                if (kind === 'file') {
                    expect(addBox!.height).toBeCloseTo(itemBox!.height, 1)
                } else {
                    expect(addBox!.y + addBox!.height / 2).toBeCloseTo(itemBox!.y + itemBox!.height / 2, 1)
                }
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

        test('image thumbnail and fullscreen preview preserve the native context menu', async ({ page }) => {
            test.skip(touch, 'Desktop mouse context-menu behavior')
            await page.getByRole('button', { name: 'Single image', exact: true }).click()
            const watchContextMenu = async () => {
                await page.evaluate(() => {
                    const state = window as Window & { __contextMenuPrevented?: boolean }
                    state.__contextMenuPrevented = undefined
                    window.addEventListener('contextmenu', (event) => {
                        state.__contextMenuPrevented = event.defaultPrevented
                    }, { once: true })
                })
            }
            const prevented = async () => page.evaluate(() => (
                window as Window & { __contextMenuPrevented?: boolean }
            ).__contextMenuPrevented)

            await watchContextMenu()
            await items(page).click({ button: 'right' })
            await expect.poll(prevented).toBe(false)
            await expect(page.getByTestId('scratchlist-action-menu')).toHaveCount(0)

            await items(page).getByTitle('Click to zoom').click()
            const dialog = page.getByRole('dialog', { name: 'photo.png' })
            await watchContextMenu()
            await dialog.getByRole('img', { name: 'photo.png' }).click({ button: 'right' })
            await expect.poll(prevented).toBe(false)
            await expect(page.getByTestId('scratchlist-action-menu')).toHaveCount(0)
        })

        test('narrow attachment strip scrolls horizontally to keep the add control reachable', async ({ page, browserName }, testInfo) => {
            test.skip(touch && browserName !== 'chromium', 'Native touch injection requires Chromium CDP')
            await page.getByRole('button', { name: 'Many images', exact: true }).click()
            const strip = page.getByTestId('scratchlist-attachments')
            const plus = page.getByTestId('scratchlist-insert-attachment-plus')
            const before = await strip.evaluate((element) => ({
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                scrollLeft: element.scrollLeft,
            }))
            expect(before.scrollWidth).toBeGreaterThan(before.clientWidth)
            await expect(plus).toHaveCSS('width', '40px')

            if (touch) {
                const bounds = await strip.boundingBox()
                const cdp = await page.context().newCDPSession(page)
                const startX = bounds!.x + bounds!.width - 24
                const y = bounds!.y + 24
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] })
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - 160, y, id: 1 }] })
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - 260, y, id: 1 }] })
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
                await cdp.detach()
            } else {
                const bounds = await strip.boundingBox()
                await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
                await page.keyboard.down('Shift')
                await page.mouse.wheel(0, 240)
                await page.keyboard.up('Shift')
            }

            await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
            await plus.scrollIntoViewIfNeeded()
            await expect(plus).toBeVisible()
            await expect(plus).toBeEnabled()
            await page.getByTestId('scratchlist-drawer').screenshot({
                path: testInfo.outputPath(`narrow-${touch ? 'touch' : 'desktop'}-strip-scrolled.png`),
            })
        })

        test('mixed attachment order persists after keyboard sorting and reload, then hides at 2 → 1', async ({ page }, testInfo) => {
            await page.getByRole('button', { name: 'Mixed attachments', exact: true }).click()
            await expect(handles(page)).toHaveCount(2)
            await page.mouse.move(980, 760)
            const imageHandle = item(page, 'photo').getByTestId('scratchlist-attachment-drag-handle')
            await expect(imageHandle).toHaveCSS('opacity', touch ? '1' : '0')
            await item(page, 'photo').hover()
            await expect(imageHandle).toHaveCSS('opacity', '1')
            await expect(item(page, 'photo').getByRole('img')).toHaveCSS('opacity', '1')
            const [imageBox, addBox] = await Promise.all([
                item(page, 'photo').boundingBox(),
                page.getByTestId('scratchlist-insert-attachment-plus').boundingBox(),
            ])
            expect(addBox!.width).toBeCloseTo(40, 0)
            expect(addBox!.height).toBeCloseTo(addBox!.width, 1)
            expect(addBox!.y + addBox!.height / 2).toBeCloseTo(imageBox!.y + imageBox!.height / 2, 1)
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

        test('More actions long-press starts row drag and a short tap still opens the menu', async ({ page, browserName }, testInfo) => {
            test.skip(!touch || browserName !== 'chromium', 'Native touch injection requires Chromium CDP and the touch context.')
            await page.getByRole('button', { name: 'Mixed attachments', exact: true }).click()
            const row = page.getByTestId('scratchlist-entry')
            const more = row.getByRole('button', { name: 'More actions' })
            const box = await more.boundingBox()
            const cdp = await page.context().newCDPSession(page)
            const x = box!.x + box!.width / 2
            const y = box!.y + box!.height / 2

            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
            await page.waitForTimeout(500)
            await expect(row).toHaveAttribute('data-dragging', '')
            await page.screenshot({ path: testInfo.outputPath('more-actions-long-press-drag.png') })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await expect(row).not.toHaveAttribute('data-dragging')
            await expect(page.getByRole('menu')).toHaveCount(0)

            await more.click()
            await expect(page.getByRole('menu')).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(page.getByRole('menu')).toHaveCount(0)

            const rowBox = await row.boundingBox()
            await page.touchscreen.tap(rowBox!.x + rowBox!.width * 0.65, rowBox!.y + rowBox!.height - 10)
            const editor = page.getByRole('textbox', { name: 'Edit scratchlist entry' })
            await expect(editor).toBeVisible()
            await editor.selectText()
            await page.getByTestId('scratchlist-drawer').screenshot({
                path: testInfo.outputPath('short-tap-right-whitespace-editor.png'),
            })
            await cdp.detach()
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
