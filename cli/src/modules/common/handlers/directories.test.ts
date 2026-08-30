import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerDirectoryHandlers } from './directories'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('fs/promises', async () => {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    return { ...actual, stat: statMock }
})

async function createTempDir(prefix: string): Promise<string> {
    const base = tmpdir()
    const path = join(base, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('directory RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        statMock.mockReset()
        statMock.mockImplementation(actual.stat)

        if (rootDir) {
            await rm(rootDir, { recursive: true, force: true })
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
            params: JSON.stringify({ paths: ['README.md', 'src/index.ts', 'missing.txt'] })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            entries?: Array<{ path: string; size?: number; modified?: number }>
        }

        expect(parsed.success).toBe(true)
        expect(parsed.entries).toHaveLength(3)
        expect(parsed.entries?.[0]).toMatchObject({ path: 'README.md', size: 6 })
        expect(parsed.entries?.[0]?.modified).toBeTypeOf('number')
        expect(parsed.entries?.[2]).toEqual({ path: 'missing.txt' })
    })

    it('stops starting later stat batches after cancellation', async () => {
        const paths = Array.from({ length: 32 }, (_, index) => `file-${index}.txt`)
        await Promise.all(paths.map((path) => writeFile(join(rootDir, path), path)))

        let firstStatStarted!: () => void
        const firstStat = new Promise<void>((resolve) => {
            firstStatStarted = resolve
        })
        let releaseFirstStat!: () => void
        const firstStatRelease = new Promise<void>((resolve) => {
            releaseFirstStat = resolve
        })
        const originalStat = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).stat
        let statCallCount = 0
        statMock.mockImplementation(async (path: Parameters<typeof originalStat>[0]) => {
            statCallCount += 1
            if (statCallCount === 1) {
                firstStatStarted()
                await firstStatRelease
            }
            return await originalStat(path)
        })

        try {
            const request = rpc.handleRequest({
                method: 'session-test:statFiles',
                params: JSON.stringify({ paths }),
                requestId: 'stat-files-cancel'
            })

            await firstStat
            expect(rpc.cancelRequest('stat-files-cancel')).toBe(true)
            releaseFirstStat()

            await expect(request).resolves.toBe(JSON.stringify({ error: 'Request aborted' }))
            expect(statCallCount).toBe(16)
        } finally {
            statMock.mockReset()
        }
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
})
