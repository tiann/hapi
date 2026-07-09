import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

const { nativeReadFileMock, nativeWriteFileMock } = vi.hoisted(() => ({
    nativeReadFileMock: vi.fn(async () => ({ success: true, content: 'bmF0aXZl' })),
    nativeWriteFileMock: vi.fn(async () => ({ success: true, hash: 'abc123' }))
}))

vi.mock('@/native/filesystem', () => ({
    nativeReadFile: nativeReadFileMock,
    nativeWriteFile: nativeWriteFileMock
}))

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        nativeReadFileMock.mockClear()
        nativeWriteFileMock.mockClear()
        if (rootDir) {
            await rm(rootDir, { recursive: true, force: true })
        }
        rootDir = await createTempDir('hapi-file-handler')
        await writeFile(join(rootDir, 'README.md'), 'fallback')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    it('reads files through native helper when available', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'README.md' })
        })

        expect(JSON.parse(response)).toEqual({ success: true, content: 'bmF0aXZl' })
        expect(nativeReadFileMock).toHaveBeenCalledWith({ root: rootDir, path: 'README.md' })
    })

    it('writes files through native helper when available', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:writeFile',
            params: JSON.stringify({ path: 'README.md', content: 'bmV3', expectedHash: 'oldhash' })
        })

        expect(JSON.parse(response)).toEqual({ success: true, hash: 'abc123' })
        expect(nativeWriteFileMock).toHaveBeenCalledWith({
            root: rootDir,
            path: 'README.md',
            content: 'bmV3',
            expectedHash: 'oldhash'
        })
    })
})
