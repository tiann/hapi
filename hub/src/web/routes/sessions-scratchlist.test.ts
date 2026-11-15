import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

/**
 * Tests for the scratchlist v2 (tiann/hapi#893) REST routes:
 *   GET    /api/sessions/:id/scratchlist
 *   POST   /api/sessions/:id/scratchlist
 *   PUT    /api/sessions/:id/scratchlist/reorder
 *   PUT    /api/sessions/:id/scratchlist/:entryId
 *   DELETE /api/sessions/:id/scratchlist/:entryId
 *
 * The routes call into a small surface on `SyncEngine` (list/create/
 * reorder/update/delete + count). We mock that surface here so the assertions
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
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
    return { ...base, ...overrides }
}

type EngineOverrides = Partial<{
    listScratchlistEntries: SyncEngine['listScratchlistEntries']
    countScratchlistEntries: SyncEngine['countScratchlistEntries']
    getScratchlistEntry: SyncEngine['getScratchlistEntry']
    createScratchlistEntry: SyncEngine['createScratchlistEntry']
    reorderScratchlistEntries: SyncEngine['reorderScratchlistEntries']
    updateScratchlistEntry: SyncEngine['updateScratchlistEntry']
    updateScratchlistEntryAtomic: SyncEngine['updateScratchlistEntryAtomic']
    deleteScratchlistEntry: SyncEngine['deleteScratchlistEntry']
    deleteScratchlistEntryIfUnchanged: SyncEngine['deleteScratchlistEntryIfUnchanged']
    deleteScratchlistAttachmentById: SyncEngine['deleteScratchlistAttachmentById']
    readScratchlistAttachment: SyncEngine['readScratchlistAttachment']
    canDeleteScratchlistAttachment: SyncEngine['canDeleteScratchlistAttachment']
    withScratchlistAttachmentLock: SyncEngine['withScratchlistAttachmentLock']
    sessionAccess: 'ok' | 'not-found' | 'wrong-namespace'
    callerNamespace: string
}>

function createApp(session: Session, overrides: EngineOverrides = {}) {
    const updateScratchlistEntry = overrides.updateScratchlistEntry
        ?? (async (_sessionId: string, entryId: string, patch: { text?: string; attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; path: string }> }) => ({
            entryId,
            text: patch.text ?? '',
            createdAt: 1000,
            updatedAt: 2000,
            position: 0,
            attachments: patch.attachments ?? [],
        }))
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
        reorderScratchlistEntries: overrides.reorderScratchlistEntries ?? (() => []),
        countScratchlistEntries: overrides.countScratchlistEntries ?? (() => 0),
        sumScratchlistAttachmentBytes: () => 0,
        getScratchlistEntry: overrides.getScratchlistEntry ?? (() => null),
        createScratchlistEntry: overrides.createScratchlistEntry
            ?? ((sessionId: string, text: string) => ({
                outcome: 'created' as const,
                entry: {
                    entryId: `auto-${Date.now()}`,
                    text,
                    createdAt: 1000,
                    updatedAt: 1000,
                    position: 0,
                    attachments: [],
                }
            })),
        updateScratchlistEntry,
        updateScratchlistEntryAtomic: overrides.updateScratchlistEntryAtomic
            ?? (async (sessionId: string, entryId: string, patch: { text?: string; attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; path: string }> }, namespace: string) => {
                const existing = (overrides.getScratchlistEntry ?? (() => null))(sessionId, entryId)
                if (!existing) return { outcome: 'not-found' as const }
                const text = patch.text !== undefined ? patch.text.trim() : existing.text
                const attachments = patch.attachments ?? existing.attachments
                if (text.length === 0 && attachments.length === 0) {
                    return {
                        outcome: 'invalid' as const,
                        error: 'Scratchlist entry requires text or attachments',
                        code: 'scratchlist_entry_empty',
                    }
                }
                const updated = await updateScratchlistEntry(
                    sessionId,
                    entryId,
                    { text, attachments },
                    namespace,
                )
                return updated
                    ? { outcome: 'updated' as const, entry: updated }
                    : { outcome: 'not-found' as const }
            }),
        deleteScratchlistEntry: overrides.deleteScratchlistEntry ?? (() => true),
        deleteScratchlistEntryIfUnchanged: overrides.deleteScratchlistEntryIfUnchanged
            ?? (async () => 'deleted' as const),
        readScratchlistAttachment: overrides.readScratchlistAttachment ?? (async () => null),
        canDeleteScratchlistAttachment: overrides.canDeleteScratchlistAttachment ?? (() => true),
        resolveScratchlistAttachmentsForSession: async (
            _sessionId: string,
            _namespace: string,
            claimed: Array<{ id: string; filename: string; mimeType: string; size: number; path: string }>
        ) => ({ ok: true as const, attachments: claimed }),
        sumScratchlistAttachmentBytesOnDisk: async () => 0,
        deleteScratchlistAttachmentById: overrides.deleteScratchlistAttachmentById ?? (async () => true),
        withScratchlistAttachmentLock: overrides.withScratchlistAttachmentLock
            ?? (async (_namespace: string, _sessionId: string, fn: () => Promise<unknown>) => fn()),
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
                { entryId: 'a', text: 'note A', createdAt: 1000, updatedAt: 1000, position: 0, attachments: [] },
                { entryId: 'b', text: 'note B', createdAt: 2000, updatedAt: 2500, position: 1, attachments: [] }
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

describe('GET /api/sessions/:id/scratchlist/attachments/:attachmentId', () => {
    it('serves non-ASCII filenames with an RFC 5987-safe content disposition', async () => {
        const session = createSession()
        const attachment = {
            id: '11111111-1111-4111-8111-111111111111',
            filename: '截图.png',
            mimeType: 'image/png',
            size: 3,
            path: 'hapi-hub:scratchlist/default/session-1/11111111-1111-4111-8111-111111111111-截图.png',
        }
        const app = createApp(session, {
            listScratchlistEntries: () => [{
                entryId: 'entry-1',
                text: '',
                createdAt: 1000,
                updatedAt: 1000,
                position: 0,
                attachments: [attachment],
            }],
            readScratchlistAttachment: async () => ({
                buffer: Buffer.from([1, 2, 3]),
                mimeType: 'image/png',
                filename: attachment.filename,
            }),
        })

        const res = await app.request(
            `/api/sessions/session-1/scratchlist/attachments/${attachment.id}`,
        )

        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('image/png')
        expect(res.headers.get('content-disposition')).toBe(
            `inline; filename="__.png"; filename*=UTF-8''%E6%88%AA%E5%9B%BE.png`,
        )
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
    })
})

describe('POST /api/sessions/:id/scratchlist', () => {
    it('creates an entry and returns 201 with the canonical row', async () => {
        const session = createSession()
        const calls: Array<{ sessionId: string; text: string; entryId?: string; createdAt?: number; position?: number }> = []
        const app = createApp(session, {
            createScratchlistEntry: (sessionId, text, options) => {
                calls.push({ sessionId, text, entryId: options?.entryId, createdAt: options?.createdAt, position: options?.position })
                return {
                    outcome: 'created' as const,
                    entry: {
                        entryId: options?.entryId ?? 'fresh-id',
                        text,
                        createdAt: options?.createdAt ?? 1000,
                        updatedAt: 1000,
                        position: options?.position ?? 0,
                        attachments: options?.attachments ?? [],
                    }
                }
            }
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'first thought', position: 3 })
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { entry: { text: string; entryId: string } }
        expect(body.entry.text).toBe('first thought')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.sessionId).toBe('session-1')
        expect(calls[0]?.position).toBe(3)
    })

    it('keeps scratchlist insertion inside the attachment lifecycle lock', async () => {
        const session = createSession()
        let lockDepth = 0
        let createLockDepth = 0
        const app = createApp(session, {
            withScratchlistAttachmentLock: async (_namespace, _sessionId, fn) => {
                lockDepth += 1
                try {
                    return await fn()
                } finally {
                    lockDepth -= 1
                }
            },
            createScratchlistEntry: (sessionId, text, options) => {
                createLockDepth = lockDepth
                return {
                    outcome: 'created' as const,
                    entry: {
                        entryId: options?.entryId ?? 'with-attachment',
                        text,
                        createdAt: 1000,
                        updatedAt: 1000,
                        position: options?.position ?? 0,
                        attachments: options?.attachments ?? [],
                    }
                }
            }
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'keep this file',
                attachments: [{
                    id: '11111111-1111-4111-8111-111111111111',
                    filename: 'image.png',
                    mimeType: 'image/png',
                    size: 3,
                    path: 'hapi-hub:scratchlist/default/session-1/11111111-1111-4111-8111-111111111111-image.png',
                }],
            })
        })

        expect(res.status).toBe(201)
        expect(createLockDepth).toBe(1)
        expect(lockDepth).toBe(0)
    })

    it('returns 200 with the existing row on duplicate (migration idempotency path)', async () => {
        const session = createSession()
        const app = createApp(session, {
            createScratchlistEntry: () => ({
                outcome: 'duplicate' as const,
                entry: { entryId: 'dup', text: 'pre-existing', createdAt: 100, updatedAt: 100, position: 0, attachments: [] }
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

    it('still returns 200 for a duplicate entryId even when the session is at the cap (HAPI Bot, PR #896)', async () => {
        // The cap check used to fire BEFORE the duplicate check, which
        // turned an idempotent migration retry into a hard 409 the
        // moment a session reached `SCRATCHLIST_MAX_ENTRIES`. The fix
        // short-circuits on getScratchlistEntry first; this test pins
        // that ordering.
        const session = createSession()
        const createCalls: number[] = []
        const app = createApp(session, {
            countScratchlistEntries: () => 200,
            getScratchlistEntry: (_sessionId, entryId) => {
                if (entryId === 'pre-existing') {
                    return {
                        entryId: 'pre-existing',
                        text: 'already there',
                        createdAt: 100,
                        updatedAt: 100,
                        position: 0,
                        attachments: [],
                    }
                }
                return null
            },
            createScratchlistEntry: () => {
                createCalls.push(1)
                return {
                    outcome: 'created' as const,
                    entry: { entryId: 'should-not-fire', text: 'noop', createdAt: 0, updatedAt: 0, position: 0, attachments: [] }
                }
            }
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'replay', entryId: 'pre-existing' })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { entry: { text: string; entryId: string } }
        expect(body.entry.entryId).toBe('pre-existing')
        expect(body.entry.text).toBe('already there')
        // The route must NOT have called createScratchlistEntry: the
        // duplicate short-circuit returns BEFORE reaching the engine.
        expect(createCalls).toHaveLength(0)
    })

    it('still returns 409 for a NEW entryId at the cap', async () => {
        // Mirror of the test above for the not-duplicate case: a fresh
        // POST at cap stays a 409.
        const session = createSession()
        const app = createApp(session, {
            countScratchlistEntries: () => 200,
            getScratchlistEntry: () => null
        })
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'fresh', entryId: 'never-seen' })
        })
        expect(res.status).toBe(409)
    })

    it('rejects oversized entryId with 400 (HAPI Bot, PR #896 follow-up)', async () => {
        // Server-side guard for the SQLite primary key: an authenticated
        // client could otherwise grow the table and its index with
        // arbitrarily large keys. 129 chars is one over the 128-char
        // cap defined in SCRATCHLIST_MAX_ENTRY_ID_LENGTH.
        const session = createSession()
        const app = createApp(session)
        const res = await app.request('/api/sessions/session-1/scratchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'oversized id', entryId: 'x'.repeat(129) })
        })
        expect(res.status).toBe(400)
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

describe('PUT /api/sessions/:id/scratchlist/reorder', () => {
    it('returns the canonical order from the engine', async () => {
        const session = createSession()
        const calls: string[][] = []
        const app = createApp(session, {
            reorderScratchlistEntries: (_sessionId, entryIds) => {
                calls.push(entryIds)
                return entryIds.map((entryId, position) => ({
                    entryId,
                    text: entryId,
                    createdAt: 1000,
                    updatedAt: 1000,
                    position,
                    attachments: [],
                }))
            }
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/reorder', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryIds: ['b', 'a'] })
        })
        expect(res.status).toBe(200)
        expect(calls).toEqual([['b', 'a']])
        const body = await res.json() as { entries: Array<{ entryId: string; position: number }> }
        expect(body.entries.map((entry) => entry.entryId)).toEqual(['b', 'a'])
        expect(body.entries.map((entry) => entry.position)).toEqual([0, 1])
    })

    it('rejects a reorder payload with duplicate ids', async () => {
        const session = createSession()
        const app = createApp(session)
        const res = await app.request('/api/sessions/session-1/scratchlist/reorder', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryIds: ['a', 'a'] })
        })
        expect(res.status).toBe(400)
    })
})

describe('PUT /api/sessions/:id/scratchlist/:entryId', () => {
    it('returns the updated entry on success', async () => {
        const session = createSession()
        const app = createApp(session, {
            getScratchlistEntry: () => ({
                entryId: 'entry-1',
                text: 'before',
                createdAt: 1000,
                updatedAt: 1000,
                position: 0,
                attachments: [],
            }),
            updateScratchlistEntry: async (_sessionId, entryId, patch) => ({
                entryId,
                text: patch.text ?? 'before',
                createdAt: 1000,
                updatedAt: 5000,
                position: 0,
                attachments: patch.attachments ?? [],
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
            getScratchlistEntry: () => null,
            updateScratchlistEntry: async () => null
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

    it('rejects clearing attachments on a textless entry (would leave an empty row)', async () => {
        const session = createSession()
        const app = createApp(session, {
            getScratchlistEntry: () => ({
                entryId: 'entry-1',
                text: '',
                createdAt: 1000,
                updatedAt: 1000,
                position: 0,
                attachments: [{
                    id: '11111111-1111-4111-8111-111111111111',
                    filename: 'a.png',
                    mimeType: 'image/png',
                    size: 3,
                    path: 'hapi-hub:scratchlist/default/session-1/11111111-1111-4111-8111-111111111111-a.png',
                }],
            }),
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/entry-1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attachments: [] })
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { code?: string }
        expect(body.code).toBe('scratchlist_entry_empty')
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

describe('DELETE /api/sessions/:id/scratchlist/attachments/:attachmentId', () => {
    it('returns 409 when an uninvoked scheduled message still references the attachment', async () => {
        const session = createSession()
        let deleteCalled = false
        const app = createApp(session, {
            canDeleteScratchlistAttachment: () => false,
            deleteScratchlistAttachmentById: async () => {
                deleteCalled = true
                return true
            },
        })
        const res = await app.request(
            '/api/sessions/session-1/scratchlist/attachments/11111111-1111-4111-8111-111111111111',
            { method: 'DELETE' },
        )
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ code: 'scratchlist_attachment_scheduled' })
        expect(deleteCalled).toBe(false)
    })
})

describe('DELETE /api/sessions/:id/scratchlist/:entryId', () => {
    it('returns ok:true when the row was removed', async () => {
        const session = createSession()
        const app = createApp(session, {
            deleteScratchlistEntry: async () => true
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
            deleteScratchlistEntry: async () => false
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/missing', {
            method: 'DELETE'
        })
        expect(res.status).toBe(404)
    })

    it('conditionally removes only the revision sent by the client', async () => {
        const session = createSession()
        let received: { sessionId: string; entryId: string; expectedUpdatedAt: number } | null = null
        const app = createApp(session, {
            deleteScratchlistEntryIfUnchanged: async (sessionId, entryId, expectedUpdatedAt) => {
                received = { sessionId, entryId, expectedUpdatedAt }
                return 'deleted'
            },
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/e1?expectedUpdatedAt=1234', {
            method: 'DELETE',
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ deleted: true })
        expect(received as { sessionId: string; entryId: string; expectedUpdatedAt: number } | null).toEqual({
            sessionId: 'session-1',
            entryId: 'e1',
            expectedUpdatedAt: 1234,
        })
    })

    it('keeps an edited row when the conditional revision no longer matches', async () => {
        const session = createSession()
        const app = createApp(session, {
            deleteScratchlistEntryIfUnchanged: async () => 'revision-mismatch',
        })
        const res = await app.request('/api/sessions/session-1/scratchlist/e1?expectedUpdatedAt=1234', {
            method: 'DELETE',
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ deleted: false, reason: 'revision-mismatch' })
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
