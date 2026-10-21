import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import type { SessionReadState } from '../../shared/src/sessionReadState'

test.describe('session read state across isolated devices', () => {
    test.skip(process.env.HAPI_LIVE !== '1' || !process.env.HAPI_READ_SYNC_TEST_URL,
        'Set HAPI_LIVE=1 and HAPI_READ_SYNC_TEST_URL for an explicitly isolated seeded Hub')

    test('recovers a closed offline tab without randomUUID or sessionStorage', async ({ browser, request }) => {
        const baseUrl = process.env.HAPI_READ_SYNC_TEST_URL ?? process.env.HAPI_URL
        const accessToken = process.env.HAPI_ACCESS_TOKEN
        if (!baseUrl || !accessToken || /:3006(?:\/|$)/.test(baseUrl)) throw new Error('Explicit isolated Hub URL and token required')
        const auth = await request.post(`${baseUrl}/api/auth`, { data: { accessToken } })
        expect(auth.ok()).toBe(true)
        const { token } = await auth.json() as { token: string }
        const headers = { authorization: `Bearer ${token}` }
        const id = 'read-sync-fixture-c'
        const sessions = await (await request.get(`${baseUrl}/api/sessions`, { headers })).json() as {
            sessions: Array<{ id: string; updatedAt: number }>
        }
        const session = sessions.sessions.find(row => row.id === id)!
        expect(session).toBeTruthy()
        const readState = async () => {
            const response = await request.get(`${baseUrl}/api/session-read-state`, { headers })
            return (await response.json() as { states: SessionReadState[] }).states.find(row => row.sessionId === id)
        }
        const current = await readState()
        const response = await request.post(`${baseUrl}/api/session-read-state`, { headers, data: { mutations: [{
            mutationId: crypto.randomUUID(), sessionId: id, kind: 'seen', activityAt: session.updatedAt,
            expectedVersion: current?.version ?? 0
        }] } })
        expect(response.ok()).toBe(true)
        const context = await browser.newContext({ serviceWorkers: 'block' })
        try {
            await context.addInitScript(({ url, access }) => {
                localStorage.setItem(`hapi_access_token::${url}`, access)
                localStorage.setItem('hapi-session-list-status-mode', 'detailed')
                localStorage.setItem('hapi-language', 'en')
                Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
            }, { url: baseUrl, access: accessToken })
            const page = await context.newPage()
            await page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded' })
            const row = page.locator('button.session-list-item').filter({ hasText: 'Read sync C' })
            await expect(row).toBeVisible()
            await context.setOffline(true)
            await row.dispatchEvent('contextmenu', { clientX: 120, clientY: 180 })
            await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click()
            await expect(row.locator('span.rounded-full[class*="--app-link"]')).toBeVisible()
            await page.close()
            await context.setOffline(false)
            const reopened = await context.newPage()
            await reopened.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded' })
            await expect.poll(async () => (await readState())?.manualUnreadAt, { timeout: 75000 }).toBe(session.updatedAt)
            await expect(reopened.locator('button.session-list-item').filter({ hasText: 'Read sync C' })
                .locator('span.rounded-full[class*="--app-link"]')).toBeVisible()
        } finally { await context.close() }
    })

    test('desktop/mobile share read, manual unread, bulk read, filtering, badge, reload and offline recovery', async ({ browser, request }) => {
        const baseUrl = process.env.HAPI_READ_SYNC_TEST_URL ?? process.env.HAPI_URL
        const accessToken = process.env.HAPI_ACCESS_TOKEN
        if (!baseUrl || !accessToken || /:3006(?:\/|$)/.test(baseUrl)) throw new Error('Explicit isolated Hub URL and token required')
        const auth = await request.post(`${baseUrl}/api/auth`, { data: { accessToken } })
        expect(auth.ok()).toBe(true)
        const { token } = await auth.json() as { token: string }
        const headers = { authorization: `Bearer ${token}` }
        const snapshots = async () => {
            const response = await request.get(`${baseUrl}/api/session-read-state`, { headers })
            expect(response.ok()).toBe(true)
            return (await response.json() as { states: SessionReadState[] }).states
        }
        const { sessions } = await (await request.get(`${baseUrl}/api/sessions`, { headers })).json() as {
            sessions: Array<{ id: string; updatedAt: number }>
        }
        const fixtures = sessions.filter(session => session.id.startsWith('read-sync-fixture-'))
        expect(fixtures).toHaveLength(3)
        const current = await snapshots()
        const reset = await request.post(`${baseUrl}/api/session-read-state`, { headers, data: { mutations: fixtures.map(session => ({
            mutationId: crypto.randomUUID(),
            sessionId: session.id, kind: 'unread', activityAt: session.updatedAt,
            expectedVersion: current.find(state => state.sessionId === session.id)?.version ?? 0
        })) } })
        expect(reset.ok()).toBe(true)

        const contexts: BrowserContext[] = []
        const openDevice = async (mobile: boolean) => {
            const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 412, height: 915 } : { width: 1440, height: 1000 } })
            contexts.push(context)
            await context.addInitScript(({ url, access }) => {
                localStorage.setItem(`hapi_access_token::${url}`, access)
                localStorage.setItem('hapi-session-list-status-mode', 'detailed')
                localStorage.setItem('hapi-language', 'en')
                localStorage.setItem('hapi-app-badge-enabled', 'true')
                const originalMatchMedia = window.matchMedia.bind(window)
                Object.defineProperty(window, 'matchMedia', { value: (query: string) => query === '(display-mode: standalone)' ? ({
                    matches: true, media: query,
                    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true }
                }) : originalMatchMedia(query) })
                Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async (count: number) => {
                    (window as unknown as { badgeCount: number }).badgeCount = count
                } })
                Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => {
                    (window as unknown as { badgeCount: number }).badgeCount = 0
                } })
            }, { url: baseUrl, access: accessToken })
            const page = await context.newPage()
            page.setDefaultTimeout(15000)
            await page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await expect(row(page, 'A')).toBeVisible()
            return { page, context }
        }
        const row = (page: Page, suffix: string) => page.locator('button.session-list-item').filter({ hasText: `Read sync ${suffix}` })
        const unread = (page: Page, suffix: string) => row(page, suffix).locator('span.rounded-full[class*="--app-link"]')
        const badge = (page: Page) => page.evaluate(() => (window as unknown as { badgeCount: number }).badgeCount)
        const markUnread = async (page: Page, suffix: string) => {
            // Exercise the row's context-menu action independently of the existing
            // left-scrollbar hit-testing issue on desktop Chromium.
            await row(page, suffix).dispatchEvent('contextmenu', { clientX: 120, clientY: 180 })
            await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click()
        }
        try {
            const desktop = await openDevice(false)
            const mobile = await openDevice(true)
            await expect(unread(desktop.page, 'A')).toBeVisible()
            await expect(unread(mobile.page, 'A')).toBeVisible()
            await expect.poll(() => badge(mobile.page)).toBe(3)

            await desktop.page.bringToFront()
            await row(desktop.page, 'A').press('Enter')
            await expect.poll(async () => (await snapshots()).find(s => s.sessionId === 'read-sync-fixture-a')?.manualUnreadAt).toBeNull()
            await expect(unread(mobile.page, 'A')).toHaveCount(0)
            await expect.poll(() => badge(mobile.page)).toBe(2)
            await desktop.page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await markUnread(desktop.page, 'A')
            await expect(unread(mobile.page, 'A')).toBeVisible()
            await expect.poll(() => badge(mobile.page)).toBe(3)
            await expect.poll(async () => (await snapshots()).find(s => s.sessionId === 'read-sync-fixture-a')?.manualUnreadAt).not.toBeNull()

            await mobile.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
            await expect(unread(mobile.page, 'A')).toBeVisible()
            await desktop.page.getByRole('button', { name: /Mark all as read/ }).click()
            const dialog = desktop.page.getByRole('dialog')
            await expect(dialog.getByText(/across your devices/)).toBeVisible()
            await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
            for (const suffix of ['A', 'B', 'C']) await expect(unread(mobile.page, suffix)).toHaveCount(0)
            await expect.poll(() => badge(mobile.page)).toBe(0)

            // Offline manual-unread intent is retained, but an intervening peer action wins.
            await desktop.context.setOffline(true)
            await markUnread(desktop.page, 'B')
            await expect(unread(desktop.page, 'B')).toBeVisible()
            await markUnread(mobile.page, 'B')
            await expect.poll(async () => (await snapshots()).find(s => s.sessionId === 'read-sync-fixture-b')?.manualUnreadAt).not.toBeNull()
            await desktop.context.setOffline(false)
            await expect(unread(desktop.page, 'B')).toBeVisible()
            await desktop.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
            await expect(unread(desktop.page, 'B')).toBeVisible()
            await expect(unread(desktop.page, 'A')).toHaveCount(0)
            await mobile.page.getByRole('button', { name: 'Unread only', exact: true }).click()
            await expect(row(mobile.page, 'B')).toBeVisible()
            await expect(row(mobile.page, 'A')).toHaveCount(0)
            await expect(row(mobile.page, 'C')).toHaveCount(0)
            await expect.poll(() => badge(mobile.page)).toBe(1)
        } finally { await Promise.allSettled(contexts.map(context => context.close({ reason: 'Test complete' }))) }
    })
})
