import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

/**
 * Tests for the scratchlist v2 (tiann/hapi#893) REST routes:
 *   GET    /api/sessions/:id/scratchlist
 *   POST   /api/sessions/:id/scratchlist
 *   PUT    /api/sessions/:id/scratchlist/:entryId
 *   DELETE /api/sessions/:id/scratchlist/:entryId
 *
 * The routes call into a small surface on `SyncEngine` (list/create/
 * update/delete + count). We mock that surface here so the assertions
 * focus on:
 *   - happy-path response shapes
 *   - auth + namespace gating via `requireSessionFromParam`
 *   - validation (text required, max length)
 *   - cap enforcement at SCRATCHLIST_MAX_ENTRIES
 *   - 404 paths (missing session, missing entry)
 *   - 200 vs 201 split (created vs duplicate during migration retries)
 *
 * SSE emission is exercised at the SyncEngine + SessionCache layer in a
 * separate test (`syncEngine-scratchlist.test.ts`).
 */

function createSession(overrides?: Partial<Session>): Session {
    const baseMetadata = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex' as const
    }
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: baseMetadata,
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        modelReasoningEffort: null,
        effort: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
    return { ...base, ...overrides }
}

type EngineOverrides = Partial<{
    listScratchlistEntries: SyncEngine['listScratchlistEntries']
    countScratchlistEntries: SyncEngine['countScratchlistEntries']
    createScratchlistEntry: SyncEngine['createScratchlistEntry']
    updateScratchlistEntry: SyncEngine['updateScratchlistEntry']
    deleteScratchlistEntry: SyncEngine['deleteScratchlistEntry']
    sessionAccess: 'ok' | 'not-found' | 'wrong-namespace'
    callerNamespace: string
}>

function createApp(session: Session, overrides: EngineOverrides = {}) {
    const engine = {
        resolveSessionAccess: () => {
            if (overrides.sessionAccess === 'not-found') {
                return { ok: false, reason: 'not-found' as const }
            }
            if (overrides.sessionAccess === 'wrong-namespace') {
                return { ok: false, reason: 'access-denied' as const }
            }
            return { ok: true, sessionId: session.id, session }
        },
        listScratchlistEntries: overrides.listScratchlistEntries ?? (() => []),
        countScratchlistEntries: overrides.countScratchlistEntries ?? (() => 0),
        createScratchlistEntry: overrides.createScratchlistEntry
            ?? ((sessionId: string, text: string) => ({
                outcome: 'created' as const,
                entry: {
                    entryId: `auto-${Date.now()}`,
                    text,
                    createdAt: 1000,
                    updatedAt: 1000
                }
            })),
        updateScratchlistEntry: overrides.updateScratchlistEntry
            ?? ((sessionId: string, entryId: string, text: string) => ({
                entryId,
                text,
                createdAt: 1000,
                updatedAt: 2000
            })),
        deleteScratchlistEntry: overrides.deleteScratchlistEntry ?? (() => true)
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', overrides.callerNamespace ?? 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))
    return app
}

describe('GET /api/sessions/:id/scratchlist', () => {
    it('returns the entries returned by the engine', async () => {
        const session = createSession()
        const app = createApp(session, {
            listScratchlistEntries: () => [
                { entryId: 'a', text: 'note A', createdAt: 1000, updatedAt: 1000 },
                { entryId: 'b', text: 'note B', createdAt: 2000, updatedAt: 2500 }
            ]
        })
        const res = await app.request('/api/sessions/session-1/scratchlist')
        expect(res.status).toBe(200)
        const body = await res.json() as { entries: Array<{ entryId: string }> }
        expect(body.entries.map((e) => e.entryId)).toEqual(['a', 'b'])
    })

    it('returns 404 when the session is not visible to the caller', async () => {
        const session = createSession()
        const app = createApp(session, { sessionAccess: 'not-found' })
        const res = await app.request('/api/sessions/session-1/scratchlist')
        expect(res.status).toBe(404)
    })

    it('returns 403 when the session belongs to a different namespace', async () => {
        const session = createSession({ namespace: 'other' })
        const app = createApp(session, { sessionAccess: 'wrong-namespace' })
        const res = await app.request('/api/sessions/session-1/scratchlist')
        expect(res.status).toBe(403)
    })
})

describe('POST /api/sessions/:id/scratchlist', () => {
    it('creates an entry and returns 201 with the canonical row', async () => {
        const session = createSession()
        const calls: Array<{ sessionId: string; text: string; entryId?: string; createdAt?: number }> = []
        const app = createApp(session, {
            createScratchlistEntry: (sessionId, text, options) => {
                calls.push({ sessionId, text, entryId: options?.entryId, createdAt: options?.createdAt })
                return {
                    outcome: 'created' as const,
                    entry: {
                        entryId: options?.entryId ?? 'fresh-id',
                        text,
                        createdAt: options?.createdAt ?? 1000,
                        updatedAt: 1000
                    }
                }
            }
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'first thought' })
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { entry: { text: string; entryId: string } }
        expect(body.entry.text).toBe('first thought')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.sessionId).toBe('session-1')
    })

    it('returns 200 with the existing row on duplicate (migration idempotency path)', async () => {
        const session = createSession()
        const app = createApp(session, {
            createScratchlistEntry: () => ({
                outcome: 'duplicate' as const,
                entry: { entryId: 'dup', text: 'pre-existing', createdAt: 100, updatedAt: 100 }
            })
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'replay', entryId: 'dup' })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { entry: { text: string } }
        expect(body.entry.text).toBe('pre-existing')
    })

    it('rejects empty text with 400', async () => {
        const session = createSession()
        const app = createApp(session)
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '' })
        })
        expect(res.status).toBe(400)
    })

    it('rejects oversize text (>10_000 chars) with 400', async () => {
        const session = createSession()
        const app = createApp(session)
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'x'.repeat(10_001) })
        })
        expect(res.status).toBe(400)
    })

    it('returns 409 when the session is at the cap', async () => {
        const session = createSession()
        const app = createApp(session, {
            countScratchlistEntries: () => 200
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'one too many' })
        })
        expect(res.status).toBe(409)
        const body = await res.json() as { code: string }
        expect(body.code).toBe('scratchlist_at_cap')
    })

    it('returns 404 when the engine reports session-not-found post-auth', async () => {
        // This path covers a race: auth said the session was visible
        // (resolveSessionAccess.ok), but by the time we INSERT the row the
        // session is gone. The engine returns `session-not-found` and the
        // route surfaces a 404.
        const session = createSession()
        const app = createApp(session, {
            createScratchlistEntry: () => ({ outcome: 'session-not-found' as const })
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'never lands' })
        })
        expect(res.status).toBe(404)
    })

    it('returns 404 when the session is not visible to the caller', async () => {
        const session = createSession()
        const app = createApp(session, { sessionAccess: 'not-found' })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'auth gate' })
        })
        expect(res.status).toBe(404)
    })
})

