import { expect, test, type Page } from '@playwright/test'

test.setTimeout(90000)

async function geometry(page: Page) {
    return page.evaluate(() => {
        const root = document.getElementById('root')!
        const chat = document.querySelector<HTMLElement>('.chat-scroll-y')!
        const footer = document.querySelector<HTMLElement>('[data-testid="navigation-composer"]')!
        const header = document.querySelector<HTMLElement>('[data-testid="navigation-header"]')!
        return {
            rootTop: root.scrollTop,
            rootHeight: root.clientHeight,
            rootScrollHeight: root.scrollHeight,
            headerTop: header.getBoundingClientRect().top,
            chatTop: chat.getBoundingClientRect().top,
            chatScrollTop: chat.scrollTop,
            composerBottom: footer.getBoundingClientRect().bottom,
            viewportHeight: innerHeight,
        }
    })
}

for (const device of [
    { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false },
    { name: 'mobile', width: 390, height: 780, isMobile: true, hasTouch: true },
]) {
    test.describe(device.name, () => {
        test.use({
            viewport: { width: device.width, height: device.height },
            hasTouch: device.hasTouch,
            // Firefox supports the narrow layout, but not mobile emulation.
            isMobile: async ({ browserName }, use) => {
                await use(device.isMobile && browserName !== 'firefox')
            },
        })
        test('history selection keeps header and composer pinned to the app', async ({ page }) => {
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&navigationMedia=1')
            await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
            await page.waitForTimeout(2000)
            const before = await geometry(page)
            expect(before.rootTop).toBe(0)
            expect(before.rootScrollHeight).toBeLessThanOrEqual(before.rootHeight + 1)
            await page.getByRole('button', { name: 'Open history', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1010')
            await page.getByRole('button', { name: /Fixture message 1010/ }).click()
            await expect(page.getByRole('searchbox', { name: 'Search outline items' })).toHaveCount(0)
            await page.waitForTimeout(1500)
            const after = await geometry(page)
            console.log(JSON.stringify({ device: device.name, before, after }))
            expect(after.rootTop).toBe(0)
            expect(after.rootScrollHeight).toBeLessThanOrEqual(after.rootHeight + 1)
            expect(after.headerTop).toBeCloseTo(before.headerTop, 0)
            expect(after.composerBottom).toBeCloseTo(after.viewportHeight, 0)
            await expect(page.locator('[id="hapi-message-user-text:m-1010"]')).toBeInViewport()
            // History pagination adds more image previews; no outer overflow.
            await page.evaluate(() => window.__probe.loadMore())
            await expect(page.locator('[id="hapi-message-user-text:m-801"]')).toBeAttached()
            await expect.poll(async () => (await geometry(page)).rootScrollHeight).toBeLessThanOrEqual(after.rootHeight + 1)
            await page.getByRole('button', { name: 'Open history', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 810')
            await page.getByRole('button', { name: /Fixture message 810/ }).click()
            await expect(page.locator('[id="hapi-message-user-text:m-810"]')).toBeInViewport()
            expect((await geometry(page)).rootTop).toBe(0)
            // Exercise tail synchronization after older-history assertions so
            // its latest-page refresh cannot replace their message window.
            await page.getByRole('button', { name: 'Latest messages', exact: true }).click()
            await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport()
            expect((await geometry(page)).rootTop).toBe(0)
            // Existing fullscreen preview must retain viewport-relative sizing.
            const image = page.locator('[data-image-preview-trigger]').first()
            await image.evaluate(element => element.scrollIntoView({ block: 'center' }))
            await image.click()
            await expect(page.getByRole('dialog', { name: /image-.*\.svg/ })).toBeVisible()
            const dialogBox = await page.getByRole('dialog').boundingBox()
            expect(dialogBox?.height).toBe(after.viewportHeight)
            await page.getByRole('button', { name: 'Close', exact: true }).click()
            expect(errors).toEqual([])
        })
    })
}
