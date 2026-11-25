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
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1&steer=1')
    await expect(page.getByText('Mid-turn steer', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.appendReply())
    const lastLine = page.getByText('New reply line 25', { exact: true })
    await expect(lastLine).toBeInViewport()
    const lastRow = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'New reply line 25' })
    await lastRow.hover()
    await lastRow.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Short chat prompt' })
    await expect(prompt).toBeFocused()
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-keyboard-focus.png` })
    }
})


test('keyboard navigation to the start focuses the first message', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartShort=1&steer=1')
    await expect(page.getByText('Mid-turn steer', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.appendReply())
    const lastLine = page.getByText('New reply line 25', { exact: true })
    await expect(lastLine).toBeInViewport()
    const lastRow = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'New reply line 25' })
    await lastRow.hover()
    await lastRow.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
    const firstMessage = page.locator('.happy-thread-messages > [id]').first()
    await expect(firstMessage).toContainText('Short chat prompt')
    await expect(firstMessage).toBeFocused()
    await expect(firstMessage).toBeInViewport({ ratio: 0.9 })
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/response-navigation-keyboard-start.png` })
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


test('a cached re-entry cannot reclaim the viewport after a footer jump', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1&cachedReentry=1&cachedJump=1&holdLatest=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
    await expect(page.getByText('Loading earlier messages…', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.releaseLatest())
    await expect.poll(() => page.evaluate(() => window.__probe.requests.some(r => r.direction === 'before'))).toBe(true)
    await page.evaluate(() => window.__probe.releaseBefore())
    const oldest = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt from the older page' })
    await expect(oldest).toBeFocused()
    await expect(page.getByText('Reached conversation start', { exact: true })).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-cached-tail-keeps-footer-jump.png` })
})


test('conversation start waits for epoch verification of complete cached history', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&cachedReentry=1&cachedComplete=1&holdLatest=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Cached reply before rewind' })
    await expect.poll(() => page.evaluate(() => window.__probe.requests.some(r => r.direction === 'latest'))).toBe(true)
    await reply.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
    await expect(page.getByText(/Loading earlier messages|Reached conversation start/)).toHaveText('Loading earlier messages…')
    await page.evaluate(() => {
        window.__probe.setEpoch(2)
        window.__probe.releaseLatest()
    })
    await expect(page.getByText('Current history after rewind')).toBeInViewport()
    await expect(page.getByText('Reached conversation start', { exact: true })).toHaveCount(0)
    await expect(reply).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-verified-rewind.png` })
})

test('a gap during cached navigation requests a fresh epoch before confirming a jump', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&cachedReentry=1&cachedComplete=1&holdLatest=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Cached reply before rewind' })
    const latestCount = () => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'latest').length)
    await expect.poll(latestCount).toBe(1)
    await reply.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
    await expect.poll(latestCount).toBe(2)
    await page.evaluate(() => { void window.__probe.gap(2) })
    await expect.poll(latestCount).toBe(3)
    await page.evaluate(() => window.__probe.releaseLatest())
    await expect(page.getByText('Current history after rewind')).toBeInViewport()
    await expect(page.getByText('Reached conversation start', { exact: true })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-post-gap-epoch.png` })
})

test('reports a failed reconnect probe instead of confirming conversation start', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&cachedComplete=1')
    await expect.poll(async () => (await geometry(page)).chatScrollTop).toBeGreaterThan(300)
    await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
        const original = viewport.scrollTo.bind(viewport)
        viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
            if (typeof options === 'object' && options.top === 0 && options.behavior === 'smooth') {
                window.__probe.failNextLatest()
                void window.__probe.gap()
            }
            if (typeof options === 'number') original(options, y ?? 0)
            else original(options)
        }
    })
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Cached reply before rewind' })
    await reply.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
    await expect(page.getByText('Could not load earlier messages. Try again.', { exact: true })).toBeVisible()
    await expect(page.getByText('Reached conversation start', { exact: true })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-reconnect-verification-fails.png` })
})

