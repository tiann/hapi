import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const scenario of ['delayed send', 'durable recovery'] as const) {
    test(scenario === 'delayed send'
        ? 'a successful delayed send keeps the reopened editor and new draft'
        : 'a full reload restores canceled queued text and schedule', async ({ page }) => {
        const session = {
            id: 'delayed-send-fixture', namespace: 'default', seq: 1,
            createdAt: 1700000000000, updatedAt: 1700000000000,
            active: true, activeAt: Date.now(), thinking: false, thinkingAt: 0,
            metadataVersion: 1, agentStateVersion: 0, agentState: null,
            metadata: { name: 'Delayed send fixture', host: 'fixture', path: '/synthetic/project', flavor: 'codex', codexSessionId: 'fixture-thread' },
            model: null, modelReasoningEffort: null, effort: null,
        }
        await page.addInitScript(() => {
            localStorage.setItem(`hapi_access_token::${location.origin}`, 'delayed-send-fixture')
            localStorage.setItem('hapi-lang', 'en')
            localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
        })
        const posted = Promise.withResolvers<void>()
        const allowResponse = Promise.withResolvers<void>()
        await page.route(url => url.pathname.startsWith('/api/'), async route => {
            const path = new URL(route.request().url()).pathname
            if (path === '/api/auth') await route.fulfill({ json: { token: 'synthetic-jwt', user: { id: 1, username: 'fixture' } } })
            else if (path === '/api/features') await route.fulfill({ json: { githubPrAwareness: { enabled: false, envPinned: false } } })
            else if (path === '/api/sessions') await route.fulfill({ json: { sessions: [session] } })
            else if (path === `/api/sessions/${session.id}`) await route.fulfill({ json: { session } })
            else if (path.endsWith('/messages') && route.request().method() === 'POST') {
                posted.resolve()
                await allowResponse.promise
                await route.fulfill({ json: { ok: true } })
            } else if (path.endsWith('/messages')) {
                await route.fulfill({ json: { messages: [], page: { direction: 'latest', limit: 20, epoch: 0,
                    reset: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null,
                    nextAfterSeq: null, snapshotHeadAt: null, snapshotHeadSeq: null, hasMore: false } } })
            } else if (path.endsWith('/scratchlist')) await route.fulfill({ json: { entries: [] } })
            else if (path === '/api/machines') await route.fulfill({ json: { machines: [] } })
            else if (path === '/api/events') await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
            else await route.fulfill({ json: {} })
        })
        await page.goto(`/sessions/${session.id}`)
        const composer = page.getByTestId('composer-shell')
        const editor = composer.getByRole('textbox')
        const expand = composer.getByRole('button', { name: 'Expand message editor' })
        if (scenario === 'durable recovery') {
            // Seed the record written off-route after DELETE and the earlier send
            // finish. The unit tests exercise both possible settlement orderings.
            await expect(editor).toBeVisible()
            await page.evaluate(id => {
                sessionStorage.setItem('hapi:queued-edit-recovery', JSON.stringify({
                    [id]: {
                        id: 'fixture-recovery', text: 'Canceled queued draft',
                        pendingSchedule: { type: 'absolute', ms: Date.now() + 30 * 60_000 },
                        composerTextAtEdit: '', pendingScheduleAtEdit: null,
                    },
                }))
            }, session.id)
            await page.reload()
            await expect(editor).toHaveText('Canceled queued draft')
            const schedule = composer.getByRole('button', { name: 'Schedule send', exact: true })
            await expect(schedule).toHaveClass(/bg-blue-500/)
            if (process.env.HAPI_RECOVERY_SCREENSHOT) await page.screenshot({ path: process.env.HAPI_RECOVERY_SCREENSHOT })
            await schedule.click()
            await expect(schedule).not.toHaveClass(/bg-blue-500/)
            return
        }
        await editor.fill('First message')
        const response = page.waitForResponse(r => r.url().endsWith(`/sessions/${session.id}/messages`) && r.request().method() === 'POST')
        try {
            await composer.getByRole('button', { name: 'Send', exact: true }).click()
            await posted.promise
            await expand.click()
            await expect(composer).toHaveAttribute('data-expanded', 'true')
        } finally {
            allowResponse.resolve()
        }
        expect((await response).ok()).toBe(true)
        await expect(composer.getByRole('button', { name: 'Collapse message editor' })).toBeVisible()
        await editor.fill('New draft after the earlier send')
        await expect(composer).toHaveAttribute('data-expanded', 'true')
        if (process.env.HAPI_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.HAPI_REVIEW_SCREENSHOT })
    })
}
