import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerRipgrepHandlers } from './ripgrep'

const { runFileSearchMock } = vi.hoisted(() => ({ runFileSearchMock: vi.fn() }))

vi.mock('@/modules/ripgrep/index', () => ({
    run: vi.fn(),
    runFileSearch: runFileSearchMock,
}))

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('ripgrep RPC handler path containment', () => {
    let rootDir: string
    let outsideDir: string

    beforeEach(async () => {
        if (rootDir) await rm(rootDir, { recursive: true, force: true })
        if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
        rootDir = await createTempDir('hapi-ripgrep-handler')
        outsideDir = await createTempDir('hapi-ripgrep-handler-outside')
        await writeFile(join(outsideDir, 'secret.txt'), 'secret')
        runFileSearchMock.mockReset()
        runFileSearchMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    })

    it('rejects an explicit directory symlink before spawning ripgrep', async () => {
        try {
            await symlink(outsideDir, join(rootDir, 'linked'), 'junction')
        } catch {
            return
        }

        const rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerRipgrepHandlers(rpc, rootDir)
        const response = await rpc.handleRequest({
            method: 'session-test:ripgrep',
            params: JSON.stringify({
                args: ['--files', '--', 'linked'],
                cwd: rootDir,
                fileSearch: { query: '', limit: 50 }
            })
        })

        const parsed = JSON.parse(response) as { success: boolean; error?: string }
        expect(parsed.success).toBe(false)
        expect(parsed.error).toBe('Invalid file search path')
        expect(runFileSearchMock).not.toHaveBeenCalled()
    })
})
