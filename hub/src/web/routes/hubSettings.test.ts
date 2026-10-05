import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createHubSettingsRoutes } from './hubSettings'
import { writeSessionSummaryContractEnabled } from '../../config/sessionSummaryContract'
import { writeSessionSummaryInChatEnabled } from '../../config/sessionSummaryInChat'
import { Store } from '../../store'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** Minimal store stand-in for cases that never reach the lock clear. */
function fakeStore(cleared: () => number = () => 0): Store {
    return { sessions: { clearSessionNameLocks: cleared } } as unknown as Store
}

describe('GET/PUT /api/hub-settings', () => {
    async function createApp(namespace = 'default', store: Store = fakeStore()) {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-hub-settings-'))
        directories.push(dataDir)
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createHubSettingsRoutes(dataDir, store))
        return { app, dataDir }
    }

    it('returns default off for emit and chat display', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false
        })
    })

    it('persists emit toggle for owner without changing display', async () => {
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
            autoTitlePerTurn: false
        })

        const get = await app.request('/api/hub-settings')
        expect(await get.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false
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
            autoTitlePerTurn: false
        })
    })

    it('persists the per-turn title toggle on its own', async () => {
        const { app } = await createApp()
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoTitlePerTurn: true })
        })
        expect(put.status).toBe(200)
        expect(await put.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: true
        })

        const get = await app.request('/api/hub-settings')
        expect(await get.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: true
        })

        const off = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoTitlePerTurn: false })
        })
        expect(off.status).toBe(200)
        expect(await off.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false
        })
    })

    it('clears all name locks when per-turn mode is re-enabled', async () => {
        const store = new Store(':memory:')
        store.sessions.getOrCreateSession(
            'locked-a',
            { path: '/tmp/a', host: 'h', name: 'Manual A', nameLocked: true },
            null,
            'default'
        )
        store.sessions.getOrCreateSession(
            'unlocked-b',
            { path: '/tmp/b', host: 'h', name: 'Agent B' },
            null,
            'default'
        )
        let cleared = -1
        const { app } = await createApp('default', {
            sessions: {
                clearSessionNameLocks: () => (cleared = store.sessions.clearSessionNameLocks())
            }
        } as unknown as Store)

        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoTitlePerTurn: true })
        })
        expect(put.status).toBe(200)
        expect(cleared).toBe(1)

        const sessions = store.sessions.getSessions()
        const locked = sessions.find((s) => s.tag === 'locked-a')
        const unlocked = sessions.find((s) => s.tag === 'unlocked-b')
        expect(locked?.metadata).toMatchObject({ name: 'Manual A' })
        expect((locked?.metadata as Record<string, unknown> | null)?.nameLocked).toBeUndefined()
        expect(unlocked?.metadata).toMatchObject({ name: 'Agent B' })
    })

    it('does not touch name locks for other setting writes', async () => {
        let clearCalls = 0
        const store = fakeStore(() => {
            clearCalls += 1
            return 0
        })
        const { app } = await createApp('default', store)
        const put = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: true })
        })
        expect(put.status).toBe(200)
        expect(clearCalls).toBe(0)

        const off = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoTitlePerTurn: false })
        })
        expect(off.status).toBe(200)
        expect(clearCalls).toBe(0)
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

    it('rejects invalid body', async () => {
        const { app } = await createApp()
        const response = await app.request('/api/hub-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionSummaryContract: 'yes' })
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
        tenantApp.route('/api', createHubSettingsRoutes(dataDir, fakeStore()))

        const get = await tenantApp.request('/api/hub-settings')
        expect(get.status).toBe(200)
        expect(await get.json()).toEqual({
            sessionSummaryContract: false,
            sessionSummaryInChat: true,
            autoTitlePerTurn: false
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
        const response = await app.request('/api/hub-settings')
        expect(await response.json()).toEqual({
            sessionSummaryContract: true,
            sessionSummaryInChat: true,
            autoTitlePerTurn: false
        })
    })
})
