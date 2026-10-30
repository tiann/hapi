import { expect, test, type Page } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/composer-image-drag-fixture.html'
const attachment = (name: string) => `[data-hapi-composer-attachment-id="${name}"]`

async function loadFixture(page: Page) {
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Load attachments' }).click()
    await expect(page.locator(attachment('notes.txt'))).toBeVisible()
}

async function openImage(page: Page, gallery = 'Composer', zoom = 100) {
    await loadFixture(page)
    await page.getByRole('region', { name: gallery, exact: true }).getByTitle('Click to zoom').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    for (let scale = 100; scale < zoom; scale += 25) {
        await dialog.getByTitle('Zoom in', { exact: true }).click()
    }
    return dialog
}

test.describe('touch image gestures', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('tap opens the composer image and backdrop tap closes it', async ({ page }) => {
        await loadFixture(page)
        const trigger = page.locator(attachment('first.png')).getByTitle('Click to zoom')
        await expect(page.locator(attachment('notes.txt'))).toBeVisible()
        await trigger.tap()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await dialog.locator('img').tap()
        await expect(dialog).toBeVisible()
        await dialog.locator('div.cursor-grab').tap({ position: { x: 5, y: 5 } })
        await expect(dialog).toBeHidden()
    })

    test('pinch and pan retain their scale and stop on release or cancellation', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Native multi-touch injection uses Chromium CDP.')
        const dialog = await openImage(page)
        const image = dialog.locator('img')
        const box = await image.boundingBox()
        const x = box!.x + box!.width / 2
        const y = box!.y + box!.height / 2
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 40, y, id: 1 }, { x: x + 40, y, id: 2 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 70, y, id: 1 }, { x: x + 70, y, id: 2 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(async () => Number((await dialog.getByTitle('Reset zoom').textContent())!.replace('%', ''))).toBeGreaterThan(100)
        const pinched = await image.getAttribute('style')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 30, y: y + 25, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect(image).not.toHaveAttribute('style', pinched!)
        const panned = await image.getAttribute('style')
        await page.mouse.move(x + 60, y + 60)
        await expect(image).toHaveAttribute('style', panned!)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 15, y: y + 15, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        const cancelled = await image.getAttribute('style')
        await page.mouse.move(x + 80, y + 80)
        await expect(image).toHaveAttribute('style', cancelled!)
        await cdp.detach()
    })
})

for (const width of [1280, 390]) {
    test.describe(`${width}px image gestures`, () => {
        test.use({ viewport: { width, height: 900 } })

        for (const gallery of ['Composer', 'Sent']) {
            for (const zoom of [100, 250]) {
                test(`${gallery} ${zoom}% releases after a click and after a drag`, async ({ page }) => {
                    const dialog = await openImage(page, gallery, zoom)
                    const image = dialog.locator('img')
                    const box = await image.boundingBox()
                    const x = box!.x + box!.width / 2
                    const y = box!.y + box!.height / 2
                    await page.mouse.click(x, y)
                    const afterRelease = await image.getAttribute('style')
                    await page.mouse.move(x + 45, y + 25, { steps: 4 })
                    await expect(image).toHaveAttribute('style', afterRelease!)
                    await page.mouse.click(x + 45, y + 25)
                    await page.mouse.move(x + 60, y + 35, { steps: 3 })
                    await expect(image).toHaveAttribute('style', afterRelease!)

                    await page.mouse.move(x, y)
                    await page.mouse.down()
                    await page.mouse.move(x + 35, y + 20, { steps: 4 })
                    await expect(dialog).toBeVisible()
                    await expect(image).not.toHaveAttribute('style', afterRelease!)
                    await page.mouse.up()
                    const afterDrag = await image.getAttribute('style')
                    await page.mouse.move(x + 75, y + 45, { steps: 4 })
                    await expect(image).toHaveAttribute('style', afterDrag!)
                    await expect(dialog.getByTitle('Reset zoom')).toHaveText(`${zoom}%`)
                })
            }
        }

        test('retains gallery, zoom, reset, backdrop, close, and Escape controls', async ({ page }) => {
            const dialog = await openImage(page)
            await dialog.getByRole('button', { name: 'Next image' }).click()
            await expect(dialog).toHaveAttribute('aria-label', 'second.png')
            await dialog.getByTitle('Zoom in', { exact: true }).click()
            await expect(dialog.getByTitle('Reset zoom')).toHaveText('125%')
            await dialog.getByTitle('Reset zoom').click()
            await expect(dialog.getByTitle('Reset zoom')).toHaveText('100%')
            await page.keyboard.press('ArrowLeft')
            await expect(dialog).toHaveAttribute('aria-label', 'first.png')
            await dialog.getByTitle('Close', { exact: true }).click()
            await expect(dialog).toBeHidden()
            await page.locator(attachment('first.png')).getByTitle('Click to zoom').click()
            await page.keyboard.press('Escape')
            await expect(dialog).toBeHidden()
            await page.locator(attachment('first.png')).getByTitle('Click to zoom').click()
            await dialog.locator('div.cursor-grab').click({ position: { x: 5, y: 5 } })
            await expect(dialog).toBeHidden()
        })

        test('retains attachment drag and keyboard ordering and removal', async ({ page }) => {
            await loadFixture(page)
            const first = page.locator(attachment('first.png'))
            await expect(page.locator(attachment('notes.txt'))).toBeVisible()
            await first.getByRole('button', { name: 'Reorder attachment first.png' }).press('ArrowRight')
            const items = page.locator('[data-hapi-composer-attachment-id]')
            await expect(items.first()).toHaveAttribute('data-hapi-composer-attachment-id', 'second.png')
            const handle = await first.getByRole('button', { name: 'Reorder attachment first.png' }).boundingBox()
            const target = await page.locator(attachment('second.png')).boundingBox()
            await page.mouse.move(handle!.x + 10, handle!.y + 10)
            await page.mouse.down()
            await page.mouse.move(target!.x + 3, target!.y + 30, { steps: 6 })
            await page.mouse.up()
            await expect(items.first()).toHaveAttribute('data-hapi-composer-attachment-id', 'first.png')
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.locator(attachment('notes.txt')).getByRole('button', { name: 'Reorder attachment notes.txt' }).press('Home')
            await expect(items.first()).toHaveAttribute('data-hapi-composer-attachment-id', 'notes.txt')
            await first.hover()
            await first.getByRole('button', { name: 'Remove attachment' }).click()
            await expect(first).toHaveCount(0)
        })
    })
}
