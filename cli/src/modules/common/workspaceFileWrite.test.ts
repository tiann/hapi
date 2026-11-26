import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { registerWorkspaceFileHandlers } from './workspaceFileHandlers'

vi.mock('node:fs/promises', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs, link: vi.fn(fs.link) }
})

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
        vi.unstubAllEnvs()
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

    async function writeChunk(name: string, offset: number, text: string, options: {
        final?: boolean; overwrite?: boolean; uploadId?: string
    } = {}) {
        return await call(rpc, RPC_METHODS.WorkspaceWriteFile, {
            cwd: root, dir: '', name, uploadId: UPLOAD_ID, offset, content: b64(text), ...options,
        })
    }

    async function stagingPath() {
        const names = (await readdir(root)).filter(name => name.startsWith('.hapi-upload-'))
        expect(names).toHaveLength(1)
        return join(root, names[0])
    }

    it.skipIf(process.platform === 'win32')('creates a private part and preserves regular file permissions on replacement', async () => {
        const target = join(root, 'script')
        for (const mode of [0o600, 0o751]) {
            await writeFile(target, 'previous')
            await chmod(target, mode)
            expect(await writeChunk('script', 0, 'fir', { overwrite: true })).toMatchObject({ success: true })
            expect((await lstat(await stagingPath())).mode & 0o777).toBe(0o600)
            expect(await writeChunk('script', 3, 'st', { final: true, overwrite: true })).toMatchObject({ success: true })
            expect((await lstat(target)).mode & 0o777).toBe(mode)
            expect(await readFile(target, 'utf8')).toBe('first')
        }
    })

    it('never opens an existing stage entry on a new upload', async () => {
        expect(await writeChunk('config', 0, 'one')).toMatchObject({ success: true })
        const part = await stagingPath()
        await call(rpc, RPC_METHODS.WorkspaceWriteFile, { cwd: root, name: 'config', uploadId: UPLOAD_ID, abort: true })
        await symlink(join(outside, 'secret.txt'), part)
        expect(await writeChunk('config', 0, 'fresh', { final: true })).toMatchObject({ success: false })
        expect((await lstat(part)).isSymbolicLink()).toBe(true)
        expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
        await expect(lstat(join(root, 'config'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('requires approval to replace a destination symlink and leaves its referent untouched', async () => {
        const target = join(root, 'config')
        const referent = join(outside, 'secret.txt')
        await symlink(referent, target)
        expect(await writeChunk('config', 0, 'new', { final: true })).toMatchObject({ success: false, code: 'exists' })
        expect(await writeChunk('config', 0, 'new', { final: true, overwrite: true })).toMatchObject({ success: true })
        expect((await lstat(target)).isFile()).toBe(true)
        expect(await readFile(target, 'utf8')).toBe('new')
        expect(await readFile(referent, 'utf8')).toBe('keep')
    })

    it.each(['symlink', 'file'])('refuses a staging entry replaced by a different %s between chunks', async kind => {
        expect(await writeChunk('config', 0, 'one')).toMatchObject({ success: true })
        const part = await stagingPath()
        await rename(part, join(root, 'original'))
        if (kind === 'symlink') await symlink(join(outside, 'secret.txt'), part)
        else await writeFile(part, 'two')
        expect(await writeChunk('config', 3, '!', { final: true })).toMatchObject({ success: false })
        expect(await readFile(part, 'utf8')).toBe(kind === 'symlink' ? 'keep' : 'two')
        await expect(lstat(join(root, 'config'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('lets exactly one concurrent upload publish a new name', async () => {
        const ids = ['upload-first', 'upload-second']
        for (const uploadId of ids) {
            expect(await writeChunk('race', 0, uploadId, { uploadId })).toMatchObject({ success: true })
        }
        const results = await Promise.all(ids.map(uploadId =>
            writeChunk('race', uploadId.length, '!', { uploadId, final: true })))
        expect(results.filter(result => result.success)).toHaveLength(1)
        expect(results.filter(result => result.code === 'exists')).toHaveLength(1)
        const winner = ids[results.findIndex(result => result.success)]
        expect(await readFile(join(root, 'race'), 'utf8')).toBe(winner + '!')
        expect((await readdir(root)).sort()).toEqual(['race', 'src'])
    })

    it('accepts a given offset only once when two chunks arrive together', async () => {
        vi.stubEnv('HAPI_MAX_UPLOAD_BYTES', '5')
        expect(await writeChunk('overlap', 0, '123')).toMatchObject({ success: true })
        const results = await Promise.all(['45', 'ab'].map(text => writeChunk('overlap', 3, text)))
        expect(results.filter(result => result.success)).toHaveLength(1)
        expect(await writeChunk('overlap', 5, '', { final: true })).toMatchObject({ success: true, size: 5 })
        expect((await readFile(join(root, 'overlap'))).byteLength).toBe(5)
    })

    it('copies exclusively from the open stage when hard links are unavailable', async () => {
        const noLinks = Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' })
        vi.mocked(link).mockRejectedValueOnce(noLinks)
        expect(await writeChunk('fallback', 0, 'copied', { final: true })).toMatchObject({ success: true })
        expect(await readFile(join(root, 'fallback'), 'utf8')).toBe('copied')

        expect(await writeChunk('late', 0, 'other')).toMatchObject({ success: true })
        await writeFile(join(root, 'late'), 'winner')
        vi.mocked(link).mockRejectedValueOnce(noLinks)
        expect(await writeChunk('late', 5, '', { final: true })).toMatchObject({ success: false, code: 'exists' })
        expect(await readFile(join(root, 'late'), 'utf8')).toBe('winner')
        expect((await readdir(root)).sort()).toEqual(['fallback', 'late', 'src'])
    })

    it('enforces the configured limit across chunks and removes an oversized part', async () => {
        vi.stubEnv('HAPI_MAX_UPLOAD_BYTES', '5')
        expect(await writeChunk('exact', 0, '123')).toMatchObject({ success: true })
        expect(await writeChunk('exact', 3, '45', { final: true })).toMatchObject({ success: true, size: 5 })
        expect(await writeChunk('large', 0, '123')).toMatchObject({ success: true })
        expect(await writeChunk('large', 3, '456', { final: true })).toMatchObject({ success: false, error: expect.stringMatching(/size/) })
        expect((await readdir(root)).sort()).toEqual(['exact', 'src'])
    })

    it('accepts a 255-byte destination name', async () => {
        const name = 'x'.repeat(255)
        expect(await writeChunk(name, 0, 'ok', { final: true })).toMatchObject({ success: true, path: name })
        expect(await readFile(join(root, name), 'utf8')).toBe('ok')
    })

    it('deletes files and folders recursively', async () => {
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'src/a.txt', kind: 'file' })).toMatchObject({ success: true })
        await expect(lstat(join(root, 'src', 'a.txt'))).rejects.toThrow()
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'src', kind: 'directory' })).toMatchObject({ success: true })
        expect(await readdir(root)).toEqual([])
    })

    it('removes a symlink itself, never its target', async () => {
        await symlink(outside, join(root, 'link-out'))
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'link-out', kind: 'file' })).toMatchObject({ success: true })
        expect(await readdir(outside)).toEqual(['secret.txt'])
        await expect(lstat(join(root, 'link-out'))).rejects.toThrow()
    })

    it('requires a matching confirmation before removing the current entry', async () => {
        for (const [path, kind] of [['src', 'file'], ['src/a.txt', 'directory']]) {
            expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path, kind }))
                .toMatchObject({ success: false, code: 'kind_mismatch' })
        }
        expect(await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: 'src' }))
            .toMatchObject({ success: false })
        expect(await readFile(join(root, 'src', 'a.txt'), 'utf8')).toBe('old')
    })

    it.each([
        ['the workspace root', '', 'directory'],
        ['the workspace root via dot', '.', 'directory'],
        ['a path outside the workspace', '../outside/secret.txt', 'file'],
        ['an absolute path outside the workspace', '<abs-outside>', 'file'],
        ['a path through an escaping symlink', 'link-out/secret.txt', 'file'],
    ])('refuses to delete %s', async (_label, path, kind) => {
        await symlink(outside, join(root, 'link-out')).catch(() => {})
        const target = path === '<abs-outside>' ? join(outside, 'secret.txt') : path
        const result = await call(rpc, RPC_METHODS.WorkspaceDeletePath, { cwd: root, path: target, kind })
        expect(result.success).toBe(false)
        expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
        expect((await readdir(root)).includes('src')).toBe(true)
    })
})
