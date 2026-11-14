import { afterEach, describe, expect, it, vi } from 'bun:test'
import { Hono } from 'hono'
import { UPLOAD_CHUNK_MAX_BYTES } from '@hapi/protocol'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createSession(overrides?: Partial<Session>): Session {
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex'
        },
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
    return { ...base, ...overrides }
}

type EngineOverrides = Partial<{
    initChunkedUpload: SyncEngine['initChunkedUpload']
    uploadFileChunk: SyncEngine['uploadFileChunk']
    finalizeChunkedUpload: SyncEngine['finalizeChunkedUpload']
    abortChunkedUpload: SyncEngine['abortChunkedUpload']
    sessionAccess: 'ok' | 'not-found' | 'wrong-namespace'
}>

function createApp(session: Session, overrides: EngineOverrides = {}) {
    const engine = {
        resolveSessionAccess: () => {
            if (overrides.sessionAccess === 'not-found') {
                return { ok: false, reason: 'not-found' as const }
            }
            if (overrides.sessionAccess === 'wrong-namespace') {
                return { ok: false, reason: 'access-denied' as const }
            }
            return { ok: true, sessionId: session.id, session }
        },
        initChunkedUpload: overrides.initChunkedUpload
            ?? (async () => ({ success: true, uploadId: 'upload-1', chunkSize: 4 * 1024 * 1024, maxUploadBytes: 512 * 1024 * 1024 })),
        uploadFileChunk: overrides.uploadFileChunk
            ?? (async () => ({ success: true, receivedBytes: 4 })),
        finalizeChunkedUpload: overrides.finalizeChunkedUpload
            ?? (async () => ({ success: true, path: '/tmp/uploads/file.bin' })),
        abortChunkedUpload: overrides.abortChunkedUpload
            ?? (async () => ({ success: true }))
    } as unknown as SyncEngine

    const root = new Hono<WebAppEnv>()
    root.use('*', async (c, next) => {
        c.set('namespace', session.namespace)
        await next()
    })
    root.route('/', createSessionsRoutes(() => engine))
    return root
}

describe('sessions chunked upload routes', () => {
    const previousLimit = process.env.HAPI_MAX_UPLOAD_BYTES

    afterEach(() => {
        if (previousLimit === undefined) {
            delete process.env.HAPI_MAX_UPLOAD_BYTES
        } else {
            process.env.HAPI_MAX_UPLOAD_BYTES = previousLimit
        }
    })

    it('streams init -> binary chunk -> finalize and base64-encodes raw bytes for RPC', async () => {
        const uploadFileChunk = vi.fn(async () => ({ success: true, receivedBytes: 5 }))
        const app = createApp(createSession(), { uploadFileChunk })

        const initRes = await app.request('/sessions/session-1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'clip.mp4', size: 5, mimeType: 'video/mp4' })
        })
        expect(initRes.status).toBe(200)
        expect(await initRes.json()).toMatchObject({ success: true, uploadId: 'upload-1' })

        const chunkBytes = new Uint8Array([104, 101, 108, 108, 111])
        const chunkRes = await app.request('/sessions/session-1/uploads/upload-1/chunk?index=0', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunkBytes
        })
        expect(chunkRes.status).toBe(200)
        expect(await chunkRes.json()).toEqual({ success: true, receivedBytes: 5 })
        expect(uploadFileChunk).toHaveBeenCalledWith(
            'session-1',
            'upload-1',
            0,
            Buffer.from(chunkBytes).toString('base64')
        )

        const finalRes = await app.request('/sessions/session-1/uploads/upload-1/finalize', {
            method: 'POST'
        })
        expect(finalRes.status).toBe(200)
        expect(await finalRes.json()).toEqual({ success: true, path: '/tmp/uploads/file.bin' })
    })

    it('rejects oversized uploads with 413 without calling initChunkedUpload and honors HAPI_MAX_UPLOAD_BYTES', async () => {
        const initChunkedUpload = vi.fn(async () => ({ success: true, uploadId: 'upload-1' }))
        const app = createApp(createSession(), { initChunkedUpload })

        process.env.HAPI_MAX_UPLOAD_BYTES = '1024'
        const res = await app.request('/sessions/session-1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'big.bin', size: 1025, mimeType: 'application/octet-stream' })
        })
        expect(res.status).toBe(413)
        expect(await res.json()).toMatchObject({ success: false, code: 'upload_too_large' })
        expect(initChunkedUpload).not.toHaveBeenCalled()
    })

    it('rejects oversized chunks, empty chunks, and invalid chunk indices', async () => {
        const uploadFileChunk = vi.fn(async () => ({ success: true, receivedBytes: 1 }))
        const app = createApp(createSession(), { uploadFileChunk })

        const overChunk = new Uint8Array(UPLOAD_CHUNK_MAX_BYTES + 1)
        const overRes = await app.request('/sessions/session-1/uploads/upload-1/chunk?index=0', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: overChunk
        })
        expect(overRes.status).toBe(413)
        expect(await overRes.json()).toMatchObject({ success: false, code: 'upload_chunk_too_large' })

        const emptyRes = await app.request('/sessions/session-1/uploads/upload-1/chunk?index=0', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' }
        })
        expect(emptyRes.status).toBe(400)
        expect(await emptyRes.json()).toMatchObject({ success: false, code: 'upload_invalid_chunk' })

        const badIndexRes = await app.request('/sessions/session-1/uploads/upload-1/chunk?index=-1', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1])
        })
        expect(badIndexRes.status).toBe(400)
        expect(await badIndexRes.json()).toMatchObject({ success: false, code: 'upload_invalid_chunk' })
        expect(uploadFileChunk).not.toHaveBeenCalled()
    })

    it('returns 503 rpc_target_missing when CLI runner does not support chunked upload RPC', async () => {
        const app = createApp(createSession(), {
            initChunkedUpload: async () => {
                throw new RpcTargetMissingError('session-1:uploadInit', 'handler-not-registered')
            }
        })

        const res = await app.request('/sessions/session-1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'clip.mp4', size: 1024, mimeType: 'video/mp4' })
        })
        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({
            success: false,
            code: RPC_TARGET_MISSING_ERROR_CODE
        })
    })

    it('enforces active session and namespace access controls and forwards abort', async () => {
        const inactiveApp = createApp(createSession({ active: false }))
        const inactiveRes = await inactiveApp.request('/sessions/session-1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'a.bin', size: 10, mimeType: 'application/octet-stream' })
        })
        expect(inactiveRes.status).toBe(409)

        const deniedApp = createApp(createSession(), { sessionAccess: 'wrong-namespace' })
        const deniedRes = await deniedApp.request('/sessions/session-1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'a.bin', size: 10, mimeType: 'application/octet-stream' })
        })
        expect(deniedRes.status).toBe(403)

        const abortApp = createApp(createSession(), {
            abortChunkedUpload: async () => ({
                success: false,
                error: 'Upload not found',
                code: 'upload_not_found'
            })
        })
        const abortRes = await abortApp.request('/sessions/session-1/uploads/upload-1/abort', {
            method: 'POST'
        })
        expect(abortRes.status).toBe(404)
        expect(await abortRes.json()).toMatchObject({ success: false, code: 'upload_not_found' })
    })
})
