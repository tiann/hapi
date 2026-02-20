import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { cleanupUploadDir, registerUploadHandlers } from './uploads'

interface UploadFileResult {
    success: boolean
    path?: string
    error?: string
}

interface DeleteUploadResult {
    success: boolean
    error?: string
}

async function rpcRequest<T>(rpc: RpcHandlerManager, method: string, params: object): Promise<T> {
    const response = await rpc.handleRequest({
        method: `session-test:${method}`,
        params: JSON.stringify(params)
    })
    return JSON.parse(response) as T
}

function createSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

describe('upload RPC handlers', () => {
    let rpc: RpcHandlerManager
    const activeSessions = new Set<string>()

    beforeEach(() => {
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerUploadHandlers(rpc)
    })

    afterEach(async () => {
        await Promise.all(Array.from(activeSessions).map((sessionId) => cleanupUploadDir(sessionId)))
        activeSessions.clear()
    })

    it('rejects deleteUpload when realpath escapes upload directory through symlink', async () => {
        const sessionId = createSessionId()
        activeSessions.add(sessionId)

        const uploadResult = await rpcRequest<UploadFileResult>(rpc, 'uploadFile', {
            sessionId,
            filename: 'in-upload-dir.txt',
            content: Buffer.from('inside').toString('base64'),
            mimeType: 'text/plain'
        })

        expect(uploadResult.success).toBe(true)
        expect(uploadResult.path).toBeTypeOf('string')

        const outsideDir = await mkdtemp(join(tmpdir(), 'hapi-upload-outside-'))
        const outsideFile = join(outsideDir, 'outside.txt')
        const symlinkPath = join(dirname(uploadResult.path!), 'escape-link.txt')
        await writeFile(outsideFile, 'outside')

        try {
            await symlink(outsideFile, symlinkPath)
        } catch {
            await rm(outsideDir, { recursive: true, force: true })
            return
        }

        const deleteResult = await rpcRequest<DeleteUploadResult>(rpc, 'deleteUpload', {
            sessionId,
            path: symlinkPath
        })

        expect(deleteResult.success).toBe(false)
        expect(deleteResult.error).toBe('Invalid upload path')
        expect(await readFile(outsideFile, 'utf8')).toBe('outside')

        await rm(outsideDir, { recursive: true, force: true })
    })

    it('allows deleteUpload for missing files inside upload directory (ENOENT)', async () => {
        const sessionId = createSessionId()
        activeSessions.add(sessionId)

        const uploadResult = await rpcRequest<UploadFileResult>(rpc, 'uploadFile', {
            sessionId,
            filename: 'seed.txt',
            content: Buffer.from('seed').toString('base64'),
            mimeType: 'text/plain'
        })

        expect(uploadResult.success).toBe(true)
        expect(uploadResult.path).toBeTypeOf('string')

        const deleteResult = await rpcRequest<DeleteUploadResult>(rpc, 'deleteUpload', {
            sessionId,
            path: join(dirname(uploadResult.path!), 'missing-file.txt')
        })

        expect(deleteResult.success).toBe(true)
    })
})
