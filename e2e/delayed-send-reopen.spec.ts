import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const scenario of ['delayed send', 'durable recovery', 'scratchlist queue'] as const) {
    test(scenario === 'delayed send'
        ? 'a successful delayed send keeps the reopened editor and new draft'
        : scenario === 'durable recovery'
            ? 'a full reload restores canceled queued text and schedule'
            : 'resuming to queue a scratchlist note preserves the existing composer draft', async ({ page }) => {
        const session = {
            id: 'delayed-send-fixture', namespace: 'default', seq: 1,
            createdAt: 1700000000000, updatedAt: 1700000000000,
            active: scenario !== 'scratchlist queue', activeAt: Date.now(), thinking: false, thinkingAt: 0,
            metadataVersion: 1, agentStateVersion: 0, agentState: null,
            metadata: { name: 'Delayed send fixture', host: 'fixture', path: '/synthetic/project', flavor: 'codex', codexSessionId: 'fixture-thread' },
            model: null, modelReasoningEffort: null, effort: null,
        }
        await page.addInitScript(({ scratchlistQueue, sessionId }) => {
            localStorage.setItem(`hapi_access_token::${location.origin}`, 'delayed-send-fixture')
            localStorage.setItem('hapi-lang', 'en')
            localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
            localStorage.setItem('hapi.fue.v1.scratchlist-toggle', '1')
            if (scratchlistQueue && !sessionStorage.getItem('hapi:composer-drafts')) {
                sessionStorage.setItem('hapi:composer-drafts', JSON.stringify({ [sessionId]: 'Keep this separate draft' }))
            }
        }, { scratchlistQueue: scenario === 'scratchlist queue', sessionId: session.id })
        const posted = Promise.withResolvers<void>()
        const allowResponse = Promise.withResolvers<void>()
        await page.route(url => url.pathname.startsWith('/api/'), async route => {
            const path = new URL(route.request().url()).pathname
            if (path === '/api/auth') await route.fulfill({ json: { token: 'synthetic-jwt', user: { id: 1, username: 'fixture' } } })
            else if (path === '/api/features') await route.fulfill({ json: { githubPrAwareness: { enabled: false, envPinned: false } } })
            else if (path === '/api/sessions') await route.fulfill({ json: { sessions: [session] } })
            else if (path === `/api/sessions/${session.id}/resume`) {
                session.active = true
                await route.fulfill({ json: { sessionId: session.id } })
            } else if (path === `/api/sessions/${session.id}`) await route.fulfill({ json: { session } })
            else if (path.endsWith('/messages') && route.request().method() === 'POST') {
                posted.resolve()
                await allowResponse.promise
                await route.fulfill({ json: { ok: true } })
            } else if (path.endsWith('/messages')) {
                await route.fulfill({ json: { messages: [], page: { direction: 'latest', limit: 20, epoch: 0,
                    reset: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null,
                    nextAfterSeq: null, snapshotHeadAt: null, snapshotHeadSeq: null, hasMore: false } } })
            } else if (path.endsWith('/scratchlist')) await route.fulfill({ json: { entries: scenario === 'scratchlist queue' ? [
                { entryId: 'queued-note', text: 'Note to queue', createdAt: Date.now(), updatedAt: Date.now(), attachments: [] },
            ] : [] } })
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
                        composerTextAtEdit: 'Previously submitted', automaticallyCleared: true, pendingScheduleAtEdit: null,
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
        if (scenario === 'scratchlist queue') {
            await expect(editor).toHaveText('Keep this separate draft')
            await composer.getByRole('button', { name: 'Scratchlist drawer' }).click()
            await expect(page.getByText('Note to queue', { exact: true })).toBeVisible()
            try {
                const response = page.waitForResponse(r => r.url().endsWith(`/sessions/${session.id}/messages`) && r.request().method() === 'POST')
                await page.getByRole('button', { name: 'Send to queue', exact: true }).click()
                await posted.promise
                allowResponse.resolve()
                const queuedResponse = await response
                expect(queuedResponse.ok()).toBe(true)
                expect(queuedResponse.request().postDataJSON()).toMatchObject({ text: 'Note to queue', deliveryMode: 'queue' })
                await expect(editor).toHaveText('Keep this separate draft')
                expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem('hapi:composer-drafts') ?? '{}')[id], session.id)).toBe('Keep this separate draft')
                if (process.env.HAPI_SCRATCHLIST_SCREENSHOT) await page.screenshot({ path: process.env.HAPI_SCRATCHLIST_SCREENSHOT, animations: 'disabled' })
            } finally { allowResponse.resolve() }
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
