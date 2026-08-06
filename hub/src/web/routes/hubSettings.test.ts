import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createHubSettingsRoutes } from './hubSettings'
import { writeSessionSummaryContractEnabled } from '../../config/sessionSummaryContract'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('GET/PUT /api/hub-settings', () => {
    async function createApp(namespace = 'default') {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-hub-settings-'))
        directories.push(dataDir)
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createHubSettingsRoutes(dataDir))
        return { app, dataDir }
    }

    it('returns default off', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({ sessionSummaryContract: false })
    })

    it('persists toggle for owner', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({ sessionSummaryContract: true })

        const get = await app.request('/api/hub-settings')
        expect(await get.json()).toEqual({ sessionSummaryContract: true })
    })

    it('rejects invalid body', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: 'yes' })
        })
        expect(response.status).toBe(400)
    })

    it('rejects non-default namespaces', async () => {
        const { app } = await createApp('tenant')
        const get = await app.request('/api/hub-settings')
        expect(get.status).toBe(403)

        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(put.status).toBe(403)
    })

    it('survives a prior write via settings helper', async () => {
        const { app, dataDir } = await createApp()
        await writeSessionSummaryContractEnabled(dataDir, true)
        const response = await app.request('/api/hub-settings')
        expect(await response.json()).toEqual({ sessionSummaryContract: true })
    })
})
