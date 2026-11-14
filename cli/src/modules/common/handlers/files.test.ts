import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, stat, symlink, truncate, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-file-handler')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    it('returns file metadata alongside content', async () => {
        const filePath = join(rootDir, 'README.md')
        await writeFile(filePath, '# test')
        const expectedStats = await stat(filePath)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'README.md' })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            content?: string
            size?: number
            modified?: number
        }

        expect(parsed.success).toBe(true)
        expect(parsed.content).toBe(Buffer.from('# test').toString('base64'))
        expect(parsed.size).toBe(expectedStats.size)
        expect(parsed.modified).toBe(expectedStats.mtime.getTime())
    })

    it('rejects bounded reads before loading an oversized file', async () => {
        const filePath = join(rootDir, 'large.png')
        await writeFile(filePath, Buffer.alloc(32))

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'large.png', maxBytes: 16 })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('too large')
    })

    it('rejects bounded reads of non-regular files', async () => {
        const directoryPath = join(rootDir, 'directory.png')
        await mkdir(directoryPath)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'directory.png', maxBytes: 1024 })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('regular file')
    })

    it('keeps bounded reads within the limit when the file is sparse and oversized', async () => {
        const filePath = join(rootDir, 'growth.png')
        await writeFile(filePath, Buffer.from('small'))
        await truncate(filePath, 32)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'growth.png', maxBytes: 16 })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('too large')
    })

    it('does not follow a symlink to a non-regular target for bounded reads', async () => {
        const target = join(rootDir, 'target-directory')
        const link = join(rootDir, 'linked.png')
        await mkdir(target)
        try {
            await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
            return
        }

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'linked.png', maxBytes: 1024 })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('regular file')
    })

    it('rejects bounded reads through a symlink to an outside regular file', async () => {
        const outsideDir = await createTempDir('hapi-file-handler-outside')
        const outsidePath = join(outsideDir, 'secret.png')
        const link = join(rootDir, 'linked-secret.png')
        await writeFile(outsidePath, Buffer.from('secret'))

        try {
            if (process.platform === 'win32') {
                await symlink(outsidePath, link, 'file')
            } else {
                await symlink(outsidePath, link)
            }
        } catch {
            await rm(outsideDir, { recursive: true, force: true })
            return
        }

        try {
            const response = await rpc.handleRequest({
                method: 'session-test:readFile',
                params: JSON.stringify({ path: 'linked-secret.png', maxBytes: 1024 })
            })
            const parsed = JSON.parse(response) as { success: boolean; error?: string }

            expect(parsed.success).toBe(false)
            expect(parsed.error).toContain('outside')
        } finally {
            await rm(outsideDir, { recursive: true, force: true })
        }
    })
})
