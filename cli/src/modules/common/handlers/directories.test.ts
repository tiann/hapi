import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerDirectoryHandlers } from './directories'

async function createTempDir(prefix: string): Promise<string> {
    const base = tmpdir()
    const path = join(base, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('directory RPC handlers', () => {
    let rootDir: string
    let outsideDir: string | undefined
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        if (rootDir) {
            await rm(rootDir, { recursive: true, force: true })
        }
        if (outsideDir) {
            await rm(outsideDir, { recursive: true, force: true })
        }

        rootDir = await createTempDir('hapi-dir-handler')
        await mkdir(join(rootDir, 'src'), { recursive: true })
        await writeFile(join(rootDir, 'src', 'index.ts'), 'console.log("ok")')
        await writeFile(join(rootDir, 'README.md'), '# test')

        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerDirectoryHandlers(rpc, rootDir)
    })

    it('lists root directory via empty path', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:listDirectory',
            params: JSON.stringify({ path: '' })
        })

        const parsed = JSON.parse(response) as { success: boolean; entries?: Array<{ name: string; type: string }> }
        expect(parsed.success).toBe(true)

        const names = (parsed.entries ?? []).map((entry) => entry.name)
        expect(names).toContain('src')
        expect(names).toContain('README.md')
    })

    it('skips symlink stat in listDirectory', async () => {
        try {
            await symlink('/definitely-not-a-real-path', join(rootDir, 'bad-link'))
        } catch {
            // symlink may be disallowed on some systems; skip the test
            return
        }

        const response = await rpc.handleRequest({
            method: 'session-test:listDirectory',
            params: JSON.stringify({ path: '' })
        })
        const parsed = JSON.parse(response) as { success: boolean; entries?: Array<{ name: string; type: string; size?: number }> }
        expect(parsed.success).toBe(true)
        const link = (parsed.entries ?? []).find((entry) => entry.name === 'bad-link')
        expect(link).toBeTruthy()
        expect(link?.type).toBe('other')
        expect(link?.size).toBeUndefined()
    })

    it('returns metadata for a batch of searched files', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:statFiles',
            params: JSON.stringify({ paths: ['README.md', 'src/index.ts', 'src', 'missing.txt'] })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            entries?: Array<{ path: string; size?: number; modified?: number }>
        }

        expect(parsed.success).toBe(true)
        expect(parsed.entries).toHaveLength(4)
        expect(parsed.entries?.[0]).toMatchObject({ path: 'README.md', type: 'file', size: 6 })
        expect(parsed.entries?.[0]?.modified).toBeTypeOf('number')
        expect(parsed.entries?.[1]).toMatchObject({ path: 'src/index.ts', type: 'file' })
        expect(parsed.entries?.[2]).toMatchObject({ path: 'src', type: 'directory' })
        expect(parsed.entries?.[3]).toEqual({ path: 'missing.txt' })
    })

    it('rejects stat paths outside the session working directory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:statFiles',
            params: JSON.stringify({ paths: ['../outside.txt'] })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('outside the working directory')
    })

    it('does not expose metadata for a symlinked directory outside the workspace', async () => {
        outsideDir = await createTempDir('hapi-dir-handler-outside')
        await writeFile(join(outsideDir, 'secret.txt'), 'secret')
        try {
            await symlink(outsideDir, join(rootDir, 'linked'), 'junction')
        } catch {
            return
        }

        const response = await rpc.handleRequest({
            method: 'session-test:statFiles',
            params: JSON.stringify({ paths: ['linked'] })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            entries?: Array<{ path: string; type?: string }>
        }

        expect(parsed.success).toBe(true)
        expect(parsed.entries).toEqual([{ path: 'linked' }])
    })
})