test('a failed prompt verification does not focus an unverified turn input', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&loadedPromptPreload=1')
    await expect.poll(async () => (await geometry(page)).chatScrollTop).toBeGreaterThan(500)
    await page.evaluate(() => {
        const original = HTMLElement.prototype.scrollIntoView
        HTMLElement.prototype.scrollIntoView = function (options) {
            if (this.matches('[data-hapi-turn-input="true"]') && this.textContent?.includes('Already loaded prompt')) {
                window.__probe.failNextLatest()
                void window.__probe.gap()
            }
            original.call(this, options)
        }
    })
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Already loaded prompt' })
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Reply to loaded prompt' })
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect(page.getByText('Could not load turn input. Try again.', { exact: true })).toBeVisible()
    await expect(prompt).not.toBeFocused()
    await expect(page.locator('.chat-scroll-y')).toBeFocused()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-unverified-focus.png` })
})

test('finds the turn input in concise mode across pages with no rendered overlap', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&conciseLongTurn=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Concise reply after a long turn' })
    const prompt = page.getByText('Prompt before the hidden tool output', { exact: true })
    await expect(reply).toBeInViewport()
    await expect(prompt).toHaveCount(0)
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect(prompt).toBeInViewport()
    await expect(page.locator('[data-hapi-turn-input="true"]')).toBeFocused()
    await expect(reply).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-concise-long-turn.png` })
})

test('finds the input of a tool-only plan visible in concise mode', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&conciseLongTurn=1&conciseToolReply=1')
    const plan = page.locator('[data-hapi-message-role="assistant"]')
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt before the hidden tool output' })
    await expect(plan).toHaveCount(1)
    await expect(prompt).toHaveCount(0)
    await plan.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect(prompt).toBeFocused()
    await expect(prompt).toBeInViewport()
    await expect(plan).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-concise-tool-plan.png` })
})

test('does not cross a system wake while scanning concise history', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&conciseLongTurn=1&conciseJobWake=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Concise reply after a long turn' })
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect(page.locator('[data-hapi-system-turn="true"]')).toHaveText(/Job wake before the hidden tool output/)
    await expect(page.getByText('Loading turn input…', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Could not load turn input. Try again.', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-hapi-turn-input="true"]')).not.toBeFocused()
})

test('the jump feedback stays below the search toolbar on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1&target=m-3&targetQuery=Last')
    const toolbar = page.getByTestId('search-match-navigation')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Next match' })).toBeEnabled()
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    const feedback = page.getByTestId('history-navigation-status')
    await expect(feedback).toContainText('Loading turn input')
    const toolbarBox = (await toolbar.boundingBox())!
    const feedbackBox = (await feedback.boundingBox())!
    expect(feedbackBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-search-and-feedback.png` })
    await page.evaluate(() => window.__probe.releaseBefore())
})


test('keeps a footer destination when search recentering is still scheduled', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1&target=m-3')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.hover()
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await page.evaluate(() => window.__probe.releaseBefore())
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt from the older page' })
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    await page.waitForTimeout(2_000)
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/response-navigation-search-recentering.png` })
})


test('settles at the start of a prompt taller than the viewport', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1')
    await page.addStyleTag({ content: '[data-hapi-message-role="assistant"] { min-height: 1200px; } [data-hapi-turn-input="true"] { min-height: 1400px; }' })
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.hover()
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await page.evaluate(() => window.__probe.releaseBefore())
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt from the older page' })
    await expect(page.getByText('Reached turn input', { exact: true })).toBeVisible()
    await expect(prompt).toBeInViewport({ ratio: 0.1 })
    await expect(page.getByText('Failed to locate', { exact: false })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/response-navigation-tall-prompt.png` })
})


