/**
 * Tests for the POST /sessions/:id/messages route.
 *
 * Covers:
 * - #2  server-side scheduledAt upper bound (7-day cap)
 * - #4  Zod error details exposed in response body (issues field)
 */
import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

// TS note: engine is cast to unknown→SyncEngine so test helpers don't need to
// satisfy the full SyncEngine shape (only the subset the route under test uses).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(opts: {
    active?: boolean
    sendMessage?: (sessionId: string, payload: unknown) => Promise<void>
}) {
    const sentMessages: Array<{ sessionId: string; payload: unknown }> = []
    const sendMessage = opts.sendMessage ?? (async (sessionId: string, payload: unknown) => {
        sentMessages.push({ sessionId, payload })
    })

    const engine = {
        resolveSessionAccess: () => ({
            ok: true,
            sessionId: 'session-1',
            session: { id: 'session-1', active: opts.active !== false }
        }),
        sendMessage,
        cancelQueuedMessage: async () => ({ status: 'cancelled' }),
        getMessagesPage: () => ({ messages: [], page: {} }),
        getMessagesPageByPosition: () => ({ messages: [], page: {} }),
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine as SyncEngine))

    return { app, sentMessages }
}

// ---------------------------------------------------------------------------
// #2 server-side scheduledAt upper bound
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/messages — #2 scheduledAt upper bound', () => {
    it('rejects scheduledAt more than 7 days in the future with 400 and clear message', async () => {
        const { app } = createApp({})

        const eightDaysMs = Date.now() + 8 * 24 * 60 * 60 * 1000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-1', scheduledAt: eightDaysMs })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: { _errors?: string[] } }
        expect(body.error).toBe('Invalid body')
        // #4: issues field must be present
        expect(body.issues).toBeDefined()
        // The 7-day message must appear somewhere in the issues
        const issuesStr = JSON.stringify(body.issues)
        expect(issuesStr).toContain('7 days')
    })

    it('accepts scheduledAt exactly at the 7-day boundary (inclusive)', async () => {
        const { app, sentMessages } = createApp({})

        // Use slightly less than 7 days to avoid flakiness at the exact boundary
        const nearlySevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000 - 1000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-2', scheduledAt: nearlySevenDays })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
    })

    it('accepts null scheduledAt (immediate send)', async () => {
        const { app, sentMessages } = createApp({})

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-3', scheduledAt: null })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
    })

    it('accepts missing scheduledAt (immediate send)', async () => {
        const { app, sentMessages } = createApp({})

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello' })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
    })
})

// ---------------------------------------------------------------------------
// #4 Zod error details in response body
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/messages — #4 Zod error issues in response', () => {
    it('returns issues when scheduledAt is set but localId is missing', async () => {
        const { app } = createApp({})

        const futureMs = Date.now() + 60_000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', scheduledAt: futureMs })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: unknown }
        expect(body.error).toBe('Invalid body')
        expect(body.issues).toBeDefined()
        const issuesStr = JSON.stringify(body.issues)
        expect(issuesStr).toContain('localId')
    })

    it('returns issues with a non-string text field', async () => {
        const { app } = createApp({})

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 123 })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: unknown }
        expect(body.error).toBe('Invalid body')
        expect(body.issues).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// HAPI Bot R3 finding 3: scheduledAt + attachments rejected
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/messages — scheduledAt + attachments rejected', () => {
    it('rejects scheduledAt combined with non-empty attachments with 400', async () => {
        const { app, sentMessages } = createApp({})

        const futureMs = Date.now() + 60_000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'hello',
                localId: 'local-att',
                scheduledAt: futureMs,
                attachments: [{ id: 'att-1', filename: 'a.png', mimeType: 'image/png', size: 10, path: '/tmp/a.png' }]
            })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: unknown }
        expect(body.error).toBe('Invalid body')
        const issuesStr = JSON.stringify(body.issues)
        expect(issuesStr).toContain('attachments')
        expect(sentMessages).toHaveLength(0)
    })

    it('accepts scheduledAt with empty attachments array', async () => {
        const { app, sentMessages } = createApp({})

        const futureMs = Date.now() + 60_000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'hello',
                localId: 'local-att-2',
                scheduledAt: futureMs,
                attachments: []
            })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
    })

    it('accepts immediate send with attachments (no scheduledAt)', async () => {
        const { app, sentMessages } = createApp({})

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'hello',
                attachments: [{ id: 'att-2', filename: 'b.png', mimeType: 'image/png', size: 10, path: '/tmp/b.png' }]
            })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
    })
})
