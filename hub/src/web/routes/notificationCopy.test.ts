import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createNotificationCopyRoutes } from './notificationCopy'

let dir: string

async function createApp(namespace: string): Promise<Hono<WebAppEnv>> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createNotificationCopyRoutes(dir))
    return app
}

function readSettings(): Promise<Record<string, unknown>> {
    return readFile(join(dir, 'settings.json'), 'utf8').then(JSON.parse)
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hapi-copy-route-'))
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ cliApiToken: 'abc' }))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('GET /api/notification-copy', () => {
    it('rejects non-default namespaces with 403', async () => {
        const app = await createApp('user-1')
        const res = await app.request('/api/notification-copy')
        expect(res.status).toBe(403)
    })

    it('returns stored copy plus defaults for the admin namespace', async () => {
        await writeFile(join(dir, 'settings.json'), JSON.stringify({
            cliApiToken: 'abc',
            notificationCopy: { ready: { title: 'Hey', body: '{agentName}' } }
        }))
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy')
        expect(res.status).toBe(200)
        const body = await res.json() as { copy: Record<string, unknown>; defaults: Record<string, unknown> }
        expect(body.copy).toEqual({ ready: { title: 'Hey', body: '{agentName}' } })
        expect(body.defaults.ready).toBeTruthy()
    })

    it('returns empty copy when no notificationCopy key exists', async () => {
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy')
        const body = await res.json() as { copy: Record<string, unknown> }
        expect(body.copy).toEqual({})
    })
})

describe('PUT /api/notification-copy', () => {
    it('rejects non-default namespaces with 403', async () => {
        const app = await createApp('user-1')
        const res = await app.request('/api/notification-copy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ready: { title: 'x', body: 'y' } })
        })
        expect(res.status).toBe(403)
    })

    it('stores only the provided keys and preserves other settings', async () => {
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ready: { title: 'Hey', body: '{agentName}' } })
        })
        expect(res.status).toBe(200)
        const settings = await readSettings()
        expect(settings.cliApiToken).toBe('abc')
        expect(settings.notificationCopy).toEqual({ ready: { title: 'Hey', body: '{agentName}' } })
    })

    it('stores empty templates as reset-to-default markers', async () => {
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ready: { title: '', body: '' } })
        })
        expect(res.status).toBe(200)
        const settings = await readSettings()
        expect(settings.notificationCopy).toEqual({ ready: { title: '', body: '' } })
    })

    it('rejects title over 500 chars', async () => {
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ready: { title: 'x'.repeat(501), body: 'y' } })
        })
        expect(res.status).toBe(400)
    })

    it('rejects invalid bodies', async () => {
        const app = await createApp('default')
        const res = await app.request('/api/notification-copy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ready: { title: 42 } })
        })
        expect(res.status).toBe(400)
    })
})
