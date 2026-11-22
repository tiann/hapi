import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { STOCK_PEER_SPAWN_DEFAULTS } from '@hapi/protocol/peerSpawnDefaults'
import type { WebAppEnv } from '../middleware/auth'
import { createHubSettingsRoutes } from './hubSettings'
import { writeAutoBridgeTransientModelErrorsEnabled } from '../../config/autoBridgeTransientModelErrors'
import { writeSessionSummaryContractEnabled } from '../../config/sessionSummaryContract'
import { writeSessionSummaryInChatEnabled } from '../../config/sessionSummaryInChat'

const directories: string[] = []
const stockPeerSpawnDefaults = {
    ...STOCK_PEER_SPAWN_DEFAULTS,
    permissionMode: 'bypassPermissions' as const
}

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

    it('returns default off for emit, chat display, auto-bridge, and stock peer spawn defaults', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })
    })

    it('persists emit toggle for owner without changing display or auto-bridge', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })

        const get = await app.request('/api/hub-settings')
        expect(await get.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })
    })

    it('persists chat display toggle for owner without changing emit', async () => {
        const { app, dataDir } = await createApp()
        await writeSessionSummaryContractEnabled(dataDir, true)

        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryInChat: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: true,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })
    })

    it('persists autoBridgeTransientModelErrors toggle for owner', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoBridgeTransientModelErrors: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: true,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })
    })

    it('persists peer spawn defaults', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                peerSpawnDefaults: {
                    agent: 'cursor',
                    permissionMode: 'yolo',
                    models: { cursor: 'auto' }
                }
            })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: {
                agent: 'cursor',
                permissionMode: 'yolo',
                models: {
                    claude: 'sonnet',
                    cursor: 'auto'
                }
            }
        })
    })

    it('clears a saved peer spawn model override with an empty string', async () => {
        const { app } = await createApp()
        await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'default',
                    models: { codex: 'gpt-5' }
                }
            })
        })

        const clear = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'default',
                    models: { codex: '' }
                }
            })
        })
        expect(clear.status).toBe(200)
        expect(await clear.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: {
                agent: 'codex',
                permissionMode: 'default',
                models: {
                    claude: 'sonnet'
                }
            }
        })
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

    it('rejects combined two-field updates', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionSummaryContract: true,
                autoBridgeTransientModelErrors: true
            })
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Update one hub setting per request' })
    })

    it('rejects retired gemini as peer spawn default agent', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                peerSpawnDefaults: { agent: 'gemini' }
            })
        })
        expect(response.status).toBe(400)
    })

    it('rejects empty body', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(response.status).toBe(400)
    })

    it('rejects non-default namespaces for PUT but allows GET', async () => {
        const { app, dataDir } = await createApp('default')
        await writeSessionSummaryInChatEnabled(dataDir, true)

        const tenantApp = new Hono<WebAppEnv>()
        tenantApp.use('*', async (c, next) => {
            c.set('namespace', 'tenant')
            await next()
        })
        tenantApp.route('/api', createHubSettingsRoutes(dataDir))

        const get = await tenantApp.request('/api/hub-settings')
        expect(get.status).toBe(200)
        expect(await get.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: true,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })

        const put = await tenantApp.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(put.status).toBe(403)
    })

    it('survives a prior write via settings helpers', async () => {
        const { app, dataDir } = await createApp()
        await writeSessionSummaryContractEnabled(dataDir, true)
        await writeSessionSummaryInChatEnabled(dataDir, true)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, true)
        const response = await app.request('/api/hub-settings')
        expect(await response.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: true,
            autoBridgeTransientModelErrors: true,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: stockPeerSpawnDefaults
        })
    })

    it('opts into developer mode via a single-field telemetryLevel patch', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ telemetryLevel: 2 })
        })
        expect(put.status).toBe(200)
        const body = await put.json() as { telemetryLevel?: number; telemetryLevelSource?: string }
        expect(body.telemetryLevel).toBe(2)
        expect(body.telemetryLevelSource).toBe('file')
        const get = await app.request('/api/hub-settings')
        expect(((await get.json()) as { telemetryLevel?: number }).telemetryLevel).toBe(2)
    })

    it('refuses a telemetryLevel write while the env pin holds', async () => {
        process.env.HAPI_TELEMETRY_LEVEL = '1'
        try {
            const { app } = await createApp()
            const put = await app.request('/api/hub-settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ telemetryLevel: 2 })
            })
            expect(put.status).toBe(409)
            expect(((await put.json()) as { code?: string }).code).toBe('telemetry_level_pinned_by_env')
        } finally {
            delete process.env.HAPI_TELEMETRY_LEVEL
        }
    })

    it('keeps telemetryLevel inside the one-field-per-request discipline', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ telemetryLevel: 1, sessionSummaryContract: true })
        })
        expect(put.status).toBe(400)
        expect(((await put.json()) as { error?: string }).error).toBe('Update one hub setting per request')
    })

    it('rejects out-of-range levels via the shared schema', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ telemetryLevel: 9 })
        })
        expect(put.status).toBe(400)
    })

    it('keeps the telemetryLevel patch owner-only', async () => {
        const { app } = await createApp('tenant')
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ telemetryLevel: 1 })
        })
        expect(put.status).toBe(403)
    })
})
