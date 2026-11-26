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

describe('session file route', () => {
    it('forwards a bounded read size to the session RPC', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true, metadata: { path: '/workspace' } } as unknown as Session
        let readOptions: { maxBytes?: number } | undefined
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readSessionFile: async (_sessionId: string, _path: string, options?: { maxBytes?: number }) => {
                readOptions = options
                return { success: true, content: '' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file?path=images%2Fpage.png&maxBytes=1024')

        expect(response.status).toBe(200)
        expect(readOptions).toEqual({ maxBytes: 1024 })
    })
})

describe('file search route', () => {
    it('uses an exact stat lookup for Windows relative paths', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        let ripgrepCalls = 0
        let statPaths: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => {
                ripgrepCalls += 1
                return { success: true, stdout: 'src/nested/file.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => {
                statPaths = paths
                return {
                    success: true,
                    entries: paths.map((path) => ({ path, type: 'file' as const, size: 10, modified: 100 }))
                }
            }
        } as unknown as Partial<SyncEngine>

        const query = new URLSearchParams({ query: 'src\\nested\\file.ts' }).toString()
        const response = await buildApp(engine).request(`/api/sessions/session-1/files?${query}`)

        expect(response.status).toBe(200)
        expect(ripgrepCalls).toBe(0)
        expect(statPaths).toEqual(['src/nested/file.ts'])
        expect(await response.json()).toEqual({
            success: true,
            pathSearch: true,
            files: [{
                fileName: 'file.ts',
                filePath: 'src/nested',
                fullPath: 'src/nested/file.ts',
                fileType: 'file',
                size: 10,
                modified: 100
            }]
        })
    })

    it('resolves in-workspace absolute paths and rejects paths outside the workspace', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        let ripgrepCalls = 0
        const statPaths: string[][] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => {
                ripgrepCalls += 1
                return { success: true, stdout: 'other/file.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => {
                statPaths.push(paths)
                return {
                    success: true,
                    entries: paths.map((path) => ({ path, type: 'file' as const, size: 10, modified: 100 }))
                }
            }
        } as unknown as Partial<SyncEngine>

        const app = buildApp(engine)
        const inside = await app.request('/api/sessions/session-1/files?query=%2Fproject%2Fsrc%2Ffile.ts')
        const outside = await app.request('/api/sessions/session-1/files?query=%2Fother%2Fsrc%2Ffile.ts')

        expect(inside.status).toBe(200)
        expect(await inside.json()).toMatchObject({
            success: true,
            files: [{ fullPath: 'src/file.ts' }]
        })
        expect(outside.status).toBe(200)
        expect(await outside.json()).toEqual({ success: true, files: [], pathSearch: true })
        expect(statPaths).toEqual([['src/file.ts']])
        expect(ripgrepCalls).toBe(0)
    })

    it('recursively searches files under a POSIX directory with a trailing separator', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        let ripgrepArgs: string[] = []
        let fileSearchQuery: string | undefined
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[], _cwd: string, fileSearch?: { query: string }) => {
                ripgrepArgs = args
                fileSearchQuery = fileSearch?.query
                return {
                    success: true,
                    stdout: 'src/web/routes/git.ts\nsrc/web/routes/git.test.ts\n'
                }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => path === 'src/web/routes'
                    ? { path, type: 'directory' as const, size: 100, modified: 100 }
                    : { path, type: 'file' as const, size: 10, modified: 100 })
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request(
            '/api/sessions/session-1/files?query=src%2Fweb%2Froutes%2F'
        )

        expect(response.status).toBe(200)
        expect(ripgrepArgs).toEqual(['--files', '--', 'src/web/routes'])
        expect(fileSearchQuery).toBe('')
        expect(await response.json()).toEqual({
            success: true,
            pathSearch: true,
            files: [
                { fileName: 'git.ts', filePath: 'src/web/routes', fullPath: 'src/web/routes/git.ts', fileType: 'file', size: 10, modified: 100 },
                { fileName: 'git.test.ts', filePath: 'src/web/routes', fullPath: 'src/web/routes/git.test.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('accepts Windows directory separators and returns an empty path result for missing directories', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        let ripgrepCalls = 0
        let statPaths: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => {
                ripgrepCalls += 1
                return { success: true, stdout: 'src\\web\\routes\\git.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => {
                statPaths = paths
                return { success: true, entries: paths.map((path) => ({ path })) }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request(
            '/api/sessions/session-1/files?query=src%5Cweb%5Croutes%5C'
        )

        expect(response.status).toBe(200)
        expect(statPaths).toEqual(['src/web/routes'])
        expect(ripgrepCalls).toBe(0)
        expect(await response.json()).toEqual({ success: true, files: [], pathSearch: true })
    })

    it('does not fall back to global search for missing files or directories', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        let ripgrepCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => {
                ripgrepCalls += 1
                return { success: true, stdout: 'other/src/file.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => path.endsWith('/src')
                    ? { path, type: 'directory' as const, size: 20, modified: 100 }
                    : { path })
            })
        } as unknown as Partial<SyncEngine>

        const app = buildApp(engine)
        const missing = await app.request('/api/sessions/session-1/files?query=src%2Fmissing.ts')
        const directory = await app.request('/api/sessions/session-1/files?query=src%2Fsrc')

        expect(missing.status).toBe(200)
        expect(await missing.json()).toEqual({ success: true, files: [], pathSearch: true })
        expect(directory.status).toBe(200)
        expect(await directory.json()).toEqual({ success: true, files: [], pathSearch: true })
        expect(ripgrepCalls).toBe(0)
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

describe('workspace upload/delete routes', () => {
    const session = { id: 'session-1', namespace: 'default', active: false } as unknown as Session

    it('forwards an upload chunk as base64 with parsed flags', async () => {
        const calls: unknown[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            writeWorkspaceFile: async (_sessionId: string, request: unknown) => {
                calls.push(request)
                return { success: true, size: 5, path: 'src/a.txt' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request(
            '/api/sessions/session-1/workspace/upload?dir=src&name=a.txt&uploadId=upload-0001&offset=0&final=true&overwrite=false',
            { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'hello' }
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, size: 5, path: 'src/a.txt' })
        expect(calls).toEqual([{
            dir: 'src',
            name: 'a.txt',
            uploadId: 'upload-0001',
            offset: 0,
            content: Buffer.from('hello').toString('base64'),
            final: true,
            overwrite: false,
        }])
    })

    it('accepts an empty body for zero-byte files', async () => {
        let content: string | undefined
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            writeWorkspaceFile: async (_sessionId: string, request: { content?: string }) => {
                content = request.content
                return { success: true, size: 0 }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request(
            '/api/sessions/session-1/workspace/upload?name=empty.txt&uploadId=upload-0001&offset=0&final=true',
            { method: 'POST', headers: { 'content-length': '0' } }
        )
        expect(response.status).toBe(200)
        expect(content).toBe('')
    })

    it('forwards a chunk ending at the configured file limit and rejects one that crosses it', async () => {
        let calls = 0
        const app = buildApp({
            resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
            writeWorkspaceFile: async () => {
                calls++
                return { success: true }
            },
        })
        const previous = process.env.HAPI_MAX_UPLOAD_BYTES
        process.env.HAPI_MAX_UPLOAD_BYTES = '5'
        try {
            const url = '/api/sessions/session-1/workspace/upload?name=a.txt&uploadId=upload-0001&offset=3'
            const accepted = await app.request(url, { method: 'POST', body: 'ab' })
            expect(accepted.status).toBe(200)
            const rejected = await app.request(url, { method: 'POST', body: 'abc' })
            expect(rejected.status).toBe(413)
            expect(await rejected.json()).toMatchObject({ success: false, code: 'upload_too_large' })
            expect(calls).toBe(1)
        } finally {
            if (previous === undefined) delete process.env.HAPI_MAX_UPLOAD_BYTES
            else process.env.HAPI_MAX_UPLOAD_BYTES = previous
        }
    })

    it('rejects malformed upload parameters before reaching the runner', async () => {
        let called = false
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            writeWorkspaceFile: async () => {
                called = true
                return { success: true }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request(
            '/api/sessions/session-1/workspace/upload?name=a.txt&uploadId=bad&offset=0',
            { method: 'POST', body: 'x' }
        )
        expect(response.status).toBe(400)
        expect(called).toBe(false)
    })

    it('forwards deletes and surfaces runner errors as success:false', async () => {
        const requests: unknown[] = []
        const app = buildApp({
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            deleteWorkspacePath: async (_sessionId, request) => {
                requests.push(request)
                return request.path === 'src/a.txt' ? { success: true } : { success: false, error: 'Invalid path' }
            },
        })

        const ok = await app.request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'src/a.txt', kind: 'file' })
        })
        expect(await ok.json()).toEqual({ success: true })

        const refused = await app.request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '..', kind: 'directory' })
        })
        expect(await refused.json()).toEqual({ success: false, error: 'Invalid path' })
        expect(requests).toEqual([{ path: 'src/a.txt', kind: 'file' }, { path: '..', kind: 'directory' }])
    })

    it('refuses uploads and deletes that a merged-session redirect would move to another session', async () => {
        let calls = 0
        const app = buildApp({
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'survivor', session }),
            deleteWorkspacePath: async () => {
                calls++
                return { success: true }
            },
            writeWorkspaceFile: async () => {
                calls++
                return { success: true }
            },
        })
        const deleted = await app.request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'src', kind: 'directory' }),
        })
        expect(deleted.status).toBe(409)
        expect(await deleted.json()).toMatchObject({ success: false, code: 'session_moved' })

        const uploaded = await app.request('/api/sessions/session-1/workspace/upload?dir=&name=a.txt&uploadId=abcdefgh12&offset=0&final=true', {
            method: 'POST',
            headers: { 'content-length': '0' },
        })
        expect(uploaded.status).toBe(409)
        expect(calls).toBe(0)
    })

    it('rejects missing and unknown delete kinds before routing', async () => {
        let calls = 0
        const app = buildApp({
            resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
            deleteWorkspacePath: async () => {
                calls++
                return { success: true }
            },
        })
        for (const kind of [undefined, 'other']) {
            const response = await app.request('/api/sessions/session-1/workspace/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: 'src', kind }),
            })
            expect(response.status).toBe(400)
        }
        expect(calls).toBe(0)
    })
})
