import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import axios from 'axios'
import type { AttachmentMetadata } from '@hapi/protocol'
import { configuration } from '@/configuration'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { buildHubRequestHeaders } from './hubExtraHeaders'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type MaterializedAttachmentIdentity = { dev: number; ino: number }

function safeExtension(filename: string): string {
    const extension = extname(filename).replace(/[^a-zA-Z0-9.]/g, '')
    return extension.length <= 16 ? extension : ''
}

function safeSegment(value: string): string {
    const segment = value.replace(/[^a-zA-Z0-9._-]/g, '_')
    return segment.length > 0 ? segment : 'attachment'
}

function sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex')
}

/** Downloads a hub attachment into a session-scoped temporary path for Agent input. */
export class AttachmentMaterializer {
    private readonly paths = new Map<string, string>()
    private readonly identities = new Map<string, string>()
    private directoryPromise: Promise<string> | null = null
    private closed = false

    constructor(
        private readonly sessionId: string,
        private readonly token: string
    ) {}

    async materialize(attachment: AttachmentMetadata): Promise<AttachmentMetadata> {
        this.throwIfClosed()
        if (attachment.path || !attachment.attachmentId) return attachment
        const cached = this.paths.get(attachment.attachmentId)
        if (cached) return { ...attachment, path: cached }

        const directory = await this.getDirectory()
        this.throwIfClosed()
        const response = await axios.get(
            `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(this.sessionId)}/attachments/${encodeURIComponent(attachment.attachmentId)}/original`,
            {
                headers: buildHubRequestHeaders({
                    Authorization: `Bearer ${this.token}`,
                    Accept: attachment.mimeType || '*/*'
                }),
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: MAX_ATTACHMENT_BYTES,
                maxBodyLength: MAX_ATTACHMENT_BYTES
            }
        )
        this.throwIfClosed()
        const data = Buffer.from(response.data)
        if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
            throw new Error('Hub attachment has an invalid size')
        }

        const declaredSize = Number(response.headers['x-hapi-attachment-size'] ?? response.headers['content-length'])
        if (Number.isFinite(declaredSize) && declaredSize !== data.length) {
            throw new Error('Hub attachment size validation failed')
        }
        const digest = sha256(data)
        const declaredHash = response.headers['x-hapi-attachment-sha256']
        if (typeof declaredHash === 'string' && declaredHash.length > 0 && declaredHash !== digest) {
            throw new Error('Hub attachment integrity validation failed')
        }

        const target = join(directory, `${safeSegment(attachment.attachmentId)}${safeExtension(attachment.filename)}`)
        const temporary = `${target}.${randomUUID()}.tmp`
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
        try {
            this.throwIfClosed()
            await rename(temporary, target)
            if (this.closed) {
                await rm(target, { force: true }).catch(() => {})
                this.throwIfClosed()
            }
        } finally {
            await rm(temporary, { force: true }).catch(() => {})
        }
        const identity = await stat(target)
        if (this.closed) {
            await rm(target, { force: true }).catch(() => {})
            this.throwIfClosed()
        }
        this.paths.set(attachment.attachmentId, target)
        this.identities.set(resolve(target), `${identity.dev}:${identity.ino}`)
        return { ...attachment, path: target }
    }

    isAuthorizedPath(path: string): boolean {
        return this.identities.has(resolve(path))
    }

    isAuthorizedFile(path: string, identity: MaterializedAttachmentIdentity): boolean {
        return this.identities.get(resolve(path)) === `${identity.dev}:${identity.ino}`
    }

    async close(): Promise<void> {
        this.closed = true
        this.paths.clear()
        this.identities.clear()
        const directoryPromise = this.directoryPromise
        this.directoryPromise = null
        const directory = await directoryPromise?.catch(() => null)
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }

    private throwIfClosed(): void {
        if (this.closed) throw new Error('Attachment materializer is closed')
    }

    private async getDirectory(): Promise<string> {
        if (this.directoryPromise) return this.directoryPromise
        this.directoryPromise = this.createDirectory().catch((error) => {
            this.directoryPromise = null
            throw error
        })
        return this.directoryPromise
    }

    private async createDirectory(): Promise<string> {
        const root = getHapiBlobsDir()
        await mkdir(root, { recursive: true, mode: 0o700 })
        return await mkdtemp(join(root, `attachment-${safeSegment(this.sessionId)}-`))
    }
}
