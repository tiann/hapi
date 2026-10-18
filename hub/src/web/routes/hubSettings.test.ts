import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createHubSettingsRoutes } from './hubSettings'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createApp(namespace = 'default') {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-hub-settings-'))
    directories.push(dataDir)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
    app.route('/api', createHubSettingsRoutes(dataDir))
    return app
}

describe('GET/PUT /api/hub-settings', () => {
    it('persists the chat display toggle', async () => {
        const app = await createApp()
        expect(await (await app.request('/api/hub-settings')).json()).toEqual({ sessionSummaryInChat: false })

        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryInChat: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({ sessionSummaryInChat: true })
        expect(await (await app.request('/api/hub-settings')).json()).toEqual({ sessionSummaryInChat: true })
    })

    it('rejects removed prompt injection settings', async () => {
        const app = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(response.status).toBe(400)
    })

    it('keeps mutations owner-only', async () => {
        const app = await createApp('tenant')
        expect((await app.request('/api/hub-settings')).status).toBe(200)
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryInChat: true })
        })
        expect(put.status).toBe(403)
    })
})
