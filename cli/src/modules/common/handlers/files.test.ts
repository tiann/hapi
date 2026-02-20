import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

describe('file RPC handlers', () => {
    let workingDir: string
    let outsideDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        workingDir = await mkdtemp(join(tmpdir(), 'hapi-files-working-'))
        outsideDir = await mkdtemp(join(tmpdir(), 'hapi-files-outside-'))

        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, workingDir)
    })

    afterEach(async () => {
        await rm(workingDir, { recursive: true, force: true })
        await rm(outsideDir, { recursive: true, force: true })
    })

    it('rejects readFile for symlink paths that resolve outside the working directory', async () => {
        const outsideFile = join(outsideDir, 'outside.txt')
        const linkPath = join(workingDir, 'escape.txt')
        await writeFile(outsideFile, 'outside')

        try {
            await symlink(outsideFile, linkPath)
        } catch {
            return
        }

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'escape.txt' })
        })

        const parsed = JSON.parse(response) as { success: boolean; error?: string }
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('symlink traversal')
    })

    it('allows writeFile for new files inside the working directory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:writeFile',
            params: JSON.stringify({
                path: 'new-file.txt',
                content: Buffer.from('hello').toString('base64')
            })
        })

        const parsed = JSON.parse(response) as { success: boolean; hash?: string }
        expect(parsed.success).toBe(true)
        expect(parsed.hash).toBeTypeOf('string')
        expect(await readFile(join(workingDir, 'new-file.txt'), 'utf8')).toBe('hello')
    })

    it('rejects writeFile for symlink paths that resolve outside the working directory', async () => {
        const outsideFile = join(outsideDir, 'outside.txt')
        const linkPath = join(workingDir, 'escape.txt')
        await writeFile(outsideFile, 'outside')
        const expectedHash = createHash('sha256').update('outside').digest('hex')

        try {
            await symlink(outsideFile, linkPath)
        } catch {
            return
        }

        const response = await rpc.handleRequest({
            method: 'session-test:writeFile',
            params: JSON.stringify({
                path: 'escape.txt',
                content: Buffer.from('changed').toString('base64'),
                expectedHash
            })
        })

        const parsed = JSON.parse(response) as { success: boolean; error?: string }
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('symlink traversal')

        expect(await readFile(outsideFile, 'utf8')).toBe('outside')
    })
})
