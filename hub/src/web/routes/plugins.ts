import { Hono, type Context } from 'hono'
import {
    parseRunnerPluginTargetScope,
    PluginConfigUpdateRequestSchema,
    PluginDeleteResultSchema,
    PluginDisableRequestSchema,
    PluginEnableRequestSchema,
    PluginDetailResponseSchema,
    PluginDiagnosticsResponseSchema,
    PluginInstallLocalRequestSchema,
    PluginInstallPackageRequestSchema,
    PluginInstallResultSchema,
    PluginLocalDirectoryListRequestSchema,
    PluginLocalDirectoryListResponseSchema,
    PluginNotificationFilterOptionsResponseSchema,
    PluginNotificationTestResponseSchema,
    PluginReloadResultSchema,
    PluginTargetScopeSchema,
    type PluginTargetScope
} from '@hapi/protocol/plugins/admin'
import { inspectPluginPackagePayload } from '@hapi/protocol/plugins/foundation'
import { pluginRuntimeCompatibilityProblems } from '@hapi/protocol/plugins/runtime/compatibility'
import { buildCapabilitiesPayload } from '../../plugins/admin/capabilityService'
import {
    buildListPayload,
    getRunnerDetail,
} from '../../plugins/admin/inventoryService'
import { registerPluginInstallPlanAndMarketplaceRoutes } from '../../plugins/admin/installMarketplaceRoutes'
import { buildNotificationFilterOptions } from '../../plugins/admin/notificationOptions'
import {
    runRunnerDeleteAction,
    runRunnerInstallAction,
    runRunnerReloadAction
} from '../../plugins/admin/runnerFanout'
import { errorMessage, pluginAdminErrorStatus as errorStatus } from '../../plugins/admin/errors'
import { pluginPackagePayloadIsTooLarge, type PluginPackagePayloadLimitOptions } from '../../plugins/admin/packagePayloadLimits'
import { hubTargetSummary, withTarget } from '../../plugins/admin/target'
import { PluginMarketplaceService } from '../../plugins/marketplaceService'
import type { HubPluginManager } from '../../plugins/pluginManager'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { DEFAULT_NAMESPACE } from '../../utils/accessToken'

function requirePluginManager(c: Context<WebAppEnv>, getPluginManager: () => HubPluginManager | null): HubPluginManager | Response {
    const manager = getPluginManager()
    if (!manager) {
        return c.json({ error: 'Plugin manager is not ready' }, 503)
    }
    return manager
}

function requireSyncEngine(c: Context<WebAppEnv>, getSyncEngine: () => SyncEngine | null): SyncEngine | Response {
    const engine = getSyncEngine()
    if (!engine) {
        return c.json({ error: 'Runner plugin targets are not connected' }, 503)
    }
    return engine
}

function parseTarget(c: Context<WebAppEnv>): PluginTargetScope | null | Response {
    const raw = c.req.query('target')
    if (!raw) return null
    const parsed = PluginTargetScopeSchema.safeParse(raw)
    if (!parsed.success) {
        return c.json({ error: 'Invalid plugin target scope', issues: parsed.error.flatten() }, 400)
    }
    return parsed.data
}

function parseOptionalSessionId(c: Context<WebAppEnv>): string | null | Response {
    const raw = c.req.query('sessionId')
    if (raw === undefined) return null
    const sessionId = raw.trim()
    if (!sessionId) {
        return c.json({ error: 'Invalid sessionId' }, 400)
    }
    return sessionId
}

function requireExplicitInstallTarget(c: Context<WebAppEnv>, target: PluginTargetScope | null): PluginTargetScope | Response {
    if (!target) {
        return c.json({ error: 'Plugin install requires target=hub, target=runner:<machineId>, or target=all-runners.' }, 400)
    }
    return target
}

function requireHubPluginAdmin(c: Context<WebAppEnv>): Response | null {
    if (c.get('namespace') === DEFAULT_NAMESPACE) {
        return null
    }
    return c.json({ error: 'Hub plugin management is restricted to the default namespace.' }, 403)
}

function requireHubPluginAdminForTarget(c: Context<WebAppEnv>, target: PluginTargetScope | null): Response | null {
    return !target || target === 'hub' ? requireHubPluginAdmin(c) : null
}

