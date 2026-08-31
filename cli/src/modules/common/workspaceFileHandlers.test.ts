import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { MAX_WORKSPACE_FILE_BYTES, registerWorkspaceFileHandlers, type WorkspaceFilePathPolicy } from './workspaceFileHandlers'

const execFileAsync = promisify(execFile)

async function callWorkspaceHandler(
    rpc: RpcHandlerManager,
    method: string,
    params: unknown,
): Promise<Record<string, unknown>> {
    const response = await rpc.handleRequest({
        method: `machine-test:${method}`,
        params: JSON.stringify(params),
    })
    return JSON.parse(response) as Record<string, unknown>
}

describe('workspace file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'hapi-workspace-file-handler-'))
        await mkdir(join(rootDir, 'src'))
        await writeFile(join(rootDir, 'src', 'index.ts'), 'export const answer = 42\n')
        await writeFile(join(rootDir, '.env.example'), 'EXAMPLE=true\n')

        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        const pathPolicy = new MachinePathPolicy({ workspaceRoots: [rootDir] })
        registerWorkspaceFileHandlers(rpc, pathPolicy)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    it('registers all read-only workspace operations on the machine scope', () => {
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceReadFile)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceListDirectory)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceStatFiles)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceGitStatus)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceGitDiffNumstat)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceGitDiffFile)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceRipgrep)).toBe(true)
    })

    it('lists, reads, and stats files beneath the requested workspace', async () => {
        const list = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceListDirectory, {
            cwd: rootDir,
            path: '',
        })
        expect(list.success).toBe(true)
        expect((list.entries as Array<{ name: string }>).map((entry) => entry.name).sort()).toEqual([
            '.env.example',
            'src',
        ])

        const read = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
            cwd: rootDir,
            path: 'src/index.ts',
        })
        expect(read).toMatchObject({
            success: true,
            content: Buffer.from('export const answer = 42\n').toString('base64'),
            size: 25,
        })
        expect(read.modified).toEqual(expect.any(Number))

        const stats = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceStatFiles, {
            cwd: rootDir,
            paths: ['src/index.ts', 'missing.ts'],
        })
        expect(stats).toMatchObject({
            success: true,
            entries: [
                { path: 'src/index.ts', size: 25 },
                { path: 'missing.ts' },
            ],
        })
    })

    it('rejects oversized and non-regular files before reading them', async () => {
        const oversizedPath = join(rootDir, 'oversized.bin')
        await writeFile(oversizedPath, '')
        await truncate(oversizedPath, MAX_WORKSPACE_FILE_BYTES + 1)

        const oversized = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
            cwd: rootDir,
            path: 'oversized.bin',
        })
        expect(oversized).toEqual({ success: false, error: 'File is too large to display inline' })

        const directoryPath = join(rootDir, 'not-a-file')
        await mkdir(directoryPath)
        const directory = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
            cwd: rootDir,
            path: 'not-a-file',
        })
        expect(directory).toEqual({ success: false, error: 'Path is not a regular file' })

        if (process.platform !== 'win32') {
            const fifoPath = join(rootDir, 'named-pipe')
            await execFileAsync('mkfifo', [fifoPath])
            const fifo = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
                cwd: rootDir,
                path: 'named-pipe',
            })
            expect(fifo).toEqual({ success: false, error: 'Path is not a regular file' })
        }
    })

    it('passes workspace paths to the runner policy without trimming them', async () => {
        const checkedPaths: string[] = []
        const pathPolicy: WorkspaceFilePathPolicy = {
            resolveForCheck: async (path) => {
                checkedPaths.push(path)
                return rootDir
            },
            isWithinSpawnRoots: () => true,
        }
        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerWorkspaceFileHandlers(rpc, pathPolicy)

        const workspacePath = `${rootDir} `
        const result = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceListDirectory, {
            cwd: workspacePath,
            path: '',
        })

        expect(result.success).toBe(true)
        expect(checkedPaths[0]).toBe(workspacePath)
    })

    it('rejects workspace roots outside the runner allowlist', async () => {
        const outsideDir = await mkdtemp(join(tmpdir(), 'hapi-workspace-file-outside-'))
        try {
            await writeFile(join(outsideDir, 'secret.txt'), 'secret')
            const result = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
                cwd: outsideDir,
                path: 'secret.txt',
            })
            expect(result).toEqual({ success: false, error: 'Path is outside workspace roots' })
        } finally {
            await rm(outsideDir, { recursive: true, force: true })
        }
    })

    it('rejects file paths that escape the session workspace', async () => {
        const outsideFile = join(tmpdir(), `hapi-workspace-file-secret-${Date.now()}.txt`)
        await writeFile(outsideFile, 'secret')
        try {
            rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
            registerWorkspaceFileHandlers(rpc, new MachinePathPolicy({ workspaceRoots: [tmpdir()] }))
            const result = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceReadFile, {
                cwd: rootDir,
                path: `../${outsideFile.split(/[\\/]/).pop()}`,
            })
            expect(result).toEqual({ success: false, error: 'Path is outside the session workspace' })
        } finally {
            await rm(outsideFile, { force: true })
        }
    })

    it('runs Git and ripgrep against the requested workspace without a session CLI', async () => {
        await execFileAsync('git', ['init', '-q'], { cwd: rootDir })
        await execFileAsync('git', ['add', '.'], { cwd: rootDir })
        await execFileAsync('git', [
            '-c', 'user.name=HAPI test',
            '-c', 'user.email=hapi-test@example.invalid',
            'commit', '-qm', 'initial'
        ], { cwd: rootDir })
        await writeFile(join(rootDir, 'src', 'index.ts'), 'export const answer = 43\n')

        const status = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceGitStatus, { cwd: rootDir })
        expect(status).toMatchObject({ success: true })
        expect(status.stdout).toContain('src/index.ts')

        const diffNumstat = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceGitDiffNumstat, {
            cwd: rootDir,
            staged: false,
        })
        expect(diffNumstat).toMatchObject({ success: true })
        expect(diffNumstat.stdout).toContain('src/index.ts')

        const diffFile = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceGitDiffFile, {
            cwd: rootDir,
            filePath: 'src/index.ts',
            staged: false,
        })
        expect(diffFile).toMatchObject({ success: true })
        expect(diffFile.stdout).toContain('diff --git')

        const ripgrep = await callWorkspaceHandler(rpc, RPC_METHODS.WorkspaceRipgrep, {
            cwd: rootDir,
            args: ['--files'],
            fileSearch: { query: 'src/*.ts', limit: 10 },
        })
        expect(ripgrep).toMatchObject({ success: true })
        expect(String(ripgrep.stdout).replaceAll('\\', '/')).toContain('src/index.ts')
    })
})
