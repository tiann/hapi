import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { ScheduledAttachmentValidationError } from './scheduledAttachmentValidation'
import { SyncEngine } from './syncEngine'

/**
 * Tests for scratchlist v2 (tiann/hapi#893) wiring at the SyncEngine /
 * SessionCache layer:
 *   - every successful mutation emits a `session-updated` SyncEvent
 *     carrying `scratchlistUpdatedAt`
 *   - failed mutations (entry not found, duplicate) emit nothing
 *   - the patch is namespace-scoped to the session's own namespace so
 *     the SSE manager doesn't broadcast across operators
 *
 * The web client uses the patch as a refetch trigger; the timestamp
 * itself is the only signal, the entries arrive via the dedicated
 * `/api/sessions/:id/scratchlist` GET endpoint.
 */

function createCapturingPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('SessionCache.emitScratchlistChanged', () => {
    it('emits a session-updated patch carrying scratchlistUpdatedAt', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        const session = cache.getOrCreateSession(
            'tag',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        // Drain spawn events so we can assert on the scratchlist
        // emission alone.
        events.length = 0

        cache.emitScratchlistChanged(session.id, 9999)

        expect(events).toHaveLength(1)
        const event = events[0]!
        expect(event.type).toBe('session-updated')
        if (event.type !== 'session-updated') throw new Error('unreachable')
        expect(event.sessionId).toBe(session.id)
        expect(event.namespace).toBe('default')
        expect(event.data).toEqual({ scratchlistUpdatedAt: 9999 })
    })

    it('does not emit when the session is unknown (no namespace to scope to)', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        cache.emitScratchlistChanged('does-not-exist', 9999)
        expect(events).toHaveLength(0)
    })
})