describe('PUT /api/sessions/:id/scratchlist/:entryId', () => {
    it('returns the updated entry on success', async () => {
        const session = createSession()
        const app = createApp(session, {
            updateScratchlistEntry: (_sessionId, entryId, text) => ({
                entryId,
                text,
                createdAt: 1000,
                updatedAt: 5000
            })
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/entry-1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'edited' })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { entry: { text: string; entryId: string } }
        expect(body.entry.text).toBe('edited')
        expect(body.entry.entryId).toBe('entry-1')
    })

    it('returns 404 when the entry does not exist', async () => {
        const session = createSession()
        const app = createApp(session, {
            updateScratchlistEntry: () => null
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/missing-id', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'oops' })
        })
        expect(res.status).toBe(404)
    })

    it('rejects empty text with 400', async () => {
        const session = createSession()
        const app = createApp(session)
        const res = await app.request('/api/sessions/session-1/scratchlist/e1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '' })
        })
        expect(res.status).toBe(400)
    })

    it('returns 403 when the session is in another namespace', async () => {
        const session = createSession({ namespace: 'other' })
        const app = createApp(session, { sessionAccess: 'wrong-namespace' })
        const res = await app.request('/api/sessions/session-1/scratchlist/e1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'cross-ns' })
        })
        expect(res.status).toBe(403)
    })
})

describe('DELETE /api/sessions/:id/scratchlist/:entryId', () => {
    it('returns ok:true when the row was removed', async () => {
        const session = createSession()
        const app = createApp(session, {
            deleteScratchlistEntry: () => true
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/e1', {
            method: 'DELETE'
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
    })

    it('returns 404 when the row did not exist', async () => {
        const session = createSession()
        const app = createApp(session, {
            deleteScratchlistEntry: () => false
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/missing', {
            method: 'DELETE'
        })
        expect(res.status).toBe(404)
    })

    it('returns 404 when the session is not visible to the caller', async () => {
        const session = createSession()
        const app = createApp(session, { sessionAccess: 'not-found' })
        const res = await app.request('/api/sessions/session-1/scratchlist/e1', {
            method: 'DELETE'
        })
        expect(res.status).toBe(404)
    })
})
