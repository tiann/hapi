import { FeaturesPatchRequestSchema } from '@hapi/protocol'
import type { PrChipDisplayProfile } from '@hapi/protocol'
import { Hono } from 'hono'
import { getConfiguration, type ConfigSource } from '../../configuration'
import { loadPrChipDisplayProfile } from '../../config/prChipDisplay'
import type { WebAppEnv } from '../middleware/auth'

export type GithubPrAwarenessState = {
    enabled: boolean
    source: ConfigSource
}

export type FeaturesRouteDeps = {
    getGithubPrAwareness: () => GithubPrAwarenessState
    setGithubPrAwareness: (enabled: boolean) => Promise<void>
    getPrChipDisplay: () => PrChipDisplayProfile
}

function defaultDeps(): FeaturesRouteDeps {
    return {
        getGithubPrAwareness: () => {
            const configuration = getConfiguration()
            return {
                enabled: configuration.githubPrAwareness,
                source: configuration.sources.githubPrAwareness
            }
        },
        setGithubPrAwareness: async (enabled: boolean) => {
            await getConfiguration().setGithubPrAwareness(enabled)
        },
        getPrChipDisplay: () => loadPrChipDisplayProfile(getConfiguration().dataDir)
    }
}

export function createFeaturesRoutes(deps: FeaturesRouteDeps = defaultDeps()): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/features', (c) => {
        const githubPrAwareness = deps.getGithubPrAwareness()
        return c.json({
            githubPrAwareness: {
                enabled: githubPrAwareness.enabled,
                source: githubPrAwareness.source
            },
            prChipDisplay: deps.getPrChipDisplay()
        })
    })

    app.patch('/features', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = FeaturesPatchRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const current = deps.getGithubPrAwareness()
        if (parsed.data.githubPrAwareness !== undefined) {
            if (current.source === 'env') {
                return c.json({
                    error: 'githubPrAwareness is pinned by HAPI_GITHUB_PR_AWARENESS',
                    code: 'feature_pinned_by_env'
                }, 409)
            }
            try {
                await deps.setGithubPrAwareness(parsed.data.githubPrAwareness)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to update features'
                if (message.includes('pinned by')) {
                    return c.json({ error: message, code: 'feature_pinned_by_env' }, 409)
                }
                return c.json({ error: message }, 500)
            }
        }

        const next = deps.getGithubPrAwareness()
        return c.json({
            githubPrAwareness: {
                enabled: next.enabled,
                source: next.source
            },
            prChipDisplay: deps.getPrChipDisplay()
        })
    })

    return app
}
