import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store, type StoredAttachment } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

const contexts: Array<{ store: Store; root: string }> = []

afterEach(() => {
    for (const { store, root } of contexts.splice(0)) {
        store.close()
        rmSync(root, { recursive: true, force: true })
    }
})

function setup() {
    const root = mkdtempSync(join(tmpdir(), 'hapi-session-attachments-'))
    const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
    const events: SyncEvent[] = []
    const publisher: EventPublisher = {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher)
    contexts.push({ store, root })
    return { store, cache, root }
}

function setupWithDeleteHooks(hooks: {
    beforeDeleteSession?: (sessionId: string) => Promise<void> | undefined
    afterDeleteSession?: (sessionId: string) => void
}) {
    const root = mkdtempSync(join(tmpdir(), 'hapi-session-attachments-hooks-'))
    const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
    const events: SyncEvent[] = []
    const publisher: EventPublisher = {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher, hooks)
    contexts.push({ store, root })
    return { store, cache, root, events }
}

function makeSessions(cache: SessionCache) {
    const oldSession = cache.getOrCreateSession(
        'attachment-merge-old-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        'default'
    )
    const newSession = cache.getOrCreateSession(
        'attachment-merge-new-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        'default'
    )
    return { oldSession, newSession }
}

describe('durable attachment session lifecycle', () => {
    it('moves attachments with merged message history before deleting the old session', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'photo.png',
            mimeType: 'image/png',
            original: Buffer.from('original')
        })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).toBeNull()
        expect(store.attachments.getForSession(attachment.id, 'default', newSession.id)).not.toBeNull()
        expect(existsSync(attachment.originalPath)).toBe(true)
    })

    it('rolls back message movement when attachment ownership transfer fails', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'atomic-merge.txt',
            mimeType: 'text/plain',
            original: Buffer.from('atomic merge')
        })
        const message = store.messages.addMessage(oldSession.id, {
            role: 'user',
            content: {
                type: 'text',
                text: 'atomic merge',
                attachments: [{
                    id: 'atomic-merge-attachment',
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    attachmentId: attachment.id
                }]
            }
        }, 'atomic-merge-message')
        const db = (store as unknown as { db: Database }).db
        db.exec(`
            CREATE TRIGGER fail_atomic_attachment_transfer
            BEFORE UPDATE OF session_id ON attachments
            BEGIN
                SELECT RAISE(ABORT, 'simulated attachment ownership failure');
            END;
        `)

        await expect(cache.mergeSessions(oldSession.id, newSession.id, 'default'))
            .rejects.toThrow('simulated attachment ownership failure')
        expect(store.messages.getAllMessages(oldSession.id).map((row) => row.id)).toEqual([message.id])
        expect(store.messages.getAllMessages(newSession.id)).toHaveLength(0)
        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).not.toBeNull()
        expect(store.attachments.getForSession(attachment.id, 'default', newSession.id)).toBeNull()
    })

    it('rolls back late attachment transfer when source deletion fails', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'late-atomic-finalize.txt',
            mimeType: 'text/plain',
            original: Buffer.from('late atomic finalize')
        })
        const db = (store as unknown as { db: Database }).db
        db.exec(`
            CREATE TRIGGER fail_late_atomic_session_delete
            BEFORE DELETE ON sessions
            WHEN OLD.id = '${oldSession.id}'
            BEGIN
                SELECT RAISE(ABORT, 'simulated final session deletion failure');
            END;
        `)

        expect(() => store.transferAttachmentsAndDeleteSession(
            'default', oldSession.id, newSession.id
        )).toThrow('simulated final session deletion failure')
        expect(store.sessions.getSessionByNamespace(oldSession.id, 'default')).not.toBeNull()
        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).not.toBeNull()
        expect(store.attachments.getForSession(attachment.id, 'default', newSession.id)).toBeNull()
    })

    it('rolls back message and attachment movement when merge deletion fails', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'merge-delete-failure.txt',
            mimeType: 'text/plain',
            original: Buffer.from('merge delete failure')
        })
        store.scratchlist.create(oldSession.id, 'merge delete failure note', { entryId: 'merge-delete-failure-note' })
        const message = store.messages.addMessage(oldSession.id, {
            role: 'user',
            content: {
                type: 'text',
                text: 'merge delete failure',
                attachments: [{
                    id: 'merge-delete-failure-attachment',
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    attachmentId: attachment.id
                }]
            }
        }, 'merge-delete-failure-message')
        const db = (store as unknown as { db: Database }).db
        db.exec(`
            CREATE TRIGGER fail_merge_source_delete
            BEFORE DELETE ON sessions
            WHEN OLD.id = '${oldSession.id}'
            BEGIN
                SELECT RAISE(ABORT, 'simulated merge source deletion failure');
            END;
        `)

        await expect(cache.mergeSessions(oldSession.id, newSession.id, 'default'))
            .rejects.toThrow('simulated merge source deletion failure')
        expect(store.messages.getAllMessages(oldSession.id).map((row) => row.id)).toEqual([message.id])
        expect(store.messages.getAllMessages(newSession.id)).toHaveLength(0)
        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).not.toBeNull()
        expect(store.attachments.getForSession(attachment.id, 'default', newSession.id)).toBeNull()
        expect(store.scratchlist.list(oldSession.id).map((entry) => entry.entryId)).toEqual(['merge-delete-failure-note'])
        expect(store.scratchlist.list(newSession.id)).toHaveLength(0)
    })

    it('rechecks source activity before final automatic consolidation deletion', async () => {
        let beforeDeleteCalls = 0
        let cache!: SessionCache
        const context = setupWithDeleteHooks({
            beforeDeleteSession: async (sessionId) => {
                beforeDeleteCalls += 1
                if (beforeDeleteCalls === 1) {
                    cache.getSession(sessionId)!.active = true
                }
            }
        })
        cache = context.cache
        const { oldSession, newSession } = makeSessions(cache)
        const attachment = await context.store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'activity-race.txt',
            mimeType: 'text/plain',
            original: Buffer.from('activity-race')
        })
        context.store.scratchlist.create(oldSession.id, 'activity race note', { entryId: 'activity-race-note' })
        const message = context.store.messages.addMessage(oldSession.id, {
            role: 'user',
            content: {
                type: 'text',
                text: 'activity race',
                attachments: [{
                    id: 'activity-race-attachment',
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    attachmentId: attachment.id
                }]
            }
        }, 'activity-race-message')

        await expect(cache.mergeSessions(oldSession.id, newSession.id, 'default'))
            .rejects.toThrow('Cannot merge a session that became active')
        expect(beforeDeleteCalls).toBe(1)
        expect(context.store.sessions.getSessionByNamespace(oldSession.id, 'default')).not.toBeNull()
        expect(context.store.sessions.getSessionByNamespace(newSession.id, 'default')).not.toBeNull()
        expect(context.store.messages.getAllMessages(oldSession.id).map((row) => row.id)).toEqual([message.id])
        expect(context.store.messages.getAllMessages(newSession.id)).toHaveLength(0)
        expect(context.store.attachments.getForSession(attachment.id, 'default', oldSession.id)).not.toBeNull()
        expect(context.store.attachments.getForSession(attachment.id, 'default', newSession.id)).toBeNull()
        expect(context.store.scratchlist.list(oldSession.id).map((entry) => entry.entryId)).toEqual(['activity-race-note'])
        expect(context.store.scratchlist.list(newSession.id)).toHaveLength(0)
    })

    it('aborts when scratchlist content changes during attachment preparation', async () => {
        let store!: Store
        const context = setupWithDeleteHooks({
            beforeDeleteSession: async (sessionId) => {
                store.scratchlist.update(sessionId, 'scratchlist-race', { text: 'edited during merge' })
            }
        })
        store = context.store
        const { oldSession, newSession } = makeSessions(context.cache)
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = context.root
        try {
            const { writeScratchlistAttachmentFile, sumScratchlistAttachmentBytesOnDisk } = await import(
                '../scratchlistAttachments/storage'
            )
            const attachment = await writeScratchlistAttachmentFile(
                context.root,
                'default',
                oldSession.id,
                'race.txt',
                'text/plain',
                Buffer.from('race')
            )
            store.scratchlist.create(oldSession.id, 'before merge', {
                entryId: 'scratchlist-race',
                attachments: [attachment],
            })

            await expect(context.cache.mergeSessions(oldSession.id, newSession.id, 'default'))
                .rejects.toThrow('Scratchlist changed during session merge; retry')
            expect(store.scratchlist.get(oldSession.id, 'scratchlist-race')?.text).toBe('edited during merge')
            expect(store.scratchlist.get(newSession.id, 'scratchlist-race')).toBeNull()
            expect(await sumScratchlistAttachmentBytesOnDisk(context.root, 'default', oldSession.id)).toBe(4)
            expect(await sumScratchlistAttachmentBytesOnDisk(context.root, 'default', newSession.id)).toBe(0)
        } finally {
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
        }
    })

    it('keeps unreferenced uploads on a live source during history-only merge', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const referenced = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'referenced.txt',
            mimeType: 'text/plain',
            original: Buffer.from('referenced')
        })
        const pending = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'pending.txt',
            mimeType: 'text/plain',
            original: Buffer.from('pending')
        })
        store.messages.addMessage(oldSession.id, {
            role: 'user',
            content: {
                type: 'text',
                text: 'history attachment',
                attachments: [{
                    id: 'history-attachment',
                    filename: referenced.filename,
                    mimeType: referenced.mimeType,
                    size: referenced.size,
                    attachmentId: referenced.id
                }]
            }
        }, 'history-attachment-message')

        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default')

        expect(store.attachments.getForSession(referenced.id, 'default', newSession.id)).not.toBeNull()
        expect(store.attachments.getForSession(referenced.id, 'default', oldSession.id)).toBeNull()
        expect(store.attachments.getForSession(pending.id, 'default', oldSession.id)).not.toBeNull()
        expect(store.attachments.getForSession(pending.id, 'default', newSession.id)).toBeNull()
    })

    it('transfers uploads completed during awaited merge work before deleting the source', async () => {
        let lateUploadPromise: Promise<StoredAttachment> | undefined
        let store!: Store
        let cache!: SessionCache
        const context = setupWithDeleteHooks({
            beforeDeleteSession: async (sessionId) => {
                lateUploadPromise = store.attachments.create({
                    namespace: 'default',
                    sessionId,
                    filename: 'late.txt',
                    mimeType: 'text/plain',
                    original: Buffer.from('late upload')
                })
                await lateUploadPromise
            }
        })
        store = context.store
        cache = context.cache
        const root = context.root
        const { oldSession, newSession } = makeSessions(cache)
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = root
        try {
            const merging = cache.mergeSessions(oldSession.id, newSession.id, 'default')
            const lateAttachment = await lateUploadPromise!
            expect(store.attachments.getForSession(lateAttachment.id, 'default', oldSession.id)).not.toBeNull()
            expect(store.attachments.getForSession(lateAttachment.id, 'default', newSession.id)).toBeNull()

            await merging
            expect(store.attachments.getForSession(lateAttachment.id, 'default', oldSession.id)).toBeNull()
            expect(store.attachments.getForSession(lateAttachment.id, 'default', newSession.id)).not.toBeNull()
            expect(existsSync(lateAttachment.originalPath)).toBe(true)
        } finally {
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
        }
    })

    it('removes durable attachment metadata and files when a session is deleted', async () => {
        const { store, cache } = setup()
        const { oldSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'document.txt',
            mimeType: 'text/plain',
            original: Buffer.from('content')
        })
        const cached = cache.getSession(oldSession.id)
        if (cached) cached.active = false

        await cache.deleteSession(oldSession.id)

        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).toBeNull()
        expect(existsSync(attachment.originalPath)).toBe(false)
    })

    it('preserves durable attachments when deleting the session row fails', async () => {
        const { store, cache } = setup()
        const { oldSession } = makeSessions(cache)
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: oldSession.id,
            filename: 'document.txt',
            mimeType: 'text/plain',
            original: Buffer.from('content')
        })
        const cached = cache.getSession(oldSession.id)
        if (cached) cached.active = false
        const deleteSession = spyOn(store.sessions, 'deleteSession').mockReturnValue(false)

        await expect(cache.deleteSession(oldSession.id)).rejects.toThrow('Failed to delete session')
        expect(store.attachments.getForSession(attachment.id, 'default', oldSession.id)).not.toBeNull()
        expect(existsSync(attachment.originalPath)).toBe(true)

        deleteSession.mockRestore()
    })

    it('finalizes cache eviction when attachment cleanup fails after row deletion', async () => {
        const { store, cache } = setup()
        const { oldSession } = makeSessions(cache)
        const cached = cache.getSession(oldSession.id)
        if (cached) cached.active = false
        const cleanup = spyOn(store.attachments, 'deleteAllForSession').mockImplementation(async () => {
            throw new Error('unlink failed')
        })
        const warning = spyOn(console, 'warn').mockImplementation(() => {})

        await cache.deleteSession(oldSession.id)

        expect(cache.getSession(oldSession.id)).toBeUndefined()
        expect(warning).toHaveBeenCalled()
        expect(cleanup).toHaveBeenCalledWith('default', oldSession.id)
        cleanup.mockRestore()
        warning.mockRestore()
    })
})
