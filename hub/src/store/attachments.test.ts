import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('AttachmentStore', () => {
    it('stores original bytes with namespace and session isolation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const store = new Store(':memory:', { attachmentsRoot: join(dir, 'attachments') })
        const original = Buffer.from('original bytes')

        const created = await store.attachments.create({
            namespace: 'namespace-a',
            sessionId: 'session-a',
            filename: '../photo.png',
            mimeType: 'image/png',
            original
        })

        expect(created.filename).toBe('photo.png')
        expect(created.originalPath).not.toContain('photo.png')
        expect(existsSync(created.originalPath)).toBe(true)
        expect(readFileSync(created.originalPath)).toEqual(original)
        expect(created.sha256).toBe(createHash('sha256').update(original).digest('hex'))
        expect(store.attachments.getForSession(created.id, 'namespace-b', 'session-a')).toBeNull()
        expect(store.attachments.getForSession(created.id, 'namespace-a', 'session-b')).toBeNull()

        const blob = await store.attachments.readForSessionAsync(created.id, 'namespace-a', 'session-a')
        expect(blob?.data).toEqual(original)
        expect(blob?.mimeType).toBe('image/png')
        expect(blob?.sha256).toBe(created.sha256)

        expect(await store.attachments.deleteForSession(created.id, 'namespace-b', 'session-a')).toBe(false)
        expect(await store.attachments.deleteForSession(created.id, 'namespace-a', 'session-a')).toBe(true)
        expect(existsSync(created.originalPath)).toBe(false)
        expect(await store.attachments.readForSessionAsync(created.id, 'namespace-a', 'session-a')).toBeNull()
        store.close()
    })

    it('rejects empty and oversized originals before creating files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const store = new Store(':memory:', { attachmentsRoot: join(dir, 'attachments') })

        await expect(store.attachments.create({
            namespace: 'default',
            sessionId: 'session',
            filename: 'empty.txt',
            mimeType: 'text/plain',
            original: Buffer.alloc(0)
        })).rejects.toThrow('Attachment exceeds the maximum allowed size')

        await expect(store.attachments.create({
            namespace: 'default',
            sessionId: 'session',
            filename: 'large.bin',
            mimeType: 'application/octet-stream',
            original: Buffer.alloc(50 * 1024 * 1024 + 1)
        })).rejects.toThrow('Attachment exceeds the maximum allowed size')
        store.close()
    })

    it('transfers and deletes attachments by session without crossing namespaces', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const store = new Store(':memory:', { attachmentsRoot: join(dir, 'attachments') })
        const moved = await store.attachments.create({
            namespace: 'namespace-a',
            sessionId: 'session-a',
            filename: 'moved.txt',
            mimeType: 'text/plain',
            original: Buffer.from('moved')
        })
        const other = await store.attachments.create({
            namespace: 'namespace-b',
            sessionId: 'session-a',
            filename: 'other.txt',
            mimeType: 'text/plain',
            original: Buffer.from('other')
        })

        expect(store.attachments.transferSession('namespace-a', 'session-a', 'session-b')).toBe(1)
        expect(store.attachments.getForSession(moved.id, 'namespace-a', 'session-a')).toBeNull()
        expect(store.attachments.getForSession(moved.id, 'namespace-a', 'session-b')).not.toBeNull()
        expect(store.attachments.getForSession(other.id, 'namespace-b', 'session-a')).not.toBeNull()

        expect(await store.attachments.deleteAllForSession('namespace-a', 'session-b')).toBe(1)
        expect(existsSync(moved.originalPath)).toBe(false)
        expect(existsSync(other.originalPath)).toBe(true)
        store.close()
    })

    it('reclaims attachments whose owning session no longer exists', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const initial = new Store(dbPath, { attachmentsRoot })
        const orphan = await initial.attachments.create({
            namespace: 'namespace-a',
            sessionId: 'deleted-session',
            filename: 'orphan.txt',
            mimeType: 'text/plain',
            original: Buffer.from('orphan')
        })
        initial.close()

        const reopened = new Store(dbPath, { attachmentsRoot })
        expect(await reopened.cleanupOrphanedAttachments()).toBe(1)
        expect(reopened.attachments.getForSession(orphan.id, 'namespace-a', 'deleted-session')).toBeNull()
        expect(existsSync(orphan.originalPath)).toBe(false)
        reopened.close()
    })

    it('removes untracked attachment files during reconciliation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const initial = new Store(dbPath, { attachmentsRoot })
        initial.close()

        mkdirSync(attachmentsRoot, { recursive: true })
        const untrackedOriginal = join(attachmentsRoot, 'untracked.original')
        const interruptedTemp = join(attachmentsRoot, '.interrupted.original.tmp')
        writeFileSync(untrackedOriginal, 'untracked')
        writeFileSync(interruptedTemp, 'interrupted')

        const reopened = new Store(dbPath, { attachmentsRoot })
        expect(await reopened.cleanupOrphanedAttachments()).toBe(2)
        expect(existsSync(untrackedOriginal)).toBe(false)
        expect(existsSync(interruptedTemp)).toBe(false)
        reopened.close()
    })

    it('clones durable message attachments for a fork without changing the source', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const store = new Store(':memory:', { attachmentsRoot: join(dir, 'attachments') })
        const source = await store.attachments.create({
            namespace: 'namespace-a',
            sessionId: 'session-a',
            filename: 'photo.png',
            mimeType: 'image/png',
            original: Buffer.from('original')
        })
        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: 'inspect this',
                attachments: [{
                    id: 'message-attachment',
                    filename: source.filename,
                    mimeType: source.mimeType,
                    size: source.size,
                    attachmentId: source.id,
                    path: '/legacy/path-that-must-not-survive'
                }]
            }
        }

        const cloned = await store.attachments.cloneMessageAttachments(
            'namespace-a',
            'session-a',
            'session-b',
            content
        ) as typeof content
        const clonedId = cloned.content.attachments[0]?.attachmentId
        expect(clonedId).toBeDefined()
        expect(clonedId).not.toBe(source.id)
        expect(cloned.content.attachments[0]?.path).toBeUndefined()
        expect((await store.attachments.readForSessionAsync(clonedId!, 'namespace-a', 'session-b'))?.data)
            .toEqual(Buffer.from('original'))
        expect(store.attachments.getForSession(source.id, 'namespace-a', 'session-a')).not.toBeNull()
        store.close()
    })

    it('rewrites attachments when a redirected message changes session ownership', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const store = new Store(':memory:', { attachmentsRoot: join(dir, 'attachments') })
        const target = store.sessions.getOrCreateSession(
            'target', { path: '/tmp/project', host: 'localhost', flavor: 'opencode' }, null, 'default'
        )
        const source = store.sessions.getOrCreateSession(
            'source', {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'opencode',
                supersededBySessionId: target.id
            }, null, 'default'
        )
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: source.id,
            filename: 'redirected.txt',
            mimeType: 'text/plain',
            original: Buffer.from('redirected')
        })
        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: 'inspect this',
                attachments: [{
                    id: 'message-attachment',
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    attachmentId: attachment.id
                }]
            }
        }

        const result = await store.addMessageForCurrentSession(source.id, content, 'redirected-local')
        expect(result.sessionId).toBe(target.id)
        const persisted = result.message.content as typeof content
        const clonedId = persisted.content.attachments[0]!.attachmentId
        expect(clonedId).not.toBe(attachment.id)
        expect((await store.attachments.readForSessionAsync(clonedId, 'default', target.id))?.data)
            .toEqual(Buffer.from('redirected'))
        expect(store.attachments.getForSession(attachment.id, 'default', source.id)).not.toBeNull()
        store.close()
    })

    it('expands tilde-based attachment roots', async () => {
        const previousHome = process.env.HAPI_HOME
        const previousRoot = process.env.HAPI_ATTACHMENTS_ROOT
        const suffix = `.hapi-attachments-${randomUUID()}`
        const expectedRoot = join(homedir(), suffix, 'attachments')
        try {
            process.env.HAPI_HOME = `~/${suffix}`
            delete process.env.HAPI_ATTACHMENTS_ROOT
            const store = new Store(':memory:')
            const attachment = await store.attachments.create({
                namespace: 'default',
                sessionId: 'session',
                filename: 'home.txt',
                mimeType: 'text/plain',
                original: Buffer.from('home')
            })
            expect(attachment.originalPath).toBe(join(expectedRoot, `${attachment.id}.original`))
            store.close()
        } finally {
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            if (previousRoot === undefined) delete process.env.HAPI_ATTACHMENTS_ROOT
            else process.env.HAPI_ATTACHMENTS_ROOT = previousRoot
            rmSync(join(homedir(), suffix), { recursive: true, force: true })
        }
    })
})
