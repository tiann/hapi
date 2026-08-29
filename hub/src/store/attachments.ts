import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Database } from 'bun:sqlite'

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type StoredAttachment = {
    id: string
    namespace: string
    sessionId: string
    filename: string
    mimeType: string
    size: number
    sha256: string
    originalPath: string
    createdAt: number
}

export type AttachmentBlob = {
    attachment: StoredAttachment
    data: Buffer
    mimeType: string
    size: number
    sha256: string
}

export type CreateAttachmentInput = {
    namespace: string
    sessionId: string
    filename: string
    mimeType: string
    original: Buffer
}

type AttachmentRow = {
    id: string
    namespace: string
    session_id: string
    filename: string
    mime_type: string
    size: number
    sha256: string
    original_path: string
    created_at: number
}

const sanitizeFilename = (filename: string): string => {
    const normalized = basename(filename)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
    return (normalized || 'attachment').slice(0, 255)
}

const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const expandHome = (value: string): string => {
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return join(homedir(), value.slice(2))
    }
    return value
}

const defaultAttachmentRoot = (): string => {
    const hapiHome = expandHome(process.env.HAPI_HOME || join(homedir(), '.hapi'))
    return expandHome(process.env.HAPI_ATTACHMENTS_ROOT || join(hapiHome, 'attachments'))
}

export class AttachmentStore {
    private readonly root: string

    constructor(private readonly db: Database, root = defaultAttachmentRoot()) {
        this.root = resolve(root)
    }

