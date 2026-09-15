import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function createEngine(store: Store): SyncEngine {
    const io = {
        of: () => ({
            adapter: { rooms: new Map<string, { size: number }>() },
            to: () => ({
                emit() {},
                timeout: () => ({ emit() {} })
            })
        })
    }
    return new SyncEngine(
        store,
        io as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
}

describe('SyncEngine.deleteAttachment', () => {
    it('refuses to delete an attachment referenced by a persisted message', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-delete-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        try {
            const session = engine.getOrCreateSession(
                'attachment-delete',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: session.id,
                filename: 'photo.png',
                mimeType: 'image/png',
                original: Buffer.from('original')
            })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'keep this image',
                    attachments: [{
                        id: 'message-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            })

            await expect(engine.deleteAttachment(session.id, 'default', attachment.id)).resolves.toEqual({
                success: false,
                error: 'Attachment is already referenced by a message'
            })
            expect(store.attachments.getForSession(attachment.id, 'default', session.id)).not.toBeNull()
            expect(existsSync(attachment.originalPath)).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('hides an attachment and rejects sends while deletion is in progress', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-delete-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseDelete!: () => void
        const deleteStarted = new Promise<void>((resolve) => {
            const originalDelete = store.attachments.deleteForSession.bind(store.attachments)
            spyOn(store.attachments, 'deleteForSession').mockImplementation(async (...args) => {
                resolve()
                await new Promise<void>((release) => { releaseDelete = release })
                return await originalDelete(...args)
            })
        })
        try {
            const session = engine.getOrCreateSession(
                'attachment-delete-race',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: session.id,
                filename: 'photo.png',
                mimeType: 'image/png',
                original: Buffer.from('original')
            })
            const metadata = {
                id: 'message-attachment',
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                attachmentId: attachment.id
            }

            const deletion = engine.deleteAttachment(session.id, 'default', attachment.id)
            await deleteStarted
            expect(engine.hasAttachment(session.id, 'default', attachment.id)).toBe(false)
            await expect(engine.readAttachment(session.id, 'default', attachment.id)).resolves.toBeNull()
            await expect(engine.sendMessage(session.id, { text: 'race', attachments: [metadata] }))
                .rejects.toThrow('Attachment deletion in progress')

            releaseDelete()
            await expect(deletion).resolves.toEqual({ success: true })
        } finally {
            releaseDelete?.()
            engine.stop()
            store.close()
        }
    })

    it('rejects deletion while a message is persisting an attachment', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-send-delete-race-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseSend!: () => void
        let notifySendStarted!: () => void
        const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
        const sendStarted = new Promise<void>((resolve) => { notifySendStarted = resolve })
        const originalAdd = store.addMessageForCurrentSession.bind(store)
        spyOn(store, 'addMessageForCurrentSession').mockImplementation(async (...args) => {
            notifySendStarted()
            await sendGate
            return await originalAdd(...args)
        })
        try {
            const session = engine.getOrCreateSession(
                'attachment-send-delete-race',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: session.id,
                filename: 'photo.png',
                mimeType: 'image/png',
                original: Buffer.from('original')
            })
            const metadata = {
                id: 'message-attachment',
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                attachmentId: attachment.id
            }

            const sending = engine.sendMessage(session.id, { text: 'persist this', attachments: [metadata] })
            await sendStarted
            await expect(engine.deleteAttachment(session.id, 'default', attachment.id)).resolves.toEqual({
                success: false,
                error: 'Attachment is being sent'
            })

            releaseSend()
            await expect(sending).resolves.toBeUndefined()
            expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
            await expect(engine.deleteAttachment(session.id, 'default', attachment.id)).resolves.toEqual({
                success: false,
                error: 'Attachment is already referenced by a message'
            })
        } finally {
            releaseSend?.()
            engine.stop()
            store.close()
        }
    })

    it('allows idempotent concurrent sends while keeping deletion blocked', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-concurrent-send-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseFirst!: () => void
        let notifyFirstStarted!: () => void
        let addCount = 0
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
        const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve })
        const originalAdd = store.addMessageForCurrentSession.bind(store)
        spyOn(store, 'addMessageForCurrentSession').mockImplementation(async (...args) => {
            addCount += 1
            if (addCount === 1) {
                notifyFirstStarted()
                await firstGate
            }
            return await originalAdd(...args)
        })
        try {
            const session = engine.getOrCreateSession(
                'attachment-concurrent-send',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: session.id,
                filename: 'photo.png',
                mimeType: 'image/png',
                original: Buffer.from('original')
            })
            const metadata = {
                id: 'message-attachment',
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                attachmentId: attachment.id
            }

            const first = engine.sendMessage(session.id, {
                text: 'same request',
                localId: 'same-local-id',
                attachments: [metadata]
            })
            await firstStarted
            const second = engine.sendMessage(session.id, {
                text: 'same request',
                localId: 'same-local-id',
                attachments: [metadata]
            })

            await expect(second).resolves.toBeUndefined()
            await expect(engine.deleteAttachment(session.id, 'default', attachment.id)).resolves.toEqual({
                success: false,
                error: 'Attachment is being sent'
            })
            releaseFirst()
            await expect(first).resolves.toBeUndefined()
            expect(addCount).toBe(2)
            expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
            await expect(engine.deleteAttachment(session.id, 'default', attachment.id)).resolves.toEqual({
                success: false,
                error: 'Attachment is already referenced by a message'
            })
        } finally {
            releaseFirst?.()
            engine.stop()
            store.close()
        }
    })

    it('deletes the row before unlink so ownership transfer cannot resurrect it', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-transfer-delete-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseUnlink!: () => void
        let unlinkStarted!: () => void
        const unlinkStartedPromise = new Promise<void>((resolve) => { unlinkStarted = resolve })
        const unlinkGate = new Promise<void>((resolve) => { releaseUnlink = resolve })
        try {
            const source = engine.getOrCreateSession(
                'attachment-transfer-delete-source',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const target = engine.getOrCreateSession(
                'attachment-transfer-delete-target',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'photo.png',
                mimeType: 'image/png',
                original: Buffer.from('original')
            })
            const originalRm = fsPromises.rm.bind(fsPromises)
            const rmSpy = spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
                if (path === attachment.originalPath) {
                    unlinkStarted()
                    await unlinkGate
                }
                return originalRm(path, options)
            })
            try {
                const deletion = engine.deleteAttachment(source.id, 'default', attachment.id)
                await unlinkStartedPromise
                expect(store.attachments.transferSession('default', source.id, target.id)).toBe(0)
                expect(engine.hasAttachment(target.id, 'default', attachment.id)).toBe(false)
                releaseUnlink()
                await expect(deletion).resolves.toEqual({ success: true })
                expect(store.attachments.getForSession(attachment.id, 'default', target.id)).toBeNull()
            } finally {
                rmSpy.mockRestore()
                releaseUnlink()
            }
        } finally {
            engine.stop()
            store.close()
        }
    })
})

