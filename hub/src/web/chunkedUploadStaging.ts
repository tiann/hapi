import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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

type StagingMetadata = {
    ownerPid: number
    createdAt: number
}

const DEFAULT_TTL_MS = 15 * 60 * 1000
const METADATA_FILE = '.staging.json'

function defaultStagingRoot(): string {
    const hapiHome = process.env.HAPI_HOME || join(homedir(), '.hapi')
    return join(hapiHome, 'uploads', 'chunked-staging')
}

function processIsAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    if (pid === process.pid) return true
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
    }
}

/** Hub-side staging for binary chunks, including the durable copy created by finalize. */
export class ChunkedUploadStaging {
    private readonly uploads = new Map<string, StagedUpload>()
    private initializePromise: Promise<void> | null = null
    private readonly root: string

    constructor(
        private readonly ttlMs = DEFAULT_TTL_MS,
        root = defaultStagingRoot()
    ) {
        this.root = root
    }

    initialize(): Promise<void> {
        if (!this.initializePromise) {
            this.initializePromise = this.prepareRoot().catch((error) => {
                this.initializePromise = null
                throw error
            })
        }
        return this.initializePromise
    }

    async begin(input: BeginInput): Promise<void> {
        await this.initialize()
        const key = this.key(input.namespace, input.sessionId, input.uploadId)
        if (this.uploads.has(key)) {
            throw new ChunkedUploadStagingError('Upload already exists', 'upload_conflict')
        }
        const directory = await mkdtemp(join(this.root, 'chunk-'))
        const path = join(directory, 'payload')
        const metadata: StagingMetadata = { ownerPid: process.pid, createdAt: Date.now() }
        try {
            await writeFile(join(directory, METADATA_FILE), JSON.stringify(metadata), { mode: 0o600, flag: 'wx' })
            await writeFile(path, new Uint8Array(), { mode: 0o600, flag: 'wx' })
        } catch (error) {
            await rm(directory, { recursive: true, force: true }).catch(() => {})
            throw error
        }
        const state: StagedUpload = {
            ...input,
            key,
            directory,
            path,
            receivedBytes: 0,
            nextIndex: 0,
            tail: Promise.resolve(),
            timer: setTimeout(() => {}, 0),
        }
        this.armExpiration(state)
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
            this.armExpiration(state)
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

            try {
                await appendFile(state.path, bytes)
            } catch (error) {
                await this.abort(namespace, sessionId, uploadId)
                throw error
            }
            state.receivedBytes += bytes.length
            state.nextIndex += 1
            this.armExpiration(state)
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
        const info = await stat(state.path)
        if (!info.isFile() || info.size !== state.size) {
            throw new ChunkedUploadStagingError('Finalized upload size mismatch', 'upload_size_mismatch')
        }
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
        await rm(state.directory, { recursive: true, force: true }).catch(() => {})
    }

    async discard(finalized: FinalizedChunkedUpload): Promise<void> {
        await rm(finalized.directory, { recursive: true, force: true }).catch(() => {})
    }

    private armExpiration(state: StagedUpload): void {
        clearTimeout(state.timer)
        state.timer = setTimeout(() => {
            void this.abort(state.namespace, state.sessionId, state.uploadId)
        }, this.ttlMs)
        state.timer.unref?.()
    }

    private get(namespace: string, sessionId: string, uploadId: string): StagedUpload {
        const state = this.uploads.get(this.key(namespace, sessionId, uploadId))
        if (!state) throw new ChunkedUploadStagingError('Upload not found', 'upload_not_found')
        return state
    }

    private key(namespace: string, sessionId: string, uploadId: string): string {
        return `${namespace}\0${sessionId}\0${uploadId}`
    }

    private async prepareRoot(): Promise<void> {
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        try {
            await chmod(this.root, 0o700)
        } catch {
        }
        await this.cleanupAbandoned()
    }

    private async cleanupAbandoned(): Promise<void> {
        const entries = await readdir(this.root, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('chunk-')) continue
            const directory = join(this.root, entry.name)
            try {
                const metadata = JSON.parse(
                    await readFile(join(directory, METADATA_FILE), 'utf8')
                ) as StagingMetadata
                if (processIsAlive(metadata.ownerPid)) continue
                await rm(directory, { recursive: true, force: true })
            } catch {
                const info = await stat(directory).catch(() => null)
                if (info && Date.now() - info.mtimeMs > this.ttlMs) {
                    await rm(directory, { recursive: true, force: true }).catch(() => {})
                }
            }
        }
    }
}
