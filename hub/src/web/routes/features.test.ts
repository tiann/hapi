import { describe, expect, it } from 'bun:test'
import { DEFAULT_PR_CHIP_DISPLAY } from '@hapi/protocol'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createFeaturesRoutes, type FeaturesRouteDeps } from './features'

function createApp(deps: Partial<FeaturesRouteDeps> & Pick<FeaturesRouteDeps, 'getGithubPrAwareness' | 'setGithubPrAwareness'>) {
    const app = new Hono<WebAppEnv>()
    app.route('/api', createFeaturesRoutes({
        getPrChipDisplay: () => DEFAULT_PR_CHIP_DISPLAY,
        ...deps
    }))
    return app
}

describe('features routes', () => {
    it('returns githubPrAwareness default off plus generic prChipDisplay', async () => {
        const app = createApp({
            getGithubPrAwareness: () => ({ enabled: false, source: 'default' }),
            setGithubPrAwareness: async () => {
                throw new Error('should not write')
            }
        })

        const response = await app.request('/api/features')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            githubPrAwareness: { enabled: false, source: 'default' },
            prChipDisplay: DEFAULT_PR_CHIP_DISPLAY
        })
    })

    it('patches githubPrAwareness when not env-pinned', async () => {
        let enabled = false
        let source: 'default' | 'file' | 'env' = 'default'
        const app = createApp({
            getGithubPrAwareness: () => ({ enabled, source }),
            setGithubPrAwareness: async (next) => {
                enabled = next
                source = 'file'
            }
        })

        const response = await app.request('/api/features', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ githubPrAwareness: true })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            githubPrAwareness: { enabled: true, source: 'file' },
            prChipDisplay: DEFAULT_PR_CHIP_DISPLAY
        })
        expect(enabled).toBe(true)
    })

    it('refuses patch when pinned by env', async () => {
        const app = createApp({
            getGithubPrAwareness: () => ({ enabled: true, source: 'env' }),
            setGithubPrAwareness: async () => {
                throw new Error('should not write')
            }
        })

        const response = await app.request('/api/features', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ githubPrAwareness: false })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'feature_pinned_by_env' })
    })

    it('rejects empty patch body', async () => {
        const app = createApp({
            getGithubPrAwareness: () => ({ enabled: false, source: 'default' }),
            setGithubPrAwareness: async () => {}
        })

        const response = await app.request('/api/features', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(response.status).toBe(400)
    })
})
