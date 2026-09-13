import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

export type AttachmentFile = {
    attachment: StoredAttachment
    file: ReturnType<typeof Bun.file>
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

    async openForSessionAsync(
        id: string,
        namespace: string,
        sessionId: string
    ): Promise<AttachmentFile | null> {
        const attachment = this.getForSession(id, namespace, sessionId)
        if (!attachment) return null

        const file = Bun.file(attachment.originalPath)
        if (!(await file.exists())) return null

        return {
            attachment,
            file,
            mimeType: attachment.mimeType,
            size: file.size,
            sha256: attachment.sha256
        }
    }

    async deleteForSession(id: string, namespace: string, sessionId: string): Promise<boolean> {
        const attachment = this.getForSession(id, namespace, sessionId)
        if (!attachment) return false

        const deleted = this.db.transaction(() => {
            this.db.prepare(
                'INSERT OR IGNORE INTO attachment_deletions (original_path) VALUES (?)'
            ).run(attachment.originalPath)
            return Number(this.db.prepare(
                'DELETE FROM attachments WHERE id = ? AND namespace = ? AND session_id = ?'
            ).run(id, namespace, sessionId).changes) > 0
        })()
        if (!deleted) return false

        // Ownership and the cleanup journal commit together. If the process exits
        // before the file is removed, startup reconciliation drains the journal.
        await rm(attachment.originalPath, { force: true })
        this.clearDeletionJournal(attachment.originalPath)
        return true
    }

    /** Delete an attachment by opaque id without depending on its current owner. */
    async deleteById(id: string, namespace: string): Promise<boolean> {
        const attachment = this.db.prepare(`
            SELECT id, namespace, session_id, filename, mime_type, size,
                   sha256, original_path, created_at
            FROM attachments
            WHERE id = ? AND namespace = ?
        `).get(id, namespace) as AttachmentRow | null | undefined
        if (!attachment) return false

        const deleted = this.db.transaction(() => {
            this.db.prepare(
                'INSERT OR IGNORE INTO attachment_deletions (original_path) VALUES (?)'
            ).run(attachment.original_path)
            return Number(this.db.prepare(
                'DELETE FROM attachments WHERE id = ? AND namespace = ?'
            ).run(id, namespace).changes) > 0
        })()
        if (!deleted) return false

        await rm(attachment.original_path, { force: true })
        this.clearDeletionJournal(attachment.original_path)
        return true
    }

    async cleanupPendingDeletions(): Promise<number> {
        const rows = this.db.prepare(
            'SELECT original_path FROM attachment_deletions'
        ).all() as Array<{ original_path: string }>
        let cleaned = 0
        let firstError: unknown
        for (const row of rows) {
            try {
                await rm(row.original_path, { force: true })
                this.clearDeletionJournal(row.original_path)
                cleaned += 1
            } catch (error) {
                firstError ??= error
            }
        }
        if (firstError) throw firstError
        return cleaned
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

    transferIds(
        namespace: string,
        fromSessionId: string,
        toSessionId: string,
        attachmentIds: readonly string[]
    ): number {
        if (fromSessionId === toSessionId || attachmentIds.length === 0) return 0
        const placeholders = attachmentIds.map(() => '?').join(', ')
        const result = this.db.prepare(`
            UPDATE attachments
            SET session_id = ?
            WHERE namespace = ?
              AND session_id = ?
              AND id IN (${placeholders})
        `).run(toSessionId, namespace, fromSessionId, ...attachmentIds)
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

    private clearDeletionJournal(originalPath: string): void {
        this.db.prepare(
            'DELETE FROM attachment_deletions WHERE original_path = ?'
        ).run(originalPath)
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
