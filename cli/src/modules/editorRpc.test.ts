import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerEditorRpcHandlers } from './editorRpc'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

async function request(rpc: RpcHandlerManager, method: string, params: unknown): Promise<any> {
    const response = await rpc.handleRequest({
        method: `machine-test:${method}`,
        params: JSON.stringify(params)
    })
    return JSON.parse(response)
}

describe('editor RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-editor-rpc')
        await mkdir(join(rootDir, 'src'), { recursive: true })
        await mkdir(join(rootDir, '.hidden'), { recursive: true })
        await writeFile(join(rootDir, 'README.md'), '# hello')
        await writeFile(join(rootDir, 'src', 'index.ts'), 'console.log("ok")')
        await writeFile(join(rootDir, '.secret'), 'hidden')

        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerEditorRpcHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    it('lists editor directory entries from a machine scoped handler', async () => {
        const parsed = await request(rpc, 'editor-list-directory', { path: rootDir }) as {
            success: boolean
            entries?: Array<{ name: string; type: string; size?: number; modified?: number }>
        }

        expect(parsed.success).toBe(true)
        expect(parsed.entries?.map((entry) => entry.name)).toEqual(['src', 'README.md'])
        expect(parsed.entries?.[0]).toMatchObject({ name: 'src', type: 'directory' })
        expect(parsed.entries?.[1]).toMatchObject({ name: 'README.md', type: 'file' })
        expect(parsed.entries?.[1].size).toBeGreaterThan(0)
        expect(parsed.entries?.[1].modified).toEqual(expect.any(Number))
    })

    it('reads a text file as base64 and reports size', async () => {
        const parsed = await request(rpc, 'editor-read-file', { path: join(rootDir, 'README.md') }) as {
            success: boolean
            content?: string
            size?: number
        }

        expect(parsed).toEqual({
            success: true,
            content: Buffer.from('# hello').toString('base64'),
            size: 7
        })
    })

    it('writes an existing text file inside the editor root', async () => {
        const filePath = join(rootDir, 'README.md')

        const parsed = await request(rpc, 'editor-write-file', {
            path: filePath,
            content: '# updated'
        }) as { success: boolean; path?: string; size?: number }

        expect(parsed).toEqual({
            success: true,
            path: filePath,
            size: Buffer.byteLength('# updated')
        })
        await expect(readFile(filePath, 'utf8')).resolves.toBe('# updated')
    })

    it('creates nested text files without overwriting existing files', async () => {
        const filePath = join(rootDir, 'src', 'components', 'Button.tsx')

        const parsed = await request(rpc, 'editor-create-file', {
            path: filePath,
            content: 'export function Button() {}'
        }) as { success: boolean; path?: string; size?: number }

        expect(parsed).toEqual({
            success: true,
            path: filePath,
            size: Buffer.byteLength('export function Button() {}')
        })
        await expect(readFile(filePath, 'utf8')).resolves.toBe('export function Button() {}')
        await expect(request(rpc, 'editor-create-file', { path: filePath, content: '' })).resolves.toMatchObject({
            success: false,
            error: 'File already exists'
        })
    })

    it('deletes existing files and directories inside the editor root', async () => {
        const filePath = join(rootDir, 'src', 'delete-me.ts')
        const dirPath = join(rootDir, 'src', 'delete-dir')
        await writeFile(filePath, 'remove me')
        await mkdir(dirPath)
        await writeFile(join(dirPath, 'nested.ts'), 'remove me too')

        const parsed = await request(rpc, 'editor-delete-file', { path: filePath }) as { success: boolean; path?: string }
        const dirParsed = await request(rpc, 'editor-delete-file', { path: dirPath }) as { success: boolean; path?: string }

        expect(parsed).toEqual({
            success: true,
            path: filePath
        })
        expect(dirParsed).toEqual({
            success: true,
            path: dirPath
        })
        await expect(stat(filePath)).rejects.toThrow()
        await expect(stat(dirPath)).rejects.toThrow()
    })

    it('rejects binary files and paths outside the editor root', async () => {
        await writeFile(join(rootDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

        await expect(request(rpc, 'editor-read-file', { path: join(rootDir, 'binary.bin') })).resolves.toMatchObject({
            success: false,
            error: 'Cannot read binary file'
        })
        await expect(request(rpc, 'editor-read-file', { path: resolve(rootDir, '..', 'outside.txt') })).resolves.toMatchObject({
            success: false,
            error: 'Path outside editor root'
        })
        await expect(request(rpc, 'editor-write-file', { path: resolve(rootDir, '..', 'outside.txt'), content: 'nope' })).resolves.toMatchObject({
            success: false,
            error: 'Path outside editor root'
        })
        await expect(request(rpc, 'editor-create-file', { path: resolve(rootDir, '..', 'outside.txt'), content: 'nope' })).resolves.toMatchObject({
            success: false,
            error: 'Path outside editor root'
        })
        await expect(request(rpc, 'editor-delete-file', { path: resolve(rootDir, '..', 'outside.txt') })).resolves.toMatchObject({
            success: false,
            error: 'Path outside editor root'
        })
    })

    it('lists projects with git repositories first', async () => {
        await mkdir(join(rootDir, '.git'), { recursive: true })
        await mkdir(join(rootDir, 'child-git', '.git'), { recursive: true })
        await mkdir(join(rootDir, 'child-plain'), { recursive: true })

        const parsed = await request(rpc, 'editor-list-projects', {}) as {
            success: boolean
            projects?: Array<{ path: string; name: string; hasGit: boolean }>
        }

        expect(parsed.success).toBe(true)
        expect(parsed.projects).toEqual(expect.arrayContaining([
            { path: rootDir, name: rootDir.split('/').pop(), hasGit: true },
            { path: join(rootDir, 'child-git'), name: 'child-git', hasGit: true },
            { path: join(rootDir, 'child-plain'), name: 'child-plain', hasGit: false }
        ]))
        const gitProjectIndex = parsed.projects?.findIndex((project) => project.name === 'child-git') ?? -1
        const plainProjectIndex = parsed.projects?.findIndex((project) => project.name === 'child-plain') ?? -1
        expect(gitProjectIndex).toBeGreaterThanOrEqual(0)
        expect(plainProjectIndex).toBeGreaterThan(gitProjectIndex)
    })

    it('runs git status only inside the editor root', async () => {
        await expect(request(rpc, 'editor-git-status', { path: resolve(rootDir, '..') })).resolves.toMatchObject({
            success: false,
            error: 'Path outside editor root'
        })
    })
})
