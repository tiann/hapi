import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createUpgradeRoutes } from './upgrade'
import {
    initFleetUpgradePolicy,
    resetFleetUpgradePolicyForTests,
} from '../../upgrade/fleetUpgradePolicy'

const tmpDirs: string[] = []

function makeApp() {
    const app = new Hono<WebAppEnv>()
    app.route('/api', createUpgradeRoutes())
    return app
}

afterEach(() => {
    resetFleetUpgradePolicyForTests()
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('upgrade routes', () => {
    it('GET /upgrade/offer includes the current policy', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-upgrade-'))
        tmpDirs.push(dir)
        initFleetUpgradePolicy({ dataDir: dir, persisted: 'alert' })

        const res = await makeApp().request('/api/upgrade/offer')
        expect(res.status).toBe(200)
        const body = await res.json() as { offer: { targetVersion: string }; policy: string }
        expect(body.policy).toBe('alert')
        expect(typeof body.offer.targetVersion).toBe('string')
    })

    it('PUT /upgrade/policy updates a valid policy', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-upgrade-'))
        tmpDirs.push(dir)
        initFleetUpgradePolicy({ dataDir: dir, persisted: 'auto' })

        const res = await makeApp().request('/api/upgrade/policy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ policy: 'silent' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ policy: 'silent' })

        const after = await makeApp().request('/api/upgrade/offer')
        expect((await after.json() as { policy: string }).policy).toBe('silent')
    })

    it('PUT /upgrade/policy rejects an invalid policy', async () => {
        const res = await makeApp().request('/api/upgrade/policy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ policy: 'turbo' }),
        })
        expect(res.status).toBe(400)
    })
})