describe('SyncEngine scratchlist mutations emit session-updated patches', () => {
    function setup() {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        // We attach the EventPublisher to SyncEngine via a private field
        // path so the route-layer surface (createScratchlistEntry, etc.)
        // exercises the same code path used in production. We only need
        // the cache for `getOrCreateSession`; the engine reuses the
        // store internally.
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        // SyncEngine constructs its own SessionCache internally - shimming
        // the inner one would be brittle. Use the engine's events stream
        // directly via subscription.
        const engineEvents: SyncEvent[] = []
        engine.subscribe((e) => { engineEvents.push(e) })
        return { engine, store, events, cache, engineEvents }
    }

    it('createScratchlistEntry emits a session-updated patch on success', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-create',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        // Drain events from the spawn so we can assert on the mutation
        // emission alone.
        engineEvents.length = 0

        const result = engine.createScratchlistEntry(session.id, 'note', { entryId: 'e1' })
        expect(result.outcome).toBe('created')

        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)
        const patch = matching[0]
        if (!patch || patch.type !== 'session-updated') throw new Error('unreachable')
        expect(patch.sessionId).toBe(session.id)
        expect(patch.namespace).toBe('default')

        engine.stop()
    })

    it('updateScratchlistEntry emits a session-updated patch on success', async () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-update',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'before', { entryId: 'e1' })
        engineEvents.length = 0

        const updated = await engine.updateScratchlistEntry(session.id, 'e1', { text: 'after' })
        expect(updated).not.toBeNull()
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)

        engine.stop()
    })

    it('updateScratchlistEntry on a missing entry emits nothing', async () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-update-missing',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engineEvents.length = 0
        const updated = await engine.updateScratchlistEntry(session.id, 'never-existed', { text: 'whatever' })
        expect(updated).toBeNull()
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })

    it('keeps attachment validation and mutation under the same lock as deletion', async () => {
        const { engine } = setup()
        const session = engine.getOrCreateSession(
            'tag-update-atomic',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'before', { entryId: 'e1' })

        const attachment = {
            id: '11111111-1111-4111-8111-111111111111',
            filename: 'a.png',
            mimeType: 'image/png',
            size: 3,
            path: `hapi-hub:scratchlist/default/${session.id}/a.png`,
        }
        let releaseValidation!: () => void
        const validationStarted = new Promise<void>((resolve) => {
            releaseValidation = resolve
        })
        let continueValidation!: () => void
        const validationPaused = new Promise<void>((resolve) => {
            continueValidation = resolve
        })

        engine.resolveScratchlistAttachmentsForSession = async () => {
            releaseValidation()
            await validationPaused
            return { ok: true as const, attachments: [attachment] }
        }
        engine.sumScratchlistAttachmentBytesOnDisk = async () => 0

        let deleteFinished = false
        const updatePromise = engine.updateScratchlistEntryAtomic(
            session.id,
            'e1',
            { text: 'after', attachments: [attachment] },
        )
        await validationStarted
        const deletePromise = engine.deleteScratchlistEntry(session.id, 'e1').then((removed) => {
            deleteFinished = true
            return removed
        })

        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(deleteFinished).toBe(false)

        continueValidation()
        const updated = await updatePromise
        expect(updated.outcome).toBe('updated')
        expect(await deletePromise).toBe(true)
        expect(engine.listScratchlistEntries(session.id)).toHaveLength(0)
        engine.stop()
    })

    it('deleteScratchlistEntry emits a session-updated patch on success', async () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-delete',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'doomed', { entryId: 'e1' })
        engineEvents.length = 0
        const removed = await engine.deleteScratchlistEntry(session.id, 'e1')
        expect(removed).toBe(true)
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)
        engine.stop()
    })

    it('deletes the Hub file when an immediate staged copy keeps the id but changes the path', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-immediate-staged-cleanup-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
        )
        try {
            const session = engine.getOrCreateSession(
                'immediate-staged-cleanup',
                { path: '/tmp', host: 'localhost', flavor: 'codex' },
                null,
                'default',
            )
            const { readScratchlistAttachmentFile, writeScratchlistAttachmentFile } =
                await import('../scratchlistAttachments/storage')
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                session.id,
                'image.png',
                'image/png',
                Buffer.from('image'),
                'immediate-staged-attachment',
            )
            const created = engine.createScratchlistEntry(session.id, 'image draft', {
                entryId: 'immediate-staged-draft',
                attachments: [attachment],
            })
            expect(created.outcome).toBe('created')

            // The immediate CLI copy keeps the attachment id but replaces the
            // Hub path with a transient upload path before acknowledgement.
            store.messages.addMessage(
                session.id,
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'image draft',
                        attachments: [{ ...attachment, path: '/tmp/cli-upload-image.png' }],
                    },
                },
                'immediate-staged-local',
            )

            expect(await readScratchlistAttachmentFile(hapiHome, attachment.path)).not.toBeNull()
            expect(await engine.deleteScratchlistEntry(session.id, 'immediate-staged-draft')).toBe(true)
            expect(await readScratchlistAttachmentFile(hapiHome, attachment.path)).toBeNull()
        } finally {
            engine.stop()
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('rejects duplicate scheduled Hub attachments before queueing the message', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-duplicate-scheduled-attachment-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
        )
        try {
            const session = engine.getOrCreateSession(
                'duplicate-scheduled-attachment',
                { path: '/tmp', host: 'localhost', flavor: 'codex' },
                null,
                'default',
            )
            const { writeScratchlistAttachmentFile } = await import('../scratchlistAttachments/storage')
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                session.id,
                'duplicate.png',
                'image/png',
                Buffer.from('duplicate'),
                '22222222-2222-4222-8222-222222222222',
            )

            await expect(engine.sendMessage(session.id, {
                text: 'duplicate attachment',
                localId: 'duplicate-scheduled-message',
                scheduledAt: Date.now() + 60_000,
                attachments: [attachment, attachment],
            })).rejects.toBeInstanceOf(ScheduledAttachmentValidationError)
            expect(store.messages.getUninvokedLocalMessages(session.id)).toHaveLength(0)
        } finally {
            engine.stop()
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('rejects a missing scheduled Hub attachment with a typed validation error', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-missing-scheduled-attachment-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
        )
        try {
            const session = engine.getOrCreateSession(
                'missing-scheduled-attachment',
                { path: '/tmp', host: 'localhost', flavor: 'codex' },
                null,
                'default',
            )
            const attachment = {
                id: '33333333-3333-4333-8333-333333333333',
                filename: 'missing.png',
                mimeType: 'image/png',
                size: 10,
                path: `hapi-hub:scratchlist/default/${session.id}/33333333-3333-4333-8333-333333333333-missing.png`,
            }

            await expect(engine.sendMessage(session.id, {
                text: 'missing attachment',
                localId: 'missing-scheduled-message',
                scheduledAt: Date.now() + 60_000,
                attachments: [attachment],
            })).rejects.toBeInstanceOf(ScheduledAttachmentValidationError)
            expect(store.messages.getUninvokedLocalMessages(session.id)).toHaveLength(0)
        } finally {
            engine.stop()
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('deleteScratchlistEntry on a missing entry emits nothing', async () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-delete-missing',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engineEvents.length = 0
        const removed = await engine.deleteScratchlistEntry(session.id, 'no-such-entry')
        expect(removed).toBe(false)
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })

    it('conditionally deletes only when the scratchlist revision is unchanged', async () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-delete-revision',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'before', { entryId: 'e1' })
        const original = engine.getScratchlistEntry(session.id, 'e1')
        if (!original) throw new Error('expected scratchlist entry')
        await engine.updateScratchlistEntry(session.id, 'e1', { text: 'edited' })
        engineEvents.length = 0

        expect(await engine.deleteScratchlistEntryIfUnchanged(
            session.id,
            'e1',
            original.updatedAt,
        )).toBe('revision-mismatch')
        expect(engine.getScratchlistEntry(session.id, 'e1')?.text).toBe('edited')
        expect(engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )).toHaveLength(0)

        const edited = engine.getScratchlistEntry(session.id, 'e1')
        if (!edited) throw new Error('expected edited scratchlist entry')
        expect(await engine.deleteScratchlistEntryIfUnchanged(
            session.id,
            'e1',
            edited.updatedAt,
        )).toBe('deleted')
        expect(engine.getScratchlistEntry(session.id, 'e1')).toBeNull()
        engine.stop()
    })

    it('createScratchlistEntry on duplicate does not emit an extra patch', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-dup',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'first', { entryId: 'dup' })
        engineEvents.length = 0
        const result = engine.createScratchlistEntry(session.id, 'second', { entryId: 'dup' })
        if (result.outcome === 'session-not-found') throw new Error('unexpected')
        expect(result.outcome).toBe('duplicate')
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })

    it('reorderScratchlistEntries persists the ordered ids and emits one patch', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-reorder',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'first', { entryId: 'e1' })
        engine.createScratchlistEntry(session.id, 'second', { entryId: 'e2' })
        engine.createScratchlistEntry(session.id, 'third', { entryId: 'e3' })
        engineEvents.length = 0

        const reordered = engine.reorderScratchlistEntries(session.id, ['e1', 'e3', 'e2'])
        expect(reordered?.map((entry) => entry.entryId)).toEqual(['e1', 'e3', 'e2'])
        expect(reordered?.map((entry) => entry.position)).toEqual([0, 1, 2])
        expect(engine.listScratchlistEntries(session.id).map((entry) => entry.entryId))
            .toEqual(['e1', 'e3', 'e2'])

        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)
        engine.stop()
    })

    it('rejects a reorder payload that does not cover the full list', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-reorder-invalid',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'note', { entryId: 'e1' })
        engineEvents.length = 0

        expect(engine.reorderScratchlistEntries(session.id, [])).toBeNull()
        expect(engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )).toHaveLength(0)
        engine.stop()
    })
})