export function createPluginsRoutes(
    getPluginManager: () => HubPluginManager | null,
    getSyncEngine: () => SyncEngine | null = () => null,
    getMarketplaceService?: () => PluginMarketplaceService | null,
    options: PluginPackagePayloadLimitOptions = {}
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const defaultMarketplaceService = new PluginMarketplaceService()
    const resolveMarketplaceService = getMarketplaceService ?? (() => defaultMarketplaceService)

    registerPluginInstallPlanAndMarketplaceRoutes(app, {
        getPluginManager,
        getSyncEngine,
        resolveMarketplaceService,
        maxInstallPlanPackageBytes: options.maxPluginPackageBytes,
        maxInstallPlanStorageBytes: options.maxPluginPackageStorageBytes
    })

    app.get('/plugins', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const { payload } = await buildListPayload({
            manager,
            engine: getSyncEngine(),
            namespace: c.get('namespace'),
            target
        })
        if (payload && typeof payload === 'object' && 'error' in payload) {
            return c.json(payload, 404)
        }
        return c.json(payload)
    })

    app.get('/plugins/diagnostics', (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const machineId = parseRunnerPluginTargetScope(target)
            const machines = machineId
                ? [engine.getMachineByNamespace(machineId, c.get('namespace'))].filter((entry): entry is Machine => Boolean(entry))
                : engine.getMachinesByNamespace(c.get('namespace'))
            const diagnostics = machines.flatMap((machine) => machine.runnerState?.pluginInventory?.diagnostics ?? [])
            return c.json(PluginDiagnosticsResponseSchema.parse({ diagnostics }))
        }
        return c.json(PluginDiagnosticsResponseSchema.parse({ diagnostics: manager.getDiagnostics() }))
    })

    app.get('/plugins/notification-filter-options', (c) => {
        return c.json(PluginNotificationFilterOptionsResponseSchema.parse(buildNotificationFilterOptions(getSyncEngine(), c.get('namespace'))))
    })

    app.get('/plugins/capabilities', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const sessionId = parseOptionalSessionId(c)
        if (sessionId instanceof Response) return sessionId

        const result = await buildCapabilitiesPayload({
            manager,
            engine: getSyncEngine(),
            namespace: c.get('namespace'),
            target,
            sessionId
        })
        if ('error' in result) {
            return c.json({ error: result.error }, result.status)
        }
        return c.json(result.payload)
    })

    app.post('/plugins/reload', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                action: async (machineId) => await engine.reloadRunnerPlugins(machineId)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const targetSummary = hubTargetSummary()
        const result = await manager.reload()
        return c.json(PluginReloadResultSchema.parse({ ...result, target: targetSummary, plugins: result.plugins.map((plugin) => withTarget(plugin, targetSummary)) }))
    })

    app.post('/plugins/install-local', async (c) => {
        const parsedTarget = parseTarget(c)
        if (parsedTarget instanceof Response) return parsedTarget
        const target = requireExplicitInstallTarget(c, parsedTarget)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallLocalRequestSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            try {
                return c.json(PluginInstallResultSchema.parse({
                    ...(await manager.installLocalPlugin(parsed.data.sourcePath, parsed.data)),
                    target: hubTargetSummary()
                }))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const result = await runRunnerInstallAction({
            engine,
            namespace: c.get('namespace'),
            target,
            action: async (machineId) => await engine.installRunnerPluginLocal(machineId, parsed.data)
        })
        return result instanceof Response ? result : c.json(PluginInstallResultSchema.parse(result))
    })

    app.post('/plugins/install-package', async (c) => {
        const parsedTarget = parseTarget(c)
        if (parsedTarget instanceof Response) return parsedTarget
        const target = requireExplicitInstallTarget(c, parsedTarget)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallPackageRequestSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (pluginPackagePayloadIsTooLarge(parsed.data, options)) return c.json({ error: 'Plugin package is too large.' }, 413)
        let packageInspection: Awaited<ReturnType<typeof inspectPluginPackagePayload>>
        try {
            packageInspection = await inspectPluginPackagePayload(parsed.data)
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
        if (target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            try {
                const problems = pluginRuntimeCompatibilityProblems(packageInspection.manifest, 'hub', hubTargetSummary().hostInfo)
                if (problems.length > 0) return c.json({ error: problems.join(' ') }, 409)
                return c.json(PluginInstallResultSchema.parse({ ...(await manager.installPluginPackage(parsed.data)), target: hubTargetSummary() }))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const result = await runRunnerInstallAction({
            engine,
            namespace: c.get('namespace'),
            target,
            preflight: (machine) => pluginRuntimeCompatibilityProblems(packageInspection.manifest, 'runner', machine.runnerState?.pluginInventory?.hostInfo),
            action: async (machineId) => {
                return await engine.installRunnerPluginPackage(machineId, parsed.data)
            }
        })
        return result instanceof Response ? result : c.json(PluginInstallResultSchema.parse(result))
    })

    app.post('/plugins/local-directory', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginLocalDirectoryListRequestSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (!target || target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            return c.json(PluginLocalDirectoryListResponseSchema.parse(await manager.listLocalDirectory(parsed.data.path)))
        }
        if (target === 'all-runners') return c.json({ error: 'Directory browsing requires a single target; choose target=runner:<machineId>.' }, 400)
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const machineId = parseRunnerPluginTargetScope(target)
        const machine = machineId ? engine.getMachineByNamespace(machineId, c.get('namespace')) : undefined
        if (!machine) return c.json({ error: 'Runner target not found' }, 404)
        if (!machine.active) return c.json({ error: 'Runner target is offline' }, 503)
        try {
            return c.json(PluginLocalDirectoryListResponseSchema.parse(await engine.listRunnerPluginDirectory(machine.id, parsed.data.path)))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 500)
        }
    })

    app.get('/plugins/:id', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            if (target === 'all-runners') return c.json({ error: 'Plugin detail requires target=hub or target=runner:<machineId>.' }, 400)
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const detail = await getRunnerDetail(engine, c.get('namespace'), target, c.req.param('id'))
            if (detail instanceof Response) return detail
            return c.json(PluginDetailResponseSchema.parse({ plugin: detail }))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const plugin = manager.getPlugin(c.req.param('id'))
        if (!plugin) return c.json({ error: 'Plugin not found' }, 404)
        return c.json(PluginDetailResponseSchema.parse({ plugin: withTarget(plugin, hubTargetSummary()) }))
    })

    app.post('/plugins/:id/reload', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({ engine, namespace: c.get('namespace'), target, action: async (machineId) => await engine.reloadRunnerPlugins(machineId, pluginId) })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const result = await manager.reload(c.req.param('id'))
        return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
    })

    app.post('/plugins/:id/notification-test', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdmin(c)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            return c.json({ error: 'Notification test supports Hub plugin target only.' }, 400)
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        try {
            return c.json(PluginNotificationTestResponseSchema.parse(await manager.testNotification(c.req.param('id'), c.get('namespace'))))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/:id/enable', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginEnableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({ engine, namespace: c.get('namespace'), target, action: async (machineId) => await engine.enableRunnerPlugin(machineId, pluginId, parsed.data.config, parsed.data.reload !== false) })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        try {
            const result = await manager.enablePlugin(c.req.param('id'), parsed.data.config, parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/:id/disable', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginDisableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({ engine, namespace: c.get('namespace'), target, action: async (machineId) => await engine.disableRunnerPlugin(machineId, pluginId, parsed.data.reload !== false) })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        try {
            const result = await manager.disablePlugin(c.req.param('id'), parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.delete('/plugins/:id', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            try {
                const result = await runRunnerDeleteAction({ engine, namespace: c.get('namespace'), target, pluginId, action: async (machineId) => await engine.deleteRunnerPlugin(machineId, pluginId) })
                return result instanceof Response ? result : c.json(PluginDeleteResultSchema.parse(result))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        try {
            const result = await manager.deletePlugin(c.req.param('id'))
            return c.json(PluginDeleteResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.patch('/plugins/:id/config', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const hubAdminError = requireHubPluginAdminForTarget(c, target)
        if (hubAdminError) return hubAdminError
        const json = await c.req.json().catch(() => null)
        const parsed = PluginConfigUpdateRequestSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({ engine, namespace: c.get('namespace'), target, action: async (machineId) => await engine.updateRunnerPluginConfig(machineId, pluginId, parsed.data.config) })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        try {
            const result = await manager.updatePluginConfig(c.req.param('id'), parsed.data.config)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    return app
}