describe('SyncEngine.createAttachment', () => {
    it('reclaims an upload that finishes after its session was deleted', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-upload-delete-race-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseCreate!: () => void
        let notifyCreateStarted!: () => void
        const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
        const createStarted = new Promise<void>((resolve) => { notifyCreateStarted = resolve })
        const originalCreate = store.attachments.create.bind(store.attachments)
        spyOn(store.attachments, 'create').mockImplementation(async (...args) => {
            notifyCreateStarted()
            await createGate
            return await originalCreate(...args)
        })
        try {
            const session = engine.getOrCreateSession(
                'attachment-upload-delete-race',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const uploading = engine.createAttachment(
                session.id,
                'default',
                'photo.png',
                Buffer.from('original').toString('base64'),
                'image/png'
            )
            await createStarted
            expect(store.sessions.deleteSession(session.id, 'default')).toBe(true)
            releaseCreate()

            await expect(uploading).rejects.toThrow('Session was deleted while uploading')
            expect(store.sessions.getSessionByNamespace(session.id, 'default')).toBeNull()
            expect(readdirSync(join(root, 'attachments')).filter((name) => name.endsWith('.original'))).toEqual([])
        } finally {
            releaseCreate?.()
            engine.stop()
            store.close()
        }
    })

    it('reclaims an upload transferred during session merge before the upload resumes', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-attachment-upload-merge-race-'))
        tempDirs.push(root)
        const store = new Store(':memory:', { attachmentsRoot: join(root, 'attachments') })
        const engine = createEngine(store)
        let releaseCreate!: () => void
        let notifyCreateStarted!: () => void
        const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
        const createStarted = new Promise<void>((resolve) => { notifyCreateStarted = resolve })
        let createdAttachment!: Awaited<ReturnType<Store['attachments']['create']>>
        const originalCreate = store.attachments.create.bind(store.attachments)
        spyOn(store.attachments, 'create').mockImplementation(async (...args) => {
            createdAttachment = await originalCreate(...args)
            notifyCreateStarted()
            await createGate
            return createdAttachment
        })
        try {
            const source = engine.getOrCreateSession(
                'attachment-upload-merge-race-source',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const target = engine.getOrCreateSession(
                'attachment-upload-merge-race-target',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            const sessionCache = (engine as unknown as {
                sessionCache: { mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> }
            }).sessionCache
            const uploading = engine.createAttachment(
                source.id,
                'default',
                'photo.png',
                Buffer.from('original').toString('base64'),
                'image/png'
            )
            await createStarted
            expect(store.attachments.getForSession(createdAttachment.id, 'default', source.id)).not.toBeNull()

            await sessionCache.mergeSessions(source.id, target.id, 'default')
            expect(store.attachments.getForSession(createdAttachment.id, 'default', target.id)).not.toBeNull()
            releaseCreate()

            await expect(uploading).rejects.toThrow('Session was deleted while uploading')
            expect(store.attachments.getForSession(createdAttachment.id, 'default', target.id)).toBeNull()
            expect(existsSync(createdAttachment.originalPath)).toBe(false)
        } finally {
            releaseCreate?.()
            engine.stop()
            store.close()
        }
    })
})
