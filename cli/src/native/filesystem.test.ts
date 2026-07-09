import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, nativeHelperPathMock } = vi.hoisted(() => ({
    execFileMock: vi.fn((_file: string, args: string[], _options: object, callback: (error: Error | null, result?: { stdout: string, stderr: string }) => void) => {
        callback(null, {
            stdout: args[1] === 'read-file'
                ? '{"success":true,"content":"aGk="}'
                : args[1] === 'write-file'
                ? '{"success":true,"hash":"abc123"}'
                : args[1] === 'tree'
                ? '{"success":true,"tree":{"name":"project","path":"/workspace/project","type":"directory","children":[]}}'
                : '{"success":true,"entries":[{"name":"src","type":"directory","isGitRepo":true}]}',
            stderr: ''
        })
    }),
    nativeHelperPathMock: vi.fn(() => '/tmp/hapi-local')
}))

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return {
        ...actual,
        execFile: execFileMock
    }
})

vi.mock('./localHelper', () => ({
    nativeHelperPath: nativeHelperPathMock
}))

import { nativeDirectoryTree, nativeListDirectory, nativeReadFile, nativeWriteFile } from './filesystem'

describe('native filesystem helper', () => {
    beforeEach(() => {
        execFileMock.mockClear()
    })

    it('calls hapi-local fs list-dir with scoped root/options', async () => {
        const response = await nativeListDirectory({
            root: '/workspace',
            path: '/workspace/project',
            includeGit: true,
            hideDot: true
        })

        expect(response).toEqual({
            success: true,
            entries: [{ name: 'src', type: 'directory', isGitRepo: true }]
        })
        expect(execFileMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'fs',
            'list-dir',
            '--root',
            '/workspace',
            '--path',
            '/workspace/project',
            '--include-git',
            '--hide-dot'
        ], { encoding: 'utf8' }, expect.any(Function))
    })



    it('calls hapi-local fs tree with scoped root/path/depth', async () => {
        const response = await nativeDirectoryTree({ root: '/workspace', path: '/workspace/project', maxDepth: 2 })

        expect(response).toEqual({
            success: true,
            tree: { name: 'project', path: '/workspace/project', type: 'directory', children: [] }
        })
        expect(execFileMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'fs',
            'tree',
            '--root',
            '/workspace',
            '--path',
            '/workspace/project',
            '--max-depth',
            '2'
        ], { encoding: 'utf8' }, expect.any(Function))
    })

    it('calls hapi-local fs read-file with scoped root/path', async () => {
        const response = await nativeReadFile({ root: '/workspace', path: 'README.md' })

        expect(response).toEqual({ success: true, content: 'aGk=' })
        expect(execFileMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'fs',
            'read-file',
            '--root',
            '/workspace',
            '--path',
            'README.md'
        ], { encoding: 'utf8' }, expect.any(Function))
    })

    it('calls hapi-local fs write-file with content/hash', async () => {
        const response = await nativeWriteFile({
            root: '/workspace',
            path: 'README.md',
            content: 'aGk=',
            expectedHash: 'oldhash'
        })

        expect(response).toEqual({ success: true, hash: 'abc123' })
        expect(execFileMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'fs',
            'write-file',
            '--root',
            '/workspace',
            '--path',
            'README.md',
            '--content',
            'aGk=',
            '--expected-hash',
            'oldhash'
        ], { encoding: 'utf8' }, expect.any(Function))
    })

})