for (const structuralReset of [false, true]) {
    test(`handles a reconnect after the jump-to-start has trimmed newer pages (reset=${structuralReset})`, async ({ page }) => {
        await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartGap=1')
        const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Latest fixture reply' })
        await reply.hover()
        await reply.getByRole('button', { name: 'Jump to conversation start' }).press('Enter')
        await expect.poll(() => page.evaluate(() => window.__probe.requests.map(r => r.beforeSeq)), {
            timeout: 30_000
        }).toContain(201)
        await page.evaluate(next => window.__probe.gap(next ? 2 : undefined), structuralReset)
        await page.evaluate(() => window.__probe.releaseBefore())
        const success = page.getByText('Reached conversation start', { exact: true })
        if (structuralReset) {
            await expect(page.getByText('Fixture message 1199', { exact: true })).toBeAttached()
            await expect(success).toHaveCount(0)
            await expect(page.getByText('Fixture message 1', { exact: true })).toHaveCount(0)
        } else {
            await expect(success).toBeVisible()
            const oldest = page.getByText('Fixture message 1', { exact: true })
            await expect(oldest).toBeInViewport()
            const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
            if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-reconnect-keeps-start.png` })
            // A second reconnect after settlement must not replace the page either.
            await page.evaluate(() => window.__probe.gap())
            await expect(oldest).toBeInViewport()
            await page.getByRole('button', { name: 'Latest messages', exact: true }).click()
            await expect(reply).toBeInViewport()
        }
    })
}


test('keeps the initiating prompt through a reconnect during a long reply jump', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&jumpStartGap=1&promptJumpGap=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Latest fixture reply' })
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect.poll(() => page.evaluate(() => window.__probe.requests.map(r => r.beforeSeq)), {
        timeout: 30_000
    }).toContain(201)
    await page.evaluate(() => window.__probe.gap())
    await page.evaluate(() => window.__probe.releaseBefore())
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ has: page.getByText('Fixture message 1', { exact: true }) })
    await expect(prompt).toBeFocused({ timeout: 15_000 })
    await expect(prompt).toBeInViewport()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-reconnect-keeps-prompt.png` })
})


test('a reply jumps to the first accepted Codex batch member, even across a page', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&batchedReply=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Reply to the accepted batch' })
    await expect.poll(async () => (await geometry(page)).chatScrollTop).toBeGreaterThan(500)
    await expect(page.getByText('First accepted batch member', { exact: true })).toHaveCount(0)
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter', { timeout: 7_000 })
    const first = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'First accepted batch member' })
    await expect(first).toBeFocused()
    await expect(first).toBeInViewport()
    await expect(page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Last accepted batch member' })).toHaveCount(0)
    await expect(page.getByText('Loading turn input…', { exact: true })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-codex-batch-first.png` })
})


test('rechecks the destination when a reconnect marks the apparent prompt as a steer', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&lateSteerJump=1')
    await page.evaluate(() => {
        const original = HTMLElement.prototype.scrollIntoView
        HTMLElement.prototype.scrollIntoView = function (options) {
            if (this.matches('[data-hapi-turn-input="true"]') && this.textContent?.includes('Unconfirmed correction')) {
                // Start the recovery while the correction is still the target.
                void window.__probe.confirmSteer()
            }
            original.call(this, options)
        }
    })
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Reply with late steer' })
    await expect.poll(async () => (await geometry(page)).chatScrollTop).toBeGreaterThan(500)
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter', { timeout: 10_000 })
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Original fixture prompt' })
    await expect(prompt).toBeFocused()
    await expect(page.getByText('Loading turn input…', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Original fixture prompt', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect(page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Unconfirmed correction' })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-retargets-late-steer.png` })
})


