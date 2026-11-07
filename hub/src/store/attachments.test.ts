import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
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
        const db = (store as unknown as { db: Database }).db
        expect(db.prepare(
            'SELECT state, resolved_at FROM attachment_creations WHERE id = ?'
        ).get(created.id)).toMatchObject({ state: 'committed' })
        expect(store.attachments.getForSession(created.id, 'namespace-b', 'session-a')).toBeNull()
        expect(store.attachments.getForSession(created.id, 'namespace-a', 'session-b')).toBeNull()

        const blob = await store.attachments.readForSessionAsync(created.id, 'namespace-a', 'session-a')
        expect(blob?.data).toEqual(original)
        expect(blob?.mimeType).toBe('image/png')
        expect(blob?.sha256).toBe(created.sha256)

        const opened = await store.attachments.openForSessionAsync(created.id, 'namespace-a', 'session-a')
        expect(opened?.size).toBe(original.length)
        expect(Buffer.from(await opened!.file.arrayBuffer())).toEqual(original)

        expect(await store.attachments.deleteForSession(created.id, 'namespace-b', 'session-a')).toBe(false)
        expect(await store.attachments.deleteForSession(created.id, 'namespace-a', 'session-a')).toBe(true)
        expect(existsSync(created.originalPath)).toBe(false)
        expect(await store.attachments.readForSessionAsync(created.id, 'namespace-a', 'session-a')).toBeNull()
        store.close()
    })

    it('reconciles a pending creation journal after a write-before-row crash', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const initial = new Store(dbPath, { attachmentsRoot })
        const db = (initial as unknown as { db: Database }).db
        const id = randomUUID()
        const tempPath = join(attachmentsRoot, `.${id}.original.${randomUUID()}.tmp`)
        const originalPath = join(attachmentsRoot, `${id}.original`)
        mkdirSync(attachmentsRoot, { recursive: true })
        writeFileSync(tempPath, 'temporary')
        writeFileSync(originalPath, 'final')
        db.prepare(`
            INSERT INTO attachment_creations (
                id, namespace, session_id, original_path, temp_path, state, created_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).run(id, 'default', 'crashed-session', originalPath, tempPath, Date.now())
        initial.close()

        const reopened = new Store(dbPath, { attachmentsRoot })
        expect(await reopened.cleanupOrphanedAttachments()).toBe(1)
        expect(await reopened.cleanupOrphanedAttachments()).toBe(0)
        expect(existsSync(originalPath)).toBe(false)
        expect(existsSync(tempPath)).toBe(false)
        const state = (reopened as unknown as { db: Database }).db.prepare(
            'SELECT state FROM attachment_creations WHERE id = ?'
        ).get(id) as { state: string }
        expect(state.state).toBe('reconciled')
        reopened.close()
    })

    it('does not reconcile creation paths outside the attachment root', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const nestedRoot = join(attachmentsRoot, 'nested')
        const initial = new Store(dbPath, { attachmentsRoot })
        const db = (initial as unknown as { db: Database }).db
        const id = randomUUID()
        const tempPath = join(nestedRoot, `.${id}.original.${randomUUID()}.tmp`)
        const originalPath = join(nestedRoot, `${id}.original`)
        mkdirSync(nestedRoot, { recursive: true })
        writeFileSync(tempPath, 'temporary')
        writeFileSync(originalPath, 'final')
        db.prepare(`
            INSERT INTO attachment_creations (
                id, namespace, session_id, original_path, temp_path, state, created_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).run(id, 'default', 'unsafe-session', originalPath, tempPath, Date.now())
        initial.close()

        const reopened = new Store(dbPath, { attachmentsRoot })
        await expect(reopened.cleanupOrphanedAttachments()).rejects.toThrow(
            `Failed to reconcile attachment creation ${id}`
        )
        expect(existsSync(originalPath)).toBe(true)
        expect(existsSync(tempPath)).toBe(true)
        reopened.close()
    })

    it('reconciles the journal when staging fails before the rename', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const attachmentsRoot = join(dir, 'attachments')
        const store = new Store(':memory:', { attachmentsRoot })
        const writeSpy = spyOn(fsPromises, 'writeFile').mockImplementation(async () => {
            throw new Error('simulated staging write failure')
        })

        try {
            await expect(store.attachments.create({
                namespace: 'default',
                sessionId: 'write-failure-session',
                filename: 'write-failure.txt',
                mimeType: 'text/plain',
                original: Buffer.from('write failure')
            })).rejects.toThrow('simulated staging write failure')
        } finally {
            writeSpy.mockRestore()
        }

        const db = (store as unknown as { db: Database }).db
        expect(db.prepare(
            "SELECT COUNT(*) AS count FROM attachment_creations WHERE state = 'reconciled'"
        ).get()).toEqual({ count: 1 })
        expect(readdirSync(attachmentsRoot)).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 })
        store.close()
    })

    it('reconciles the journal when the atomic rename fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const attachmentsRoot = join(dir, 'attachments')
        const store = new Store(':memory:', { attachmentsRoot })
        const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async () => {
            throw new Error('simulated atomic rename failure')
        })

        try {
            await expect(store.attachments.create({
                namespace: 'default',
                sessionId: 'rename-failure-session',
                filename: 'rename-failure.txt',
                mimeType: 'text/plain',
                original: Buffer.from('rename failure')
            })).rejects.toThrow('simulated atomic rename failure')
        } finally {
            renameSpy.mockRestore()
        }

        const db = (store as unknown as { db: Database }).db
        expect(db.prepare(
            "SELECT COUNT(*) AS count FROM attachment_creations WHERE state = 'reconciled'"
        ).get()).toEqual({ count: 1 })
        expect(readdirSync(attachmentsRoot)).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 })
        store.close()
    })

    it('keeps a pending journal when cleanup fails and retries it later', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const store = new Store(dbPath, { attachmentsRoot })
        const db = (store as unknown as { db: Database }).db
        const id = randomUUID()
        const tempPath = join(attachmentsRoot, `.${id}.original.${randomUUID()}.tmp`)
        const originalPath = join(attachmentsRoot, `${id}.original`)
        mkdirSync(attachmentsRoot, { recursive: true })
        writeFileSync(tempPath, 'temporary')
        writeFileSync(originalPath, 'final')
        db.prepare(`
            INSERT INTO attachment_creations (
                id, namespace, session_id, original_path, temp_path, state, created_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).run(id, 'default', 'retry-session', originalPath, tempPath, Date.now())
        const originalRm = fsPromises.rm.bind(fsPromises)
        const rmSpy = spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
            if (String(path) === originalPath || String(path) === tempPath) {
                throw new Error('simulated cleanup failure')
            }
            return await originalRm(path, options)
        })

        try {
            await expect(store.attachments.cleanupPendingCreations())
                .rejects.toThrow(`Failed to reconcile attachment creation ${id}`)
        } finally {
            rmSpy.mockRestore()
        }

        expect(db.prepare('SELECT state FROM attachment_creations WHERE id = ?').get(id))
            .toEqual({ state: 'pending' })
        expect(existsSync(originalPath)).toBe(true)
        expect(existsSync(tempPath)).toBe(true)
        expect(await store.attachments.cleanupPendingCreations()).toBe(1)
        expect(db.prepare('SELECT state FROM attachment_creations WHERE id = ?').get(id))
            .toEqual({ state: 'reconciled' })
        expect(existsSync(originalPath)).toBe(false)
        expect(existsSync(tempPath)).toBe(false)
        store.close()
    })

    it('handles concurrent attachment creation without leaking staging files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-stress-'))
        tempDirs.push(dir)
        const attachmentsRoot = join(dir, 'attachments')
        const store = new Store(':memory:', { attachmentsRoot })
        const originals = Array.from({ length: 128 }, (_, index) => Buffer.from(
            `concurrent attachment ${index}: ${'x'.repeat(4096)}`
        ))

        const created = await Promise.all(originals.map((original, index) => store.attachments.create({
            namespace: 'stress',
            sessionId: `stress-session-${index % 4}`,
            filename: `attachment-${index}.bin`,
            mimeType: 'application/octet-stream',
            original
        })))

        expect(new Set(created.map((attachment) => attachment.id)).size).toBe(originals.length)
        const db = (store as unknown as { db: Database }).db
        expect(db.prepare('SELECT COUNT(*) AS count FROM attachments').get())
            .toEqual({ count: originals.length })
        expect(db.prepare(
            "SELECT COUNT(*) AS count FROM attachment_creations WHERE state = 'committed'"
        ).get()).toEqual({ count: originals.length })
        expect(readdirSync(attachmentsRoot)).toHaveLength(originals.length)
        expect(readdirSync(attachmentsRoot).some((name) => name.endsWith('.tmp'))).toBe(false)

        const loaded = await Promise.all(created.map((attachment) =>
            store.attachments.readForSessionAsync(
                attachment.id,
                attachment.namespace,
                attachment.sessionId
            )
        ))
        expect(loaded.map((blob) => blob?.data)).toEqual(originals)
        store.close()
    })

    it('journals failed file cleanup for the next startup reconciliation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const store = new Store(dbPath, { attachmentsRoot })
        const session = store.sessions.getOrCreateSession('cleanup-journal-session', {}, {}, 'default')
        const attachment = await store.attachments.create({
            namespace: 'default',
            sessionId: session.id,
            filename: 'journaled.txt',
            mimeType: 'text/plain',
            original: Buffer.from('journaled')
        })
        const originalRm = fsPromises.rm.bind(fsPromises)
        const rmSpy = spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
            if (String(path) === attachment.originalPath) {
                throw new Error('simulated unlink failure')
            }
            return await originalRm(path, options)
        })

        try {
            await expect(store.attachments.deleteForSession(attachment.id, 'default', session.id))
                .rejects.toThrow('simulated unlink failure')
            expect(store.attachments.getForSession(attachment.id, 'default', session.id)).toBeNull()
        } finally {
            rmSpy.mockRestore()
            store.close()
        }

        const reopened = new Store(dbPath, { attachmentsRoot })
        expect(await reopened.cleanupOrphanedAttachments()).toBe(1)
        expect(existsSync(attachment.originalPath)).toBe(false)
        reopened.close()
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

    it('does not sweep files that may belong to another database sharing the root', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-attachments-'))
        tempDirs.push(dir)
        const databaseA = join(dir, 'hapi-a.sqlite')
        const databaseB = join(dir, 'hapi-b.sqlite')
        const attachmentsRoot = join(dir, 'attachments')
        const storeA = new Store(databaseA, { attachmentsRoot })
        const sessionA = storeA.sessions.getOrCreateSession('database-a-session', {}, {}, 'default')
        const attachment = await storeA.attachments.create({
            namespace: 'default',
            sessionId: sessionA.id,
            filename: 'owned-by-a.txt',
            mimeType: 'text/plain',
            original: Buffer.from('owned by database A')
        })

        const storeB = new Store(databaseB, { attachmentsRoot })
        expect(await storeB.cleanupOrphanedAttachments()).toBe(0)
        expect(existsSync(attachment.originalPath)).toBe(true)
        expect((await storeA.attachments.readForSessionAsync(attachment.id, 'default', sessionA.id))?.data)
            .toEqual(Buffer.from('owned by database A'))

        storeB.close()
        storeA.close()
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
