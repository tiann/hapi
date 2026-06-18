import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { mountMissingPreviewRoutes, mountPreviewStaticRoutes } from './server'

function createPreviewDist(): string {
    const distDir = mkdtempSync(join(tmpdir(), 'hapi-preview-dist-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="root">preview</div>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("preview")')
    writeFileSync(join(distDir, 'manifest.webmanifest'), '{"name":"HAPI Preview"}')
    return distDir
}

describe('preview static routes', () => {
    it('serves preview assets and deep links under /new without shadowing root', async () => {
        const app = new Hono()
        mountPreviewStaticRoutes(app, createPreviewDist())
        app.get('/', (c) => c.text('root'))

        const asset = await app.request('/new/assets/app.js')
        expect(asset.status).toBe(200)
        expect(await asset.text()).toBe('console.log("preview")')

        const manifest = await app.request('/new/manifest.webmanifest')
        expect(manifest.status).toBe(200)
        expect(await manifest.text()).toContain('HAPI Preview')

        const deepLink = await app.request('/new/sessions/session-1')
        expect(deepLink.status).toBe(200)
        expect(await deepLink.text()).toContain('preview')

        const root = await app.request('/')
        expect(root.status).toBe(200)
        expect(await root.text()).toBe('root')
    })

    it('does not mount preview routes when index.html is missing', async () => {
        const distDir = mkdtempSync(join(tmpdir(), 'hapi-preview-missing-'))
        const app = new Hono()
        expect(mountPreviewStaticRoutes(app, distDir)).toBe(false)
    })

    it('returns an explicit 503 for /new when the preview artifact is missing', async () => {
        const app = new Hono()
        mountMissingPreviewRoutes(app)
        app.get('*', (c) => c.text('root fallback'))

        const response = await app.request('/new/sessions/session-1')

        expect(response.status).toBe(503)
        expect(await response.text()).toContain('Preview app is not built')
    })
})
