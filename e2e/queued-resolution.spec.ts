import { expect, test, type Page, type Route } from '@playwright/test'

const fixture = '/e2e-fixtures/queued-resolution-fixture.html'
const messagePath = '/api/sessions/queued-resolution-fixture/messages/queued-resolution-message'
type ApiCall = { method: string; path: string; body: unknown }

async function mockApi(page: Page, respond: (route: Route, call: ApiCall) => Promise<void>) {
    const calls: ApiCall[] = []
    await page.route('**/api/sessions/**', async (route) => {
        const request = route.request()
        const call = {
            method: request.method(),
            path: new URL(request.url()).pathname,
            body: request.postDataJSON(),
        }
        calls.push(call)
        await respond(route, call)
    })
    return calls
}

for (const variant of [
    { name: 'desktop', locale: 'en', viewport: { width: 1440, height: 900 }, mobile: false,
        title: 'Remove this message?', confirm: 'Confirm', pending: 'Removing…', cancel: 'Cancel',
        warning: 'The delivery outcome of this message is still unknown. Removing it stops HAPI from waiting for confirmation or resending it. This cannot undo any execution that may already have happened.',
        error: 'This message cannot be removed yet.' },
    { name: 'phone', locale: 'zh-CN', viewport: { width: 390, height: 844 }, mobile: true,
        title: '移除这条消息？', confirm: '确定', pending: '正在移除…', cancel: '取消',
        warning: '这条消息的发送结果尚未确认。移除后，HAPI 将停止等待确认，也不会重新发送它。此操作无法撤销可能已经发生的执行。',
        error: '暂时无法移除这条消息。' },
]) {
    test.describe(`queued resolution ${variant.name}`, () => {
        test.use({ viewport: variant.viewport, isMobile: variant.mobile, hasTouch: variant.mobile })
        const pageErrors = new WeakMap<Page, string[]>()

        test.beforeEach(async ({ page }) => {
            const errors: string[] = []
            pageErrors.set(page, errors)
            page.on('pageerror', (error) => errors.push(error.message))
            await page.addInitScript((locale) => {
                localStorage.setItem('hapi-lang', locale)
            }, variant.locale)
        })

        test.afterEach(async ({ page }) => {
            expect(pageErrors.get(page)).toEqual([])
        })

        test('X opens confirmation and dismissing it leaves unknown input unchanged', async ({ page }, testInfo) => {
            const calls = await mockApi(page, (route) => route.fulfill({ status: 500, json: { error: 'Unexpected API call' } }))
            await page.goto(fixture)
            const row = page.getByRole('listitem')
            await expect(row).toContainText('Please continue the previous task')
            await expect(row.getByRole('button', { name: variant.confirm, exact: true })).toHaveCount(0)
            const before = await page.evaluate(() => window.__queuedResolutionFixture.getMessages())
            await page.screenshot({ path: testInfo.outputPath(`${variant.name}-row.png`) })
            await row.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
            const dialog = page.getByRole('dialog')
            await expect(dialog.getByRole('heading')).toHaveText(variant.title)
            const titleLayout = await dialog.getByRole('heading').evaluate((heading) => {
                const range = document.createRange()
                range.selectNodeContents(heading)
                const text = range.getBoundingClientRect()
                const panel = heading.closest('[role="dialog"]')!.getBoundingClientRect()
                return {
                    align: getComputedStyle(heading).textAlign,
                    centerOffset: Math.abs((text.left + text.width / 2) - (panel.left + panel.width / 2)),
                }
            })
            expect(titleLayout.align).toBe('center')
            expect(titleLayout.centerOffset).toBeLessThanOrEqual(1)
            await expect(dialog.getByText(variant.warning, { exact: true })).toBeVisible()
            await expect(dialog.getByRole('button', { name: variant.confirm, exact: true })).toBeVisible()
            await expect(dialog.getByRole('button', { name: variant.confirm, exact: true })).toHaveClass(/bg-red-600/)
            const bounds = await dialog.boundingBox()
            expect(bounds).not.toBeNull()
            expect(bounds!.x).toBeGreaterThanOrEqual(0)
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(variant.viewport.width)
            await expect(page.locator('body')).toHaveJSProperty('scrollWidth', variant.viewport.width)
            await page.screenshot({ path: testInfo.outputPath(`${variant.name}-dialog.png`) })
            await dialog.getByRole('button', { name: variant.cancel, exact: true }).click()
            await expect(dialog).toHaveCount(0)
            await expect(row).toBeVisible()
            expect(await page.evaluate(() => window.__queuedResolutionFixture.getMessages())).toEqual(before)
            expect(calls).toEqual([])
        })

        test('confirmation waits for acknowledgement, blocks double submission and removes the chip', async ({ page }, testInfo) => {
            let release!: () => void
            const held = new Promise<void>((resolve) => { release = resolve })
            const calls = await mockApi(page, async (route, call) => {
                if (call.method === 'DELETE') {
                    await route.fulfill({ json: { status: 'busy', localId: 'queued-resolution-local' } })
                    return
                }
                await held
                await route.fulfill({ json: { status: 'abandoned', localId: 'queued-resolution-local' } })
            })
            await page.goto(fixture)
            await page.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
            const dialog = page.getByRole('dialog')
            await dialog.getByRole('button', { name: variant.confirm, exact: true }).click()
            try {
                await expect.poll(() => calls.length).toBe(2)
                expect(calls).toEqual([
                    { method: 'DELETE', path: messagePath, body: null },
                    { method: 'POST', path: `${messagePath}/abandon`, body: { confirm: true } },
                ])
                await expect(dialog.getByRole('button', { name: variant.pending, exact: true })).toBeDisabled()
                await expect(page.getByRole('listitem', { includeHidden: true })).toBeVisible()
            } finally {
                release()
            }
            await expect(dialog).toHaveCount(0)
            await expect(page.getByRole('listitem')).toHaveCount(0)
            await expect(page.getByText('Please continue the previous task', { exact: false })).toHaveCount(0)
            expect(await page.evaluate(() => window.__queuedResolutionFixture.getMessages())).toEqual([])
            await page.screenshot({ path: testInfo.outputPath(`${variant.name}-removed.png`) })
            expect(calls).toHaveLength(2)
        })

        test('unavailable resolution keeps the chip and can be retried explicitly', async ({ page }) => {
            const calls = await mockApi(page, (route, call) => route.fulfill({ json: {
                status: call.method === 'DELETE' ? 'busy' : calls.length === 2 ? 'unavailable' : 'abandoned', localId: 'queued-resolution-local',
            } }))
            await page.goto(fixture)
            await page.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
            const dialog = page.getByRole('dialog')
            await dialog.getByRole('button', { name: variant.confirm, exact: true }).click()
            await expect(dialog).toContainText(variant.error)
            await expect(page.getByRole('listitem', { includeHidden: true })).toBeVisible()
            await dialog.getByRole('button', { name: variant.confirm, exact: true }).click()
            await expect(dialog).toHaveCount(0)
            await expect(page.getByRole('listitem')).toHaveCount(0)
            expect(calls).toHaveLength(4)
            expect(calls.filter(call => call.path === `${messagePath}/abandon`)).toHaveLength(2)
        })

        test('offline cancellation can still remove native queued input after reconnection', async ({ page }) => {
            let cancelAttempts = 0
            const calls = await mockApi(page, (route, call) => {
                if (call.method === 'DELETE') {
                    cancelAttempts++
                    return route.fulfill({ json: { status: cancelAttempts === 1 ? 'busy' : 'cancelled', localId: 'queued-resolution-local' } })
                }
                if (call.path.endsWith('/queued-state')) {
                    return route.fulfill({ json: { queuedLocalIds: [], indeterminateLocalIds: ['queued-resolution-local'], invokedLocalMessages: [] } })
                }
                return route.fulfill({ status: 500, json: { error: 'Unexpected abandonment' } })
            })
            await page.goto(`${fixture}?kind=queued`)
            await page.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
            await expect.poll(() => calls.some(call => call.path.endsWith('/queued-state'))).toBe(true)
            const remove = page.getByRole('button', { name: 'Cancel queued message', exact: true })
            await expect(remove).toBeEnabled()
            await remove.click()
            await page.getByRole('dialog').getByRole('button', { name: variant.confirm, exact: true }).click()
            await expect(page.getByRole('listitem')).toHaveCount(0)
            await expect(page.getByRole('dialog')).toHaveCount(0)
            expect(cancelAttempts).toBe(2)
            expect(calls.some(call => call.path.endsWith('/abandon'))).toBe(false)
        })

        test('keeps authoritative consumption received before a delayed removal response', async ({ page }) => {
            let release!: () => void
            const held = new Promise<void>(resolve => { release = resolve })
            const calls = await mockApi(page, async (route, call) => {
                if (call.method === 'DELETE') {
                    await route.fulfill({ json: { status: 'busy', localId: 'queued-resolution-local' } })
                    return
                }
                await held
                await route.fulfill({ json: { status: 'abandoned', localId: 'queued-resolution-local' } })
            })
            await page.goto(fixture)
            await page.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
            await page.getByRole('dialog').getByRole('button', { name: variant.confirm, exact: true }).click()
            try {
                await expect.poll(() => calls.length).toBe(2)
                await page.evaluate(() => window.__queuedResolutionFixture.receiveConsumption())
            } finally { release() }
            await expect.poll(() => page.evaluate(() => window.__queuedResolutionFixture.pendingMutations())).toBe(0)
            await expect(page.getByRole('dialog')).toHaveCount(0)
            await expect(page.getByRole('listitem')).toHaveCount(0)
            await expect.poll(() => page.evaluate(() => window.__queuedResolutionFixture.getMessages().map(row => row.invokedAt))).toEqual([2000])
        })

        for (const kind of ['queued', 'scheduled']) {
            test(`X cancels ${kind} input directly without opening the resolution dialog`, async ({ page }) => {
                const calls = await mockApi(page, (route) => route.fulfill({ json: {
                    status: 'cancelled', localId: 'queued-resolution-local',
                } }))
                await page.goto(`${fixture}?kind=${kind}`)
                await page.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
                await expect(page.getByRole('listitem')).toHaveCount(0)
                await expect(page.getByRole('dialog')).toHaveCount(0)
                await expect.poll(() => calls.length).toBe(1)
                expect(calls).toEqual([{ method: 'DELETE', path: messagePath, body: null }])
            })
        }
    })
}
