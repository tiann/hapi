import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import {
    PluginInstallPlanRequestSchema,
    PluginInstallPlanResponseSchema,
    PluginInstallResultSchema,
    type PluginInstallPlanRequest,
    type PluginListItem
} from '@hapi/protocol/plugins/admin'
import {
    PluginMarketplaceDetailResponseSchema,
    PluginMarketplaceInstallPlanResponseSchema,
    PluginMarketplaceInstallRequestSchema,
    PluginMarketplaceListResponseSchema
} from '@hapi/protocol/plugins/marketplace'
import type { WebAppEnv } from '../../web/middleware/auth'
import type { SyncEngine } from '../../sync/syncEngine'
import type { HubPluginManager } from '../pluginManager'
import { PluginMarketplaceService } from '../marketplaceService'
import { createPluginMarketplaceHostContext, type PluginMarketplaceHostContext } from '@hapi/protocol/plugins/runtime/versioning'
import { buildInstallTargetCandidates, createInstallPlan, executeInstallPlan } from './installPlanService'
import { marketplaceEntriesWithInstallState, marketplaceEntryMatches } from './marketplaceViewService'
import { errorMessage, pluginAdminErrorStatus as errorStatus } from './errors'
import { DEFAULT_NAMESPACE } from '../../utils/accessToken'

async function buildMarketplaceViewState(options: {
    manager: HubPluginManager | null
    engine: SyncEngine | null
    namespace: string
}): Promise<{ plugins: PluginListItem[]; hostContext?: PluginMarketplaceHostContext }> {
    if (!options.manager) {
        return { plugins: [] }
    }
    const candidates = await buildInstallTargetCandidates({
        manager: options.manager,
        engine: options.engine,
        namespace: options.namespace
    })
    return {
        plugins: candidates.flatMap((candidate) => candidate.plugins),
        hostContext: createPluginMarketplaceHostContext(candidates.map((candidate) => ({
            runtime: candidate.target.runtime,
            ...(candidate.target.hostInfo ? { hostInfo: candidate.target.hostInfo } : {})
        })))
    }
}

function requireHubPluginAdminNamespace(namespace: string): Response | null {
    if (namespace === DEFAULT_NAMESPACE) {
        return null
    }
    return Response.json({ error: 'Hub plugin management is restricted to the default namespace.' }, { status: 403 })
}