describe('SyncEngine session connection generations', () => {
    it('reconciles consumed scheduled Hub attachments when the engine starts', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-reconcile-consumed-startup-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        let engine: SyncEngine | undefined
        try {
            const session = store.sessions.getOrCreateSession(
                'reconcile-consumed-startup',
                { path: '/tmp', host: 'localhost', flavor: 'codex' },
                null,
                'default',
            )
            const { sumScratchlistAttachmentBytesOnDisk, writeScratchlistAttachmentFile } =
                await import('../scratchlistAttachments/storage')
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                session.id,
                'consumed.png',
                'image/png',
                Buffer.from('consumed'),
            )
            const message = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'consumed', attachments: [attachment] } },
                'reconcile-consumed-startup',
                Date.now() - 1_000,
            )
            store.messages.markMessagesInvoked(session.id, [message.localId!], Date.now())

            engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never,
            )
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', session.id) === 0) break
                await new Promise<void>((resolve) => setTimeout(resolve, 10))
            }
            expect(await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', session.id)).toBe(0)
        } finally {
            engine?.stop()
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('does not rescan message history on inactivity ticks after startup reconciliation', async () => {
        const store = new Store(':memory:')
        store.sessions.getOrCreateSession(
            'reconcile-no-periodic-rescan',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default',
        )
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
        )
        try {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            const getAllMessages = spyOn(store.messages, 'getAllMessages')

            ;(engine as unknown as { expireInactive(): void }).expireInactive()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))

            expect(getAllMessages).not.toHaveBeenCalled()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('retries only the session whose consumed attachment cleanup failed', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
        )
        const messageService = (engine as unknown as {
            messageService: {
                releaseConsumedScheduledAttachments: (sessionId: string, localIds: string[]) => Promise<void>
                reconcileConsumedScheduledAttachments: (sessionId: string) => Promise<void>
            }
        }).messageService
        let releaseAttempts = 0
        const release = spyOn(messageService, 'releaseConsumedScheduledAttachments')
            .mockImplementation(async () => {
                releaseAttempts += 1
                if (releaseAttempts === 1) throw new Error('temporary cleanup failure')
            })
        const reconcile = spyOn(messageService, 'reconcileConsumedScheduledAttachments')
            .mockResolvedValue(undefined)
        const error = spyOn(console, 'error').mockImplementation(() => {})
        try {
            engine.handleRealtimeEvent({
                type: 'messages-consumed',
                sessionId: 'cleanup-retry-session',
                localIds: [],
                invokedAt: Date.now(),
            })
            await new Promise<void>((resolve) => setTimeout(resolve, 0))

            engine.handleRealtimeEvent({
                type: 'messages-consumed',
                sessionId: 'cleanup-retry-session',
                localIds: [],
                invokedAt: Date.now(),
            })
            await new Promise<void>((resolve) => setTimeout(resolve, 0))

            ;(engine as unknown as { expireInactive(): void }).expireInactive()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))

            expect(release).toHaveBeenCalledTimes(2)
            expect(reconcile).toHaveBeenCalledTimes(1)
            expect(reconcile).toHaveBeenCalledWith('cleanup-retry-session')
        } finally {
            release.mockRestore()
            reconcile.mockRestore()
            error.mockRestore()
            engine.stop()
            store.close()
        }
    })

    it('does not invalidate scheduled attachment paths on same-client reconnects', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const clearCalls: string[] = []
        const messageService = (engine as unknown as {
            messageService: {
                clearScheduledAttachmentDeliveryCache: (sessionId: string) => void
            }
        }).messageService
        messageService.clearScheduledAttachmentDeliveryCache = (sessionId) => {
            clearCalls.push(sessionId)
        }

        engine.handleSessionConnected('generation-session', 'client-a')
        engine.handleSessionConnected('generation-session', 'client-a')
        engine.handleSessionReady({ sid: 'generation-session', time: Date.now() })
        engine.handleSessionConnected('generation-session', 'client-b')

        expect(clearCalls).toEqual(['generation-session', 'generation-session'])
        engine.stop()
    })

    it('flushes reconnect cleanup after session-alive registers CLI RPC handlers', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const messageService = (engine as unknown as {
            messageService: {
                flushScheduledAttachmentDeliveryCleanup: (sessionId: string) => Promise<void>
            }
        }).messageService
        const flush = spyOn(messageService, 'flushScheduledAttachmentDeliveryCleanup')
            .mockResolvedValue(undefined)
        try {
            engine.handleSessionAlive({ sid: 'reconnect-cleanup-session', time: Date.now() })
            expect(flush).toHaveBeenCalledWith('reconnect-cleanup-session')
        } finally {
            flush.mockRestore()
            engine.stop()
            store.close()
        }
    })
})
