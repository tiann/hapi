import { FeaturesPatchRequestSchema } from '@hapi/protocol'
import type { PrChipDisplayProfile } from '@hapi/protocol'
import { Hono } from 'hono'
import { getConfiguration, type ConfigSource } from '../../configuration'
import { loadPrChipDisplayProfile } from '../../config/prChipDisplay'
import { readTelemetryLevelState } from '../../config/telemetryLevel'
import type { WebAppEnv } from '../middleware/auth'

export type GithubPrAwarenessState = {
    enabled: boolean
    source: ConfigSource
}

export type TelemetryFeatureState = {
    /** Capability bit: old hubs omit it and web SDKs self-disable. */
    enabled: boolean
    level: number
    source: 'env' | 'file' | 'default'
}

export type FeaturesRouteDeps = {
    getGithubPrAwareness: () => GithubPrAwarenessState
    setGithubPrAwareness: (enabled: boolean) => Promise<void>
    getPrChipDisplay: () => PrChipDisplayProfile
    /** Optional so lighter test harnesses can omit it (defaults to L1). */
    getTelemetry?: () => Promise<TelemetryFeatureState>
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
        getPrChipDisplay: () => loadPrChipDisplayProfile(getConfiguration().dataDir),
        getTelemetry: async () => {
            const state = await readTelemetryLevelState(getConfiguration().dataDir)
            return { enabled: true, level: state.level, source: state.source }
        }
    }
}

const OWNER_ONLY_ERROR = 'Feature settings are only available to the hub owner'

/** Telemetry leg with total tolerance: omitted dep or config hiccup → the
 * opt-in default (0 = off) — never silently upgrade sharing on a read error. */
async function resolveTelemetry(deps: FeaturesRouteDeps): Promise<TelemetryFeatureState> {
    try {
        return (await deps.getTelemetry?.()) ?? { enabled: true, level: 0, source: 'default' }
    } catch {
        return { enabled: true, level: 0, source: 'default' }
    }
}

export function createFeaturesRoutes(deps: FeaturesRouteDeps = defaultDeps()): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/features', async (c) => {
        const githubPrAwareness = deps.getGithubPrAwareness()
        const telemetry = await resolveTelemetry(deps)
        return c.json({
            githubPrAwareness: {
                enabled: githubPrAwareness.enabled,
                source: githubPrAwareness.source
            },
            prChipDisplay: deps.getPrChipDisplay(),
            telemetry: telemetry.enabled,
            telemetryLevel: telemetry.level
        })
    })

    app.patch('/features', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }

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
        const telemetry = await resolveTelemetry(deps)
        return c.json({
            githubPrAwareness: {
                enabled: next.enabled,
                source: next.source
            },
            prChipDisplay: deps.getPrChipDisplay(),
            telemetry: telemetry.enabled,
            telemetryLevel: telemetry.level
        })
    })

    return app
}