test('does not preload older history while a jump to a loaded prompt is settling', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&loadedPromptPreload=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Reply to loaded prompt' })
    await expect(reply).toBeAttached()
    await expect.poll(async () => (await geometry(page)).chatScrollTop).toBeGreaterThan(500)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before'))).toHaveLength(0)
    await page.evaluate(() => {
        const original = HTMLElement.prototype.scrollIntoView
        HTMLElement.prototype.scrollIntoView = function (options) {
            if (this.matches('[data-hapi-turn-input="true"]') && this.textContent?.includes('Already loaded prompt')) {
                // Hold a smooth jump between scroll events inside the preload
                // margin while the target is still just outside the viewport.
                const viewport = this.closest<HTMLElement>('.chat-scroll-y')!
                viewport.scrollTo({ top: 150, behavior: 'instant' })
                viewport.dataset.testMidJump = 'true'
                window.addEventListener('release-fixture-prompt-scroll', () => original.call(this, options), { once: true })
                return
            }
            original.call(this, options)
        }
    })
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await expect(page.locator('.chat-scroll-y')).toHaveAttribute('data-test-mid-jump', 'true')
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before'))).toHaveLength(0)
    await page.evaluate(() => window.dispatchEvent(new Event('release-fixture-prompt-scroll')))
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Already loaded prompt' })
    await expect(prompt).toBeInViewport()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(1)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-preload-after-settlement.png` })
})


test('keeps following new output after loading an older page that completes a short chat', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.hover()
    await reply.getByRole('button', { name: 'Jump to conversation start' }).click()
    await page.evaluate(() => window.__probe.releaseBefore())
    await page.evaluate(() => window.__probe.appendReply())
    await expect(page.getByText('New reply line 25', { exact: true })).toBeInViewport()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/response-navigation-short-tail.png` })
})


for (const action of ['Jump to conversation start', 'Jump to turn input']) {
    test(`keeps live follow when ${action} cannot load history at the tail`, async ({ page }) => {
        await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1&failBefore=10')
        const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
        await reply.hover()
        await reply.getByRole('button', { name: action }).press('Enter')
        await page.evaluate(() => window.__probe.releaseBefore())
        await expect(page.getByText(/could not load (earlier messages|turn input)/i)).toBeVisible({ timeout: 15_000 })
        await page.evaluate(() => window.__probe.appendReply())
        await expect(page.getByText('New reply line 25', { exact: true })).toBeInViewport()
    })
}


for (const action of ['Jump to conversation start', 'Jump to turn input']) {
    test(`keeps keyboard focus on ${action} when the history request fails`, async ({ page }) => {
        await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&conciseLongTurn=1&failBefore=100')
        const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Concise reply after a long turn' })
        const button = reply.getByRole('button', { name: action })
        await button.press('Enter')
        await expect(button).toBeDisabled()
        await expect(button).toBeFocused()
        await expect(page.getByText(/could not load (earlier messages|turn input)/i)).toBeVisible({ timeout: 15_000 })
        await expect(button).toBeEnabled()
        await expect(button).toBeFocused()
        const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
        if (screenshots && action === 'Jump to turn input') await page.screenshot({ path: `${screenshots}/reply-navigation-keyboard-retry.png` })
    })
}

test('keeps following live output after finding the prompt of a short chat', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1')
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await reply.hover()
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect(page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt from the older page' })).toBeInViewport()
    await expect(page.getByText('Loading turn input…', { exact: true })).toHaveCount(0)
    await page.evaluate(() => window.__probe.appendReply())
    await expect(page.getByText('New reply line 25', { exact: true })).toBeInViewport()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-short-chat-follows-output.png` })
})


test('reply navigation finds the prompt after a prepend joins and re-keys the tail reply', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&rekeyReply=1')
    await page.addStyleTag({ content: '[data-hapi-message-role="assistant"] { min-height: 1200px; }' })
    const reply = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'Last part of the reply' })
    await expect(reply).toHaveAttribute('data-hapi-source-message-ids', 'm-3')
    const initialAnchor = await reply.getAttribute('id')
    await reply.hover()
    await reply.getByRole('button', { name: 'Jump to turn input' }).press('Enter')
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect(reply).not.toHaveAttribute('id', initialAnchor!)
    await expect(reply).toContainText('Earlier part of the reply')
    const prompt = page.locator('[data-hapi-turn-input="true"]').filter({ hasText: 'Prompt from the older page' })
    await expect(page.getByText('Reached turn input', { exact: true })).toBeVisible()
    await expect(prompt).toBeFocused()
    await expect(prompt).toBeInViewport({ ratio: 0.9 })
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/reply-navigation-rekeyed-reply.png` })
})
