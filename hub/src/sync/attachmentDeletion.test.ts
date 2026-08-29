import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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
    return new SyncEngine(
        store,
        {} as never,
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
