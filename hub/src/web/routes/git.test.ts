import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: pngBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Generated images are content-addressed by an immutable random id, so they must be
        // cacheable; `no-store` forces a full RPC round-trip on every remount (issue #927).
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })

    it('serves audio inline and generic files as downloads with nosniff', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let mimeType = 'audio/wav'
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: Buffer.from('media').toString('base64'),
                mimeType,
                fileName: mimeType === 'audio/wav' ? 'sample.wav' : 'archive.bin'
            })
        } as unknown as Partial<SyncEngine>

        const audio = await buildApp(engine).request('/api/sessions/session-1/generated-images/audio-1')
        expect(audio.headers.get('content-disposition')).toStartWith('inline;')
        expect(audio.headers.get('x-content-type-options')).toBe('nosniff')

        mimeType = 'application/octet-stream'
        const file = await buildApp(engine).request('/api/sessions/session-1/generated-images/file-1')
        expect(file.headers.get('content-disposition')).toStartWith('attachment;')
        expect(file.headers.get('content-type')).toContain('application/octet-stream')
    })
})

describe('file search route', () => {
    it('normalizes Windows path separators in search queries before invoking ripgrep', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        let ripgrepArgs: string[] = []
        let fileSearchQuery: string | undefined
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[], _cwd: string, fileSearch?: { query: string }) => {
                ripgrepArgs = args
                fileSearchQuery = fileSearch?.query
                return { success: true, stdout: 'src/nested/file.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const query = new URLSearchParams({ query: 'src\\nested\\file.ts' }).toString()
        const response = await buildApp(engine).request(`/api/sessions/session-1/files?${query}`)

        expect(response.status).toBe(200)
        expect(ripgrepArgs).toEqual(['--files', '--iglob', '*src/nested/file.ts*'])
        expect(fileSearchQuery).toBe('src/nested/file.ts')
    })

    it('forwards the request signal to search and metadata RPCs', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const signals: Array<AbortSignal | undefined> = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (
                _sessionId: string,
                _args: string[],
                _cwd: string,
                _fileSearch: { query: string; limit: number },
                signal?: AbortSignal,
            ) => {
                signals.push(signal)
                return { success: true, stdout: 'README.md\n' }
            },
            statFiles: async (_sessionId: string, paths: string[], signal?: AbortSignal) => {
                signals.push(signal)
                return {
                    success: true,
                    entries: paths.map((path) => ({ path, size: 1, modified: 1 }))
                }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=README')

        expect(response.status).toBe(200)
        expect(signals).toHaveLength(2)
        expect(signals[0]).toBeInstanceOf(AbortSignal)
        expect(signals[1]).toBe(signals[0])
    })

    it('preserves backslashes in POSIX search queries', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        let ripgrepArgs: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[]) => {
                ripgrepArgs = args
                return { success: true, stdout: 'src/file\\name.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const query = new URLSearchParams({ query: 'src\\file\\name.ts' }).toString()
        const response = await buildApp(engine).request(`/api/sessions/session-1/files?${query}`)

        expect(response.status).toBe(200)
        expect(ripgrepArgs).toEqual(['--files', '--iglob', '*src\\\\file\\\\name.ts*'])
    })

    it('uses shared matching semantics for plain and wildcard queries', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const ripgrepArgs: string[][] = []
        const fileSearchOptions: Array<{ query: string; limit: number }> = []
        const stdout = [
            'src/file.ts',
            'other.ts',
            'test-AB',
            '!literal.ts',
            '[ab]literal.ts',
            '{a,b}literal.ts',
            'notes.txt'
        ].join('\n')
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[], _cwd: string, fileSearch?: { query: string; limit: number }) => {
                ripgrepArgs.push(args)
                if (fileSearch) fileSearchOptions.push(fileSearch)
                return { success: true, stdout }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 1, modified: 1 }))
            })
        } as unknown as Partial<SyncEngine>

        const app = buildApp(engine)
        const queries: Array<[string, string[]]> = [
            ['.txt', ['notes.txt']],
            ['*.ts', ['src/file.ts', 'other.ts', '!literal.ts', '[ab]literal.ts', '{a,b}literal.ts']],
            ['test-%3F%3F', ['test-AB']],
            ['%21*.ts', ['!literal.ts']],
            ['%5Bab%5D*.ts', ['[ab]literal.ts']],
            ['%7Ba%2Cb%7D*.ts', ['{a,b}literal.ts']],
            ['src*.ts', ['src/file.ts']]
        ]

        for (const [query, expected] of queries) {
            const response = await app.request(`/api/sessions/session-1/files?query=${query}`)
            expect(response.status).toBe(200)
            const body = await response.json() as { files: Array<{ fullPath: string }> }
            expect(body.files.map((file) => file.fullPath)).toEqual(expected)
        }

        expect(ripgrepArgs).toEqual([
            ['--files', '--iglob', '*.txt*'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files']
        ])
        expect(fileSearchOptions).toEqual([
            { query: '.txt', limit: 200 },
            { query: '*.ts', limit: 200 },
            { query: 'test-??', limit: 200 },
            { query: '!*.ts', limit: 200 },
            { query: '[ab]*.ts', limit: 200 },
            { query: '{a,b}*.ts', limit: 200 },
            { query: 'src*.ts', limit: 200 }
        ])
    })

    it('adds size and modification metadata to search results', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/large.txt\nsrc/small.txt\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path, index) => ({ path, size: index ? 10 : 500, modified: index ? 100 : 200 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.txt')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'large.txt', filePath: 'src', fullPath: 'src/large.txt', fileType: 'file', size: 500, modified: 200 },
                { fileName: 'small.txt', filePath: 'src', fullPath: 'src/small.txt', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('normalizes ripgrep path separators before deriving file names and directories', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src\\nested\\file.ts\nroot.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file.ts', filePath: 'src/nested', fullPath: 'src/nested/file.ts', fileType: 'file', size: 10, modified: 100 },
                { fileName: 'root.ts', filePath: '', fullPath: 'root.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('preserves backslashes in file names for non-Windows sessions', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/file\\name.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file\\name.ts', filePath: 'src', fullPath: 'src/file\\name.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })
})
