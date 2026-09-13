import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serveStaticMount } from './staticServer'
import type { PreviewMount } from './mountManager'
import type { PreviewConnSink } from './tunnelClient'

const root = mkdtempSync(join(tmpdir(), 'hapi-preview-'))
const outsideDir = mkdtempSync(join(tmpdir(), 'hapi-preview-outside-'))

function makeMount(overrides: Partial<PreviewMount> = {}): PreviewMount {
    return {
        mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
        kind: 'static',
        name: 'site',
        rootPath: root,
        ws: false,
        publicUrl: 'http://hub/preview/5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b/',
        expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(),
        ...overrides
    }
}

interface Recorded {
    response: { status: number; headers: Record<string, unknown> } | null
    body: Buffer
    ended: boolean
    error: { status?: number; message: string } | null
    closed: boolean
}

function makeSink(): { sink: PreviewConnSink; recorded: Recorded } {
    const recorded: Recorded = { response: null, body: Buffer.alloc(0), ended: false, error: null, closed: false }
    const sink: PreviewConnSink = {
        respond(response) {
            recorded.response = response
        },
        data(payload) {
            recorded.body = Buffer.concat([recorded.body, Buffer.from(payload)])
        },
        end() {
            recorded.ended = true
        },
        error(status, message) {
            recorded.error = { status, message }
        },
        wsMessage() {},
        wsClose() {},
        close() {
            recorded.closed = true
        }
    }
    return { sink, recorded }
}

function openFrame(overrides: Record<string, unknown> = {}) {
    return {
        type: 'open' as const,
        connId: 'conn-1',
        mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
        kind: 'http' as const,
        method: 'GET',
        path: '',
        headers: {},
        ...overrides
    }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
    writeFileSync(join(root, 'index.html'), '<html>hello</html>')
    writeFileSync(join(root, 'app.js'), 'console.log(1)')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'data.json'), '{"a":1}')
})

afterEach(() => {
    rmSync(join(root, '.secret'), { force: true })
    rmSync(join(root, 'link-out'), { force: true })
})

describe('serveStaticMount', () => {
    it('serves index.html for the root path', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame(), sink)
        await flush()

        expect(recorded.response?.status).toBe(200)
        expect(recorded.response?.headers['content-type']).toContain('text/html')
        expect(recorded.body.toString()).toBe('<html>hello</html>')
        expect(recorded.ended).toBe(true)
        expect(recorded.response?.headers['etag']).toBeTruthy()
        expect(recorded.response?.headers['x-content-type-options']).toBe('nosniff')
    })

    it('serves sub-path files with the right MIME type', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: 'sub/data.json' }), sink)
        await flush()

        expect(recorded.response?.status).toBe(200)
        expect(recorded.response?.headers['content-type']).toContain('application/json')
        expect(recorded.body.toString()).toBe('{"a":1}')
    })

    it('answers 304 on a matching If-None-Match without a body', async () => {
        const first = makeSink()
        serveStaticMount(makeMount(), openFrame(), first.sink)
        await flush()
        const etag = first.recorded.response?.headers['etag']

        const second = makeSink()
        serveStaticMount(makeMount(), openFrame({ headers: { 'if-none-match': String(etag) } }), second.sink)
        await flush()

        expect(second.recorded.response?.status).toBe(304)
        expect(second.recorded.body).toHaveLength(0)
        expect(second.recorded.ended).toBe(true)
    })

    it('serves HEAD with headers but no body', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ method: 'HEAD' }), sink)
        await flush()

        expect(recorded.response?.status).toBe(200)
        expect(recorded.response?.headers['content-length']).toBe(String('<html>hello</html>'.length))
        expect(recorded.body).toHaveLength(0)
        expect(recorded.ended).toBe(true)
    })

    it('rejects non-GET/HEAD methods with 405', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ method: 'POST' }), sink)
        await flush()

        expect(recorded.response?.status).toBe(405)
        expect(recorded.error).toBeNull()
        expect(recorded.ended).toBe(true)
    })

    it('blocks traversal attempts', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: '../../etc/passwd' }), sink)
        await flush()

        expect(recorded.error?.status).toBe(404)
        expect(recorded.response).toBeNull()
    })

    it('blocks dotfiles', async () => {
        writeFileSync(join(root, '.secret'), 'nope')
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: '.secret' }), sink)
        await flush()

        expect(recorded.error?.status).toBe(404)
    })

    it('blocks symlink escapes outside the root', async () => {
        const outsideFile = join(outsideDir, 'leak.txt')
        writeFileSync(outsideFile, 'secret')
        symlinkSync(outsideFile, join(root, 'link-out'))

        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: 'link-out' }), sink)
        await flush()

        expect(recorded.error?.status).toBe(404)
    })

    it('returns 404 for missing files and directories without index.html', async () => {
        const missing = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: 'nope.html' }), missing.sink)
        await flush()
        expect(missing.recorded.error?.status).toBe(404)

        const noIndex = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: 'sub/' }), noIndex.sink)
        await flush()
        expect(noIndex.recorded.error?.status).toBe(404)
    })

    it('redirects directories without a trailing slash', async () => {
        const { sink, recorded } = makeSink()
        serveStaticMount(makeMount(), openFrame({ path: 'sub' }), sink)
        await flush()

        expect(recorded.response?.status).toBe(301)
        expect(recorded.response?.headers['location']).toBe('sub/')
    })
})