export function registerPluginInstallPlanAndMarketplaceRoutes(
    app: Hono<WebAppEnv>,
    options: {
        getPluginManager: () => HubPluginManager | null
        getSyncEngine: () => SyncEngine | null
        resolveMarketplaceService: () => PluginMarketplaceService | null
        installPlanTtlMs?: number
        maxInstallPlans?: number
    }
): void {
    const installPlans = new Map<string, { namespace: string; request: PluginInstallPlanRequest; expiresAt: number }>()
    const installPlanTtlMs = options.installPlanTtlMs ?? 10 * 60 * 1000
    const maxInstallPlans = options.maxInstallPlans ?? 128
    const pruneInstallPlans = (now = Date.now()) => {
        for (const [planId, plan] of installPlans) {
            if (plan.expiresAt <= now) {
                installPlans.delete(planId)
            }
        }
        while (installPlans.size >= maxInstallPlans) {
            const oldest = installPlans.keys().next().value as string | undefined
            if (!oldest) break
            installPlans.delete(oldest)
        }
    }
    const storeInstallPlan = (planId: string, plan: { namespace: string; request: PluginInstallPlanRequest; expiresAt: number }) => {
        pruneInstallPlans()
        installPlans.set(planId, plan)
    }

    app.post('/plugins/install-plan', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const manager = options.getPluginManager()
        if (!manager) return c.json({ error: 'Plugin manager is not ready' }, 503)
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallPlanRequestSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        const planId = randomUUID()
        const now = Date.now()
        const expiresAt = now + installPlanTtlMs
        try {
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: parsed.data, planId, now, expiresAt })
            storeInstallPlan(planId, { namespace: c.get('namespace'), request: parsed.data, expiresAt })
            return c.json(PluginInstallPlanResponseSchema.parse(plan))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/install-plan/:planId/execute', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const manager = options.getPluginManager()
        if (!manager) return c.json({ error: 'Plugin manager is not ready' }, 503)
        pruneInstallPlans()
        const planId = c.req.param('planId')
        const stored = installPlans.get(planId)
        if (!stored || stored.namespace !== c.get('namespace')) return c.json({ error: 'Plugin install plan not found or expired' }, 404)
        if (stored.expiresAt <= Date.now()) {
            installPlans.delete(planId)
            return c.json({ error: 'Plugin install plan expired' }, 410)
        }
        try {
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: stored.request, planId, now: Date.now(), expiresAt: stored.expiresAt })
            if (plan.blockingErrors.length > 0) return c.json({ error: 'Plugin install plan is blocked', plan }, 409)
            const result = await executeInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: stored.request, plan })
            installPlans.delete(planId)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.get('/plugins/marketplace', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const service = options.resolveMarketplaceService()
        if (!service) return c.json({ error: 'Plugin marketplace is not ready' }, 503)
        try {
            const snapshot = await service.getCatalog()
            const filters = { query: c.req.query('q')?.trim(), category: c.req.query('category')?.trim(), runtime: c.req.query('runtime')?.trim() }
            const viewState = await buildMarketplaceViewState({ manager: options.getPluginManager(), engine: options.getSyncEngine(), namespace: c.get('namespace') })
            const entries = marketplaceEntriesWithInstallState(snapshot.catalog.plugins.filter((entry) => marketplaceEntryMatches(entry, filters)), viewState.plugins, viewState.hostContext)
            return c.json(PluginMarketplaceListResponseSchema.parse({ sourceUrl: snapshot.sourceUrl, fetchedAt: snapshot.fetchedAt, entries }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/refresh', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const service = options.resolveMarketplaceService()
        if (!service) return c.json({ error: 'Plugin marketplace is not ready' }, 503)
        try {
            const snapshot = await service.getCatalog({ force: true })
            const viewState = await buildMarketplaceViewState({ manager: options.getPluginManager(), engine: options.getSyncEngine(), namespace: c.get('namespace') })
            const entries = marketplaceEntriesWithInstallState(snapshot.catalog.plugins, viewState.plugins, viewState.hostContext)
            return c.json(PluginMarketplaceListResponseSchema.parse({ sourceUrl: snapshot.sourceUrl, fetchedAt: snapshot.fetchedAt, entries }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.get('/plugins/marketplace/:id', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const service = options.resolveMarketplaceService()
        if (!service) return c.json({ error: 'Plugin marketplace is not ready' }, 503)
        try {
            const { snapshot, entry } = await service.getEntry(c.req.param('id'))
            const viewState = await buildMarketplaceViewState({ manager: options.getPluginManager(), engine: options.getSyncEngine(), namespace: c.get('namespace') })
            const [entryView] = marketplaceEntriesWithInstallState([entry], viewState.plugins, viewState.hostContext)
            return c.json(PluginMarketplaceDetailResponseSchema.parse({ sourceUrl: snapshot.sourceUrl, fetchedAt: snapshot.fetchedAt, entry: entryView }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/:id/install-plan', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const manager = options.getPluginManager()
        if (!manager) return c.json({ error: 'Plugin manager is not ready' }, 503)
        const service = options.resolveMarketplaceService()
        if (!service) return c.json({ error: 'Plugin marketplace is not ready' }, 503)
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginMarketplaceInstallRequestSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        const planId = randomUUID()
        const now = Date.now()
        const expiresAt = now + installPlanTtlMs
        try {
            const candidates = await buildInstallTargetCandidates({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace') })
            const hostContext = createPluginMarketplaceHostContext(candidates.map((candidate) => ({
                runtime: candidate.target.runtime,
                ...(candidate.target.hostInfo ? { hostInfo: candidate.target.hostInfo } : {})
            })))
            const marketplacePackage = await service.buildInstallPlanRequest(c.req.param('id'), parsed.data, hostContext)
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, planId, now, expiresAt })
            storeInstallPlan(planId, { namespace: c.get('namespace'), request: marketplacePackage.request, expiresAt })
            return c.json(PluginMarketplaceInstallPlanResponseSchema.parse({ marketplace: marketplacePackage.marketplace, plan }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/:id/install', async (c) => {
        const hubAdminError = requireHubPluginAdminNamespace(c.get('namespace'))
        if (hubAdminError) return hubAdminError
        const manager = options.getPluginManager()
        if (!manager) return c.json({ error: 'Plugin manager is not ready' }, 503)
        const service = options.resolveMarketplaceService()
        if (!service) return c.json({ error: 'Plugin marketplace is not ready' }, 503)
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginMarketplaceInstallRequestSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        try {
            const candidates = await buildInstallTargetCandidates({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace') })
            const hostContext = createPluginMarketplaceHostContext(candidates.map((candidate) => ({
                runtime: candidate.target.runtime,
                ...(candidate.target.hostInfo ? { hostInfo: candidate.target.hostInfo } : {})
            })))
            const marketplacePackage = await service.buildInstallPlanRequest(c.req.param('id'), parsed.data, hostContext)
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, planId: randomUUID(), now: Date.now() })
            if (plan.blockingErrors.length > 0) return c.json(PluginMarketplaceInstallPlanResponseSchema.parse({ marketplace: marketplacePackage.marketplace, plan }), 409)
            const result = await executeInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, plan })
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })
}
