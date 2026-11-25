import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { registerWorkspaceFileHandlers } from './workspaceFileHandlers'

async function call(rpc: RpcHandlerManager, method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await rpc.handleRequest({ method: `machine-test:${method}`, params: JSON.stringify(params) })
    return JSON.parse(response) as Record<string, unknown>
}

const b64 = (text: string) => Buffer.from(text).toString('base64')
const UPLOAD_ID = 'upload-0001'

describe('workspace write/delete RPC handlers', () => {
    let base: string
    let root: string
    let outside: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'hapi-workspace-write-'))
        root = join(base, 'workspace')
        outside = join(base, 'outside')
        await mkdir(join(root, 'src', 'nested'), { recursive: true })
        await mkdir(outside)
        await writeFile(join(root, 'src', 'a.txt'), 'old')
        await writeFile(join(outside, 'secret.txt'), 'keep')
        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerWorkspaceFileHandlers(rpc, new MachinePathPolicy({ workspaceRoots: [root] }))
    })

    afterEach(async () => {
        await rm(base, { recursive: true, force: true })
    })

    it('registers the write and delete handlers', () => {
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceWriteFile)).toBe(true)
        expect(rpc.hasHandler(RPC_METHODS.WorkspaceDeletePath)).toBe(true)
    })

    it('writes a chunked upload into the requested directory and cleans up the part file', async () => {
        const first = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'new.txt', uploadId: UPLOAD_ID, content: b64('hello '), offset: 0,
        })
        expect(first).toMatchObject({ success: true, size: 6 })
        const last = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'new.txt', uploadId: UPLOAD_ID, content: b64('world'), offset: 6, final: true,
        })
        expect(last).toMatchObject({ success: true, size: 11, path: 'src/new.txt' })
        expect(await readFile(join(root, 'src', 'new.txt'), 'utf8')).toBe('hello world')
        expect((await readdir(join(root, 'src'))).filter((name) => name.includes('hapi-upload'))).toEqual([])
    })

    it('writes empty files and uploads to the workspace root', async () => {
        const result = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: '', name: 'empty.txt', uploadId: UPLOAD_ID, content: '', offset: 0, final: true,
        })
        expect(result).toMatchObject({ success: true, size: 0, path: 'empty.txt' })
        expect(await readFile(join(root, 'empty.txt'), 'utf8')).toBe('')
    })

    it('reports an existing file unless overwrite is set', async () => {
        const clash = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'a.txt', uploadId: UPLOAD_ID, content: b64('new'), offset: 0, final: true,
        })
        expect(clash).toMatchObject({ success: false, code: 'exists' })
        expect(await readFile(join(root, 'src', 'a.txt'), 'utf8')).toBe('old')

        const replaced = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'a.txt', uploadId: UPLOAD_ID, content: b64('new'), offset: 0, final: true, overwrite: true,
        })
        expect(replaced).toMatchObject({ success: true })
        expect(await readFile(join(root, 'src', 'a.txt'), 'utf8')).toBe('new')
    })

    it('rejects out-of-order chunks and supports abort', async () => {
        await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'big.bin', uploadId: UPLOAD_ID, content: b64('1234'), offset: 0,
        })
        const skipped = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'big.bin', uploadId: UPLOAD_ID, content: b64('5678'), offset: 8,
        })
        expect(skipped.success).toBe(false)
        const aborted = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'src', name: 'big.bin', uploadId: UPLOAD_ID, abort: true,
        })
        expect(aborted.success).toBe(true)
        expect((await readdir(join(root, 'src'))).sort()).toEqual(['a.txt', 'nested'])
    })

    it.each([
        ['a name with a separator', { dir: 'src', name: '../escape.txt' }],
        ['a dot-dot name', { dir: 'src', name: '..' }],
        ['a directory outside the workspace', { dir: '../outside', name: 'x.txt' }],
        ['an absolute directory outside the workspace', { dir: '/tmp', name: 'x.txt' }],
    ])('refuses uploads with %s', async (_label, target) => {
        const result = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, ...target, uploadId: UPLOAD_ID, content: b64('x'), offset: 0, final: true,
        })
        expect(result.success).toBe(false)
        expect(await readdir(outside)).toEqual(['secret.txt'])
    })

    it('refuses uploads through a symlinked directory that leaves the workspace', async () => {
        await symlink(outside, join(root, 'link-out'))
        const result = await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: 'link-out', name: 'x.txt', uploadId: UPLOAD_ID, content: b64('x'), offset: 0, final: true,
        })
        expect(result.success).toBe(false)
        expect(await readdir(outside)).toEqual(['secret.txt'])
    })

    it('deletes files and folders recursively', async () => {
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'src/a.txt' })).toMatchObject({ success: true })
        await expect(lstat(join(root, 'src', 'a.txt'))).rejects.toThrow()
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'src' })).toMatchObject({ success: true })
        expect(await readdir(root)).toEqual([])
    })

    it('removes a symlink itself, never its target', async () => {
        await symlink(outside, join(root, 'link-out'))
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'link-out' })).toMatchObject({ success: true })
        expect(await readdir(outside)).toEqual(['secret.txt'])
        await expect(lstat(join(root, 'link-out'))).rejects.toThrow()
    })

    it.each([
        ['the workspace root', ''],
        ['the workspace root via dot', '.'],
        ['a path outside the workspace', '../outside/secret.txt'],
        ['an absolute path outside the workspace', '<abs-outside>'],
        ['a path through an escaping symlink', 'link-out/secret.txt'],
    ])('refuses to delete %s', async (_label, path) => {
        await symlink(outside, join(root, 'link-out')).catch(() => {})
        const target = path === '<abs-outside>' ? join(outside, 'secret.txt') : path
        const result = await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: target })
        expect(result.success).toBe(false)
        expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
        expect((await readdir(root)).includes('src')).toBe(true)
    })
})
