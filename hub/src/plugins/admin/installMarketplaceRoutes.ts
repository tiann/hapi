import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import {
    DEFAULT_MAX_PLUGIN_PACKAGE_BYTES,
    DEFAULT_MAX_PLUGIN_PACKAGE_STORAGE_BYTES,
    pluginPackagePayloadIsTooLarge,
    pluginPackagePayloadSize
} from './packagePayloadLimits'
import { DEFAULT_NAMESPACE } from '../../utils/accessToken'

type StoredInstallPlanRequest = Omit<PluginInstallPlanRequest, 'contentBase64'>

type StoredInstallPlan = {
    namespace: string
    request: StoredInstallPlanRequest
    contentPath: string
    packageBytes: number
    storageBytes: number
    expiresAt: number
}

type LoadedStoredInstallPlan =
    | { status: 'ok'; request: PluginInstallPlanRequest; expiresAt: number }
    | { status: 'not-found' }
    | { status: 'expired' }

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
        installPlanTempDir?: string
        maxInstallPlanPackageBytes?: number
        maxInstallPlanStorageBytes?: number
    }
): void {
    const installPlans = new Map<string, StoredInstallPlan>()
    const installPlanTtlMs = options.installPlanTtlMs ?? 10 * 60 * 1000
    const maxInstallPlans = Math.max(1, options.maxInstallPlans ?? 128)
    const installPlanTempDir = options.installPlanTempDir ?? tmpdir()
    const maxInstallPlanPackageBytes = options.maxInstallPlanPackageBytes ?? DEFAULT_MAX_PLUGIN_PACKAGE_BYTES
    const maxInstallPlanStorageBytes = options.maxInstallPlanStorageBytes ?? DEFAULT_MAX_PLUGIN_PACKAGE_STORAGE_BYTES
    let storedInstallPlanStorageBytes = 0
    let installPlanMutationQueue = Promise.resolve()
    const withInstallPlanLock = async <T>(work: () => Promise<T>): Promise<T> => {
        const previous = installPlanMutationQueue
        let release: () => void = () => {}
        installPlanMutationQueue = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await work()
        } finally {
            release()
        }
    }
    const deleteStoredPlanLocked = async (planId: string): Promise<void> => {
        const stored = installPlans.get(planId)
        if (!stored) return
        installPlans.delete(planId)
        storedInstallPlanStorageBytes = Math.max(0, storedInstallPlanStorageBytes - stored.storageBytes)
        await rm(dirname(stored.contentPath), { recursive: true, force: true }).catch(() => undefined)
    }
    const deleteStoredPlan = async (planId: string): Promise<void> => {
        await withInstallPlanLock(async () => {
            await deleteStoredPlanLocked(planId)
        })
    }
    const pruneExpiredInstallPlansLocked = async (now = Date.now()) => {
        for (const [planId, plan] of installPlans) {
            if (plan.expiresAt <= now) {
                await deleteStoredPlanLocked(planId)
            }
        }
    }
    const trimInstallPlansForStoreLocked = async () => {
        while (installPlans.size >= maxInstallPlans) {
            const oldest = installPlans.keys().next().value as string | undefined
            if (!oldest) break
            await deleteStoredPlanLocked(oldest)
        }
    }
    const trimInstallPlanStorageForStoreLocked = async (incomingStorageBytes: number) => {
        while (storedInstallPlanStorageBytes + incomingStorageBytes > maxInstallPlanStorageBytes) {
            const oldest = installPlans.keys().next().value as string | undefined
            if (!oldest) break
            await deleteStoredPlanLocked(oldest)
        }
    }
    const installPlanPackagePayloadIsTooLarge = (request: PluginInstallPlanRequest): boolean => pluginPackagePayloadIsTooLarge(request, {
        maxPluginPackageBytes: maxInstallPlanPackageBytes,
        maxPluginPackageStorageBytes: maxInstallPlanStorageBytes
    })
    const persistInstallPlanRequest = async (request: PluginInstallPlanRequest): Promise<Omit<StoredInstallPlan, 'namespace' | 'expiresAt'>> => {
        const { packageBytes, storageBytes } = pluginPackagePayloadSize(request)
        const dir = await mkdtemp(join(installPlanTempDir, 'hapi-plugin-install-plan-'))
        const contentPath = join(dir, 'package.b64')
        try {
            await writeFile(contentPath, request.contentBase64, { mode: 0o600 })
            const { contentBase64: _contentBase64, ...metadata } = request
            return { request: metadata, contentPath, packageBytes, storageBytes }
        } catch (error) {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined)
            throw error
        }
    }
    const loadStoredRequest = async (plan: StoredInstallPlan): Promise<PluginInstallPlanRequest> => ({
        ...plan.request,
        contentBase64: await readFile(plan.contentPath, 'utf8')
    })
    const storeInstallPlan = async (planId: string, namespace: string, request: PluginInstallPlanRequest, expiresAt: number) => {
        const { storageBytes } = pluginPackagePayloadSize(request)
        await withInstallPlanLock(async () => {
            await pruneExpiredInstallPlansLocked()
            await trimInstallPlansForStoreLocked()
            await trimInstallPlanStorageForStoreLocked(storageBytes)
            const stored = await persistInstallPlanRequest(request)
            installPlans.set(planId, { namespace, ...stored, expiresAt })
            storedInstallPlanStorageBytes += stored.storageBytes
        })
    }
    const loadStoredInstallPlan = async (planId: string, namespace: string): Promise<LoadedStoredInstallPlan> => await withInstallPlanLock(async () => {
        const stored = installPlans.get(planId)
        if (!stored || stored.namespace !== namespace) return { status: 'not-found' }
        if (stored.expiresAt <= Date.now()) {
            await deleteStoredPlanLocked(planId)
            return { status: 'expired' }
        }
        try {
            return {
                status: 'ok',
                request: await loadStoredRequest(stored),
                expiresAt: stored.expiresAt
            }
        } catch {
            await deleteStoredPlanLocked(planId)
            return { status: 'not-found' }
        }
    })

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
            if (installPlanPackagePayloadIsTooLarge(parsed.data)) return c.json({ error: 'Plugin package is too large.' }, 413)
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: parsed.data, planId, now, expiresAt })
            await storeInstallPlan(planId, c.get('namespace'), parsed.data, expiresAt)
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
        const planId = c.req.param('planId')
        const stored = await loadStoredInstallPlan(planId, c.get('namespace'))
        if (stored.status === 'not-found') return c.json({ error: 'Plugin install plan not found or expired' }, 404)
        if (stored.status === 'expired') return c.json({ error: 'Plugin install plan expired' }, 410)
        let executingPlan = false
        try {
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: stored.request, planId, now: Date.now(), expiresAt: stored.expiresAt })
            if (plan.blockingErrors.length > 0) return c.json({ error: 'Plugin install plan is blocked', plan }, 409)
            executingPlan = true
            const result = await executeInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: stored.request, plan })
            await deleteStoredPlan(planId)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            if (executingPlan) await deleteStoredPlan(planId)
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
            if (installPlanPackagePayloadIsTooLarge(marketplacePackage.request)) return c.json({ error: 'Plugin package is too large.' }, 413)
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, planId, now, expiresAt })
            await storeInstallPlan(planId, c.get('namespace'), marketplacePackage.request, expiresAt)
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
            if (installPlanPackagePayloadIsTooLarge(marketplacePackage.request)) return c.json({ error: 'Plugin package is too large.' }, 413)
            const plan = await createInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, planId: randomUUID(), now: Date.now() })
            if (plan.blockingErrors.length > 0) return c.json(PluginMarketplaceInstallPlanResponseSchema.parse({ marketplace: marketplacePackage.marketplace, plan }), 409)
            const result = await executeInstallPlan({ manager, engine: options.getSyncEngine(), namespace: c.get('namespace'), request: marketplacePackage.request, plan })
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })
}
