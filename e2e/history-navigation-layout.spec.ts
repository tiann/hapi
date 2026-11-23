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

test('keeps following new output after jumping to the already-visible start of a short chat', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1')
    const chat = page.locator('.chat-scroll-y')
    await expect(page.getByText('First short reply', { exact: true })).toBeInViewport()
    const measureBottom = () => chat.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    expect(await measureBottom()).toBeLessThanOrEqual(1)
    await page.getByText('First short reply', { exact: true }).hover()
    await page.getByRole('button', { name: 'Jump to conversation start' }).click({ timeout: 5_000 })
    await expect(page.getByText('Reached conversation start', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.appendReply())
    await expect.poll(() => chat.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
    await expect.poll(measureBottom).toBeLessThanOrEqual(3)
    await expect(page.getByText('New reply line 25', { exact: true })).toBeInViewport()
})

test('keeps following new output after selecting an already visible outline item', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1')
    const chat = page.locator('.chat-scroll-y')
    await expect(page.getByText('First short reply', { exact: true })).toBeInViewport()
    await page.getByRole('button', { name: 'Open history', exact: true }).click()
    await page.getByRole('button', { name: /Short chat prompt/ }).click()
    await expect(page.getByRole('searchbox', { name: 'Search outline items' })).toHaveCount(0)
    await page.evaluate(() => window.__probe.appendReply())
    await expect.poll(() => chat.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
    await expect(page.getByText('New reply line 25', { exact: true })).toBeInViewport()
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-outline-tail.png` })
    }
})

for (const [locale, action, success] of [
    ['ja', '会話の先頭へ移動', '会話の先頭に移動しました'],
    ['ru', 'Перейти к началу разговора', 'Достигнуто начало разговора'],
] as const) {
    test(`announces conversation navigation from a persistent live region (${locale})`, async ({ page }) => {
        await page.addInitScript(lang => window.localStorage.setItem('hapi-lang', lang), locale)
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1')
        const status = page.getByTestId('history-navigation-status')
        await expect(status).toHaveText('')
        await expect(status).toHaveAttribute('aria-live', 'polite')
        await status.evaluate(element => { element.setAttribute('data-probe-mounted', 'idle') })
        await page.getByText('First short reply', { exact: true }).hover()
        await page.getByRole('button', { name: action, exact: true }).click()
        await expect(status).toHaveText(success)
        await expect(status).toHaveAttribute('data-probe-mounted', 'idle')
        if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
            await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-${locale}.png` })
        }
    })
}


test('a reply to a job wake has no jump-to-input action', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1&jobWake=1')
    const reply = page.getByText('Job-wake reply', { exact: true })
    await reply.hover()
    const row = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Job-wake reply' })
    await expect(row.getByRole('button', { name: 'Jump to conversation start' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Jump to turn input' })).toHaveCount(0)
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await row.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-job-wake.png` })
    }
})


test('keyboard prompt navigation focuses the destination input', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1')
    await expect(page.getByText('First short reply', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.appendReply())
    const lastLine = page.getByText('New reply line 25', { exact: true })
    await expect(lastLine).toBeInViewport()
    await lastLine.hover()
    await page.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Short chat prompt' })
    await expect(prompt).toBeFocused()
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-keyboard-focus.png` })
    }
})


test('selecting an outline item reveals it after the mobile composer returns', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1&outlineResize=1')
    await page.addStyleTag({ content: '[data-testid="navigation-composer"] { height: 450px }' })
    await page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'First short reply' }).evaluate(element => {
        element.style.minHeight = '355px'
    })
    await page.getByRole('button', { name: 'Open history' }).click()
    const chat = page.locator('.chat-scroll-y')
    await expect.poll(() => chat.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: /Prompt near the end/ }).click()
    await expect(page.getByTestId('navigation-composer')).toBeVisible()
    await expect.poll(() => chat.evaluate(el => el.scrollTop)).toBeGreaterThan(60)
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt near the end' })
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-mobile-outline.png` })
    }
})
