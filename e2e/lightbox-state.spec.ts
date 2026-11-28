// Regression coverage for tiann/hapi#2335.
import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ serviceWorkers: 'block' })
async function screenshot(page: Page, name: string) {
    if (!process.env.HAPI_TASK_RUNTIME) return
    const directory = join(process.env.HAPI_TASK_RUNTIME, 'screenshots')
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, name + '.png') })
}
async function update(page: Page, detail: Record<string, unknown> = {}) {
    const tick = Number(await page.getByTestId('tick').textContent())
    await page.evaluate(data => window.dispatchEvent(new CustomEvent('lightbox-fixture-update', { detail: data })), detail)
    await expect(page.getByTestId('tick')).toHaveText(String(tick + 1))
}
function content(page: Page) { return page.getByRole('img', { name: 'Test image' }).locator('..') }
async function transform(page: Page) { return content(page).evaluate(el => el.style.transform) }
async function settle(page: Page) {
    // The component deliberately retries its initial fit after 50 and 200ms.
    await page.waitForTimeout(300)
}
async function open(page: Page, query = '', mobile = false) {
    await page.setViewportSize(mobile ? { width: 393, height: 844 } : { width: 1280, height: 900 })
    await page.goto('/e2e-fixtures/lightbox-state-fixture.html' + query)
    await expect(page.getByRole('dialog')).toBeVisible()
    await settle(page)
}
async function interact(page: Page) {
    await page.getByTitle('Zoom in', { exact: true }).click()
    const box = (await page.getByRole('img', { name: 'Test image' }).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 + 60, { steps: 8 })
    await page.mouse.up()
    return transform(page)
}
for (const mobile of [false, true]) {
    for (const query of ['', '?stable', '?no-fit', '?measured', '?image']) {
        test(`preserves pan/zoom on equivalent parent updates (${mobile ? 'mobile' : 'desktop'} ${query || 'new object'})`, async ({ page }) => {
            await open(page, query, mobile)
            const initial = await transform(page)
            const moved = await interact(page)
            expect(moved).not.toBe(initial)
            const zoom = await page.getByTitle('Fit to screen', { exact: true }).textContent()
            if (!query) await screenshot(page, `${mobile ? 'mobile' : 'desktop'}-before-parent-update`)
            for (let tick = 0; tick < 3; tick++) {
                await update(page)
                await settle(page)
                expect(await transform(page)).toBe(moved)
                await expect(page.getByTitle('Fit to screen', { exact: true })).toHaveText(zoom!)
            }
            if (!query) await screenshot(page, `${mobile ? 'mobile' : 'desktop'}-after-parent-update`)
        })
    }
}
test('refits only when the content key or actual dimensions change and supports explicit reset/reopen', async ({ page }) => {
    await open(page)
    const initial = await transform(page)
    const moved = await interact(page)
    await update(page, { key: 'image-b' })
    await settle(page)
    expect(await transform(page)).toBe(initial)
    await interact(page)
    await update(page, { size: { width: 800, height: 1400 } })
    await settle(page)
    const resized = await transform(page)
    expect(resized).not.toBe(initial)
    expect(resized).not.toBe(moved)
    await interact(page)
    await page.getByTitle('Fit to screen', { exact: true }).click()
    expect(await transform(page)).toBe(resized)
    await interact(page)
    await page.keyboard.press('0')
    expect(await transform(page)).toBe(resized)
    await page.getByTitle('Close', { exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await update(page, { open: true })
    await settle(page)
    expect(await transform(page)).toBe(resized)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
})
test('fits asynchronously supplied content without losing later interactions', async ({ page }) => {
    await open(page, '?deferred')
    await update(page, { key: 'image-a', size: { width: 400, height: 700 } })
    await settle(page)
    const moved = await interact(page)
    await update(page)
    await settle(page)
    expect(await transform(page)).toBe(moved)
})
test('retains pan/zoom across viewport changes without toolbar height changes', async ({ page }) => {
    await open(page)
    const moved = await interact(page)
    await page.setViewportSize({ width: 1100, height: 800 })
    await update(page)
    await settle(page)
    expect(await transform(page)).toBe(moved)
})