    async create(input: CreateAttachmentInput): Promise<StoredAttachment> {
        if (input.original.length === 0 || input.original.length > MAX_ATTACHMENT_BYTES) {
            throw new Error('Attachment exceeds the maximum allowed size')
        }

        const id = randomUUID()
        const createdAt = Date.now()
        const filename = sanitizeFilename(input.filename)
        const sha256 = hashBytes(input.original)
        const originalPath = join(this.root, `${id}.original`)

        await mkdir(this.root, { recursive: true, mode: 0o700 })
        try {
            await chmod(this.root, 0o700)
        } catch {
        }

        try {
            await this.writeAtomically(originalPath, input.original)
            this.db.prepare(`
                INSERT INTO attachments (
                    id, namespace, session_id, filename, mime_type, size,
                    sha256, original_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                input.namespace,
                input.sessionId,
                filename,
                input.mimeType,
                input.original.length,
                sha256,
                originalPath,
                createdAt
            )
        } catch (error) {
            await this.removeFile(originalPath)
            throw error
        }

        return {
            id,
            namespace: input.namespace,
            sessionId: input.sessionId,
            filename,
            mimeType: input.mimeType,
            size: input.original.length,
            sha256,
            originalPath,
            createdAt
        }
    }

    getForSession(id: string, namespace: string, sessionId: string): StoredAttachment | null {
        const row = this.db.prepare(`
            SELECT id, namespace, session_id, filename, mime_type, size,
                   sha256, original_path, created_at
            FROM attachments
            WHERE id = ? AND namespace = ? AND session_id = ?
        `).get(id, namespace, sessionId) as AttachmentRow | null | undefined
        return row ? this.toStoredAttachment(row) : null
    }

    async readForSessionAsync(
        id: string,
        namespace: string,
        sessionId: string
    ): Promise<AttachmentBlob | null> {
        const attachment = this.getForSession(id, namespace, sessionId)
        if (!attachment) return null

        let data: Buffer
        try {
            data = await readFile(attachment.originalPath)
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return null
            }
            throw error
        }

        return {
            attachment,
            data,
            mimeType: attachment.mimeType,
            size: data.length,
            sha256: attachment.sha256
        }
    }

    async deleteForSession(id: string, namespace: string, sessionId: string): Promise<boolean> {
        const attachment = this.getForSession(id, namespace, sessionId)
        if (!attachment) return false

        const result = this.db.prepare(
            'DELETE FROM attachments WHERE id = ? AND namespace = ? AND session_id = ?'
        ).run(id, namespace, sessionId)
        if (Number(result.changes) === 0) return false

        // Delete the row first. If the process exits before the file is removed,
        // startup reconciliation can safely reclaim the now-untracked blob.
        await rm(attachment.originalPath, { force: true })
        return true
    }

    /** Remove files in the attachment root that are not referenced by SQLite. */
    async cleanupUntrackedFiles(): Promise<number> {
        let entries: Array<{ name: string; isDirectory(): boolean }>
        try {
            entries = await readdir(this.root, { withFileTypes: true })
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return 0
            }
            throw error
        }

        const trackedPaths = new Set(
            (this.db.prepare('SELECT original_path FROM attachments').all() as Array<{ original_path: string }>)
                .map((row) => resolve(row.original_path))
        )
        let removed = 0
        let firstError: unknown
        for (const entry of entries) {
            if (entry.isDirectory()) continue
            const path = join(this.root, entry.name)
            if (trackedPaths.has(resolve(path))) continue
            try {
                await rm(path, { force: true })
                removed += 1
            } catch (error) {
                firstError ??= error
            }
        }
        if (firstError) throw firstError
        return removed
    }

    async cloneForSession(
        id: string,
        namespace: string,
        sourceSessionId: string,
        targetSessionId: string
    ): Promise<StoredAttachment> {
        const original = await this.readForSessionAsync(id, namespace, sourceSessionId)
        if (!original) throw new Error(`Attachment ${id} is unavailable`)

        return this.create({
            namespace,
            sessionId: targetSessionId,
            filename: original.attachment.filename,
            mimeType: original.attachment.mimeType,
            original: original.data
        })
    }

    async cloneMessageAttachments(
        namespace: string,
        sourceSessionId: string,
        targetSessionId: string,
        content: unknown,
        clonedAttachments = new Map<string, StoredAttachment>()
    ): Promise<unknown> {
        if (!isRecord(content) || content.role !== 'user') return content
        const messageContent = content.content
        if (!isRecord(messageContent) || !Array.isArray(messageContent.attachments)) return content

        const attachments = []
        for (const attachment of messageContent.attachments) {
            if (!isRecord(attachment) || typeof attachment.attachmentId !== 'string') {
                attachments.push(attachment)
                continue
            }

            const sourceAttachmentId = attachment.attachmentId
            let cloned = clonedAttachments.get(sourceAttachmentId)
            if (!cloned) {
                cloned = await this.cloneForSession(
                    sourceAttachmentId,
                    namespace,
                    sourceSessionId,
                    targetSessionId
                )
                clonedAttachments.set(sourceAttachmentId, cloned)
            }

            const { path: _legacyPath, ...metadata } = attachment
            attachments.push({ ...metadata, attachmentId: cloned.id })
        }

        return {
            ...content,
            content: { ...messageContent, attachments }
        }
    }

    transferSession(namespace: string, fromSessionId: string, toSessionId: string): number {
        if (fromSessionId === toSessionId) return 0
        const result = this.db.prepare(`
            UPDATE attachments
            SET session_id = ?
            WHERE namespace = ? AND session_id = ?
        `).run(toSessionId, namespace, fromSessionId)
        return Number(result.changes)
    }

    async deleteAllForSession(namespace: string, sessionId: string): Promise<number> {
        const attachments = this.db.prepare(`
            SELECT id, namespace, session_id, filename, mime_type, size,
                   sha256, original_path, created_at
            FROM attachments
            WHERE namespace = ? AND session_id = ?
        `).all(namespace, sessionId) as AttachmentRow[]

        let deleted = 0
        let firstError: unknown
        for (const row of attachments) {
            try {
                if (await this.deleteForSession(row.id, namespace, sessionId)) {
                    deleted += 1
                }
            } catch (error) {
                firstError ??= error
            }
        }
        if (firstError) throw firstError
        return deleted
    }

    private async writeAtomically(target: string, data: Buffer): Promise<void> {
        const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
        try {
            await writeFile(temp, data, { mode: 0o600, flag: 'wx' })
            await rename(temp, target)
        } finally {
            await this.removeFile(temp)
        }
    }

    private async removeFile(path: string): Promise<void> {
        try {
            await rm(path, { force: true })
        } catch {
        }
    }

    private toStoredAttachment(row: AttachmentRow): StoredAttachment {
        return {
            id: row.id,
            namespace: row.namespace,
            sessionId: row.session_id,
            filename: row.filename,
            mimeType: row.mime_type,
            size: row.size,
            sha256: row.sha256,
            originalPath: row.original_path,
            createdAt: row.created_at
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
