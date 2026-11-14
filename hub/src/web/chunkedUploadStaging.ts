import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ChunkedUploadStagingErrorCode =
    | 'upload_conflict'
    | 'upload_incomplete'
    | 'upload_invalid_chunk'
    | 'upload_not_found'
    | 'upload_size_mismatch'

export class ChunkedUploadStagingError extends Error {
    constructor(message: string, readonly code: ChunkedUploadStagingErrorCode) {
        super(message)
        this.name = 'ChunkedUploadStagingError'
    }
}

type BeginInput = {
    namespace: string
    sessionId: string
    uploadId: string
    filename: string
    mimeType: string
    size: number
}

type StagedUpload = BeginInput & {
    key: string
    directory: string
    path: string
    handle: FileHandle
    receivedBytes: number
    nextIndex: number
    tail: Promise<void>
    timer: ReturnType<typeof setTimeout>
}

export type FinalizedChunkedUpload = {
    path: string
    directory: string
    filename: string
    mimeType: string
    size: number
}

const DEFAULT_TTL_MS = 15 * 60 * 1000

/** Hub-side staging for binary chunks, including the durable copy created by finalize. */
export class ChunkedUploadStaging {
    private readonly uploads = new Map<string, StagedUpload>()

    constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

    async begin(input: BeginInput): Promise<void> {
        const key = this.key(input.namespace, input.sessionId, input.uploadId)
        if (this.uploads.has(key)) {
            throw new ChunkedUploadStagingError('Upload already exists', 'upload_conflict')
        }
        const directory = await mkdtemp(join(tmpdir(), 'hapi-hub-upload-'))
        const path = join(directory, 'payload')
        let handle: FileHandle
        try {
            handle = await open(path, 'wx', 0o600)
        } catch (error) {
            await rm(directory, { recursive: true, force: true }).catch(() => {})
            throw error
        }
        const state: StagedUpload = {
            ...input,
            key,
            directory,
            path,
            handle,
            receivedBytes: 0,
            nextIndex: 0,
            tail: Promise.resolve(),
            timer: setTimeout(() => { void this.abort(input.namespace, input.sessionId, input.uploadId) }, this.ttlMs),
        }
        state.timer.unref?.()
        this.uploads.set(key, state)
    }

    async append(
        namespace: string,
        sessionId: string,
        uploadId: string,
        index: number,
        bytes: Uint8Array
    ): Promise<number> {
        const state = this.get(namespace, sessionId, uploadId)
        const operation = state.tail.then(async () => {
            if (index !== state.nextIndex) {
                throw new ChunkedUploadStagingError('Upload chunk is out of order', 'upload_conflict')
            }
            if (bytes.length === 0) {
                throw new ChunkedUploadStagingError('Chunk is empty', 'upload_invalid_chunk')
            }
            if (state.receivedBytes + bytes.length > state.size) {
                await this.abort(namespace, sessionId, uploadId)
                throw new ChunkedUploadStagingError('Uploaded bytes exceed declared file size', 'upload_size_mismatch')
            }

            let written = 0
            while (written < bytes.length) {
                const result = await state.handle.write(bytes, written, bytes.length - written, state.receivedBytes + written)
                if (result.bytesWritten <= 0) {
                    await this.abort(namespace, sessionId, uploadId)
                    throw new Error('Failed to stage upload chunk')
                }
                written += result.bytesWritten
            }
            state.receivedBytes += bytes.length
            state.nextIndex += 1
            return state.receivedBytes
        })
        state.tail = operation.then(() => undefined, () => undefined)
        return await operation
    }

    async finalize(namespace: string, sessionId: string, uploadId: string): Promise<FinalizedChunkedUpload> {
        const state = this.get(namespace, sessionId, uploadId)
        await state.tail
        if (state.receivedBytes !== state.size) {
            throw new ChunkedUploadStagingError(
                `Incomplete upload: received ${state.receivedBytes} of ${state.size} bytes`,
                'upload_incomplete'
            )
        }
        this.uploads.delete(state.key)
        clearTimeout(state.timer)
        await state.handle.close()
        return {
            path: state.path,
            directory: state.directory,
            filename: state.filename,
            mimeType: state.mimeType,
            size: state.size,
        }
    }

    async abort(namespace: string, sessionId: string, uploadId: string): Promise<void> {
        const key = this.key(namespace, sessionId, uploadId)
        const state = this.uploads.get(key)
        if (!state) return
        this.uploads.delete(key)
        clearTimeout(state.timer)
        await state.tail.catch(() => {})
        await state.handle.close().catch(() => {})
        await rm(state.directory, { recursive: true, force: true }).catch(() => {})
    }

    async discard(finalized: FinalizedChunkedUpload): Promise<void> {
        await rm(finalized.directory, { recursive: true, force: true }).catch(() => {})
    }

    private get(namespace: string, sessionId: string, uploadId: string): StagedUpload {
        const state = this.uploads.get(this.key(namespace, sessionId, uploadId))
        if (!state) throw new ChunkedUploadStagingError('Upload not found', 'upload_not_found')
        return state
    }

    private key(namespace: string, sessionId: string, uploadId: string): string {
        return `${namespace}\0${sessionId}\0${uploadId}`
    }
}
