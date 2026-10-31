import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
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
        const { store, cache, root } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = root
        const oldScratchDir = join(root, 'scratchlist-attachments', 'default', oldSession.id)
        let releaseScratchDelete!: () => void
        let notifyScratchDeleteStarted!: () => void
        const scratchDeleteGate = new Promise<void>((resolve) => { releaseScratchDelete = resolve })
        const scratchDeleteStarted = new Promise<void>((resolve) => { notifyScratchDeleteStarted = resolve })
        const originalRm = fsPromises.rm.bind(fsPromises)
        const rmSpy = spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
            if (String(path) === oldScratchDir) {
                notifyScratchDeleteStarted()
                await scratchDeleteGate
            }
            return await originalRm(path, options)
        })
        let lateUploadPromise: Promise<StoredAttachment> | undefined
        const originalTransfer = store.scratchlist.transfer.bind(store.scratchlist)
        const transferSpy = spyOn(store.scratchlist, 'transfer').mockImplementation((fromSessionId, toSessionId) => {
            const result = originalTransfer(fromSessionId, toSessionId)
            lateUploadPromise = store.attachments.create({
                namespace: 'default',
                sessionId: oldSession.id,
                filename: 'late.txt',
                mimeType: 'text/plain',
                original: Buffer.from('late upload')
            })
            return { ...result, moved: Math.max(1, result.moved) }
        })
        try {
            const merging = cache.mergeSessions(oldSession.id, newSession.id, 'default')
            const lateAttachment = await lateUploadPromise!
            await scratchDeleteStarted
            expect(store.attachments.getForSession(lateAttachment.id, 'default', oldSession.id)).not.toBeNull()
            expect(store.attachments.getForSession(lateAttachment.id, 'default', newSession.id)).toBeNull()

            releaseScratchDelete()
            await merging
            expect(store.attachments.getForSession(lateAttachment.id, 'default', oldSession.id)).toBeNull()
            expect(store.attachments.getForSession(lateAttachment.id, 'default', newSession.id)).not.toBeNull()
            expect(existsSync(lateAttachment.originalPath)).toBe(true)
        } finally {
            releaseScratchDelete?.()
            rmSpy.mockRestore()
            transferSpy.mockRestore()
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
