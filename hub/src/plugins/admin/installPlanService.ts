import {
    PluginInstallPlanResponseSchema,
    PluginInstallResultSchema,
    type PluginInstallPackageRequest,
    type PluginInstallPlanRequest,
    type PluginInstallPlanResponse,
    type PluginInstallResult,
    type PluginListItem
} from '@hapi/protocol/plugins/admin'
import { inspectPluginPackagePayload } from '@hapi/protocol/plugins/foundation'
import { buildPluginInstallPlan, type PluginInstallTargetCandidate } from '../installPlanner'
import type { HubPluginManager } from '../pluginManager'
import type { SyncEngine } from '../../sync/syncEngine'
import { errorMessage } from './errors'
import { hubInventory, loadRunnerInventory, cachedRunnerInventory } from './inventoryService'
import { hubTargetSummary, runnerTargetSummary, withTarget } from './target'

export async function buildInstallTargetCandidates(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
}): Promise<PluginInstallTargetCandidate[]> {
    const candidates: PluginInstallTargetCandidate[] = []
    const hub = hubInventory(options.manager)
    candidates.push({ target: hub.target, plugins: hub.plugins })

    if (!options.engine) {
        return candidates
    }

    const machines = options.engine.getMachinesByNamespace(options.namespace)
    const runnerInventories = await Promise.all(machines.map((machine) => loadRunnerInventory(options.engine!, machine)))
    candidates.push(...runnerInventories.map((inventory) => ({
        target: inventory.target,
        plugins: inventory.plugins
    })))
    return candidates
}

export async function createInstallPlan(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    request: PluginInstallPlanRequest
    planId: string
    now: number
    expiresAt?: number
}): Promise<PluginInstallPlanResponse> {
    const inspection = await inspectPluginPackagePayload(options.request)
    const candidates = await buildInstallTargetCandidates({
        manager: options.manager,
        engine: options.engine,
        namespace: options.namespace
    })
    return PluginInstallPlanResponseSchema.parse(buildPluginInstallPlan({
        planId: options.planId,
        now: options.now,
        expiresAt: options.expiresAt,
        manifest: inspection.manifest,
        request: options.request,
        packageFormat: inspection.packageFormat,
        candidates
    }))
}

export function installActionFromPlan(action: 'install' | 'overwrite' | 'unchanged'): PluginInstallResult['action'] {
    if (action === 'install') return 'installed'
    if (action === 'overwrite') return 'overwritten'
    return 'unchanged'
}

export function isExecutablePlanAction(action: string): action is 'install' | 'overwrite' | 'unchanged' {
    return action === 'install' || action === 'overwrite' || action === 'unchanged'
}

export function packageRequestFromPlan(request: PluginInstallPlanRequest): PluginInstallPackageRequest {
    const { runnerSelection: _runnerSelection, dryRun: _dryRun, ...packageRequest } = request
    return packageRequest
}

export async function executeInstallPlan(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    request: PluginInstallPlanRequest
    plan: PluginInstallPlanResponse
}): Promise<PluginInstallResult> {
    const targetResults: NonNullable<PluginInstallResult['targetResults']> = []
    const plugins: PluginListItem[] = []
    const attempted: Array<{ ok: boolean; action?: PluginInstallResult['action'] }> = []
    const executableTargets = options.plan.targets.filter((target) =>
        target.compatible
        && isExecutablePlanAction(target.action))

    for (const target of options.plan.targets.filter((entry) => entry.action === 'skip')) {
        targetResults.push({
            target: target.target,
            ok: false,
            error: target.reason ?? 'Target skipped by install plan.',
            pluginId: options.plan.plugin.id,
            diagnostics: [],
            plugins: target.runtime === 'hub'
                ? options.manager.listPlugins().map((plugin) => withTarget(plugin, target.target))
                : []
        })
    }

    for (const target of executableTargets) {
        if (target.runtime === 'hub') {
            try {
                if (target.action === 'unchanged') {
                    const reload = options.request.enable === true
                        ? await options.manager.enablePlugin(options.plan.plugin.id, undefined, options.request.reload !== false)
                        : undefined
                    const latestPlugins = options.manager.listPlugins().map((plugin) => withTarget(plugin, hubTargetSummary()))
                    plugins.push(...latestPlugins)
                    targetResults.push({
                        target: target.target,
                        ok: reload?.ok ?? true,
                        action: 'unchanged',
                        pluginId: options.plan.plugin.id,
                        diagnostics: [],
                        plugins: latestPlugins
                    })
                    attempted.push({ ok: reload?.ok ?? true, action: 'unchanged' })
                    continue
                }
                const result = await options.manager.installPluginPackage({
                    ...packageRequestFromPlan(options.request),
                    overwrite: target.action === 'overwrite' || options.request.overwrite === true
                })
                const targetSummary = hubTargetSummary()
                const latestPlugins = result.plugins.map((plugin) => withTarget(plugin, targetSummary))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: targetSummary,
                    ok: result.ok,
                    action: result.action,
                    pluginId: result.pluginId,
                    targetPath: result.targetPath,
                    diagnostics: result.diagnostics,
                    plugins: latestPlugins
                })
                attempted.push({ ok: result.ok, action: result.action })
            } catch (error) {
                const latestPlugins = options.manager.listPlugins().map((plugin) => withTarget(plugin, hubTargetSummary()))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: target.target,
                    ok: false,
                    error: errorMessage(error),
                    pluginId: options.plan.plugin.id,
                    diagnostics: [],
                    plugins: latestPlugins
                })
                attempted.push({ ok: false })
            }
            continue
        }

        const machineId = target.target.machineId
        if (!machineId || !options.engine) {
            targetResults.push({
                target: target.target,
                ok: false,
                error: 'Runner target is not available.',
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: []
            })
            attempted.push({ ok: false })
            continue
        }
        const machine = options.engine.getMachineByNamespace(machineId, options.namespace)
        if (!machine) {
            targetResults.push({
                target: target.target,
                ok: false,
                error: 'Runner target was not found.',
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: []
            })
            attempted.push({ ok: false })
            continue
        }
        try {
            if (target.action === 'unchanged') {
                const reload = options.request.enable === true
                    ? await options.engine.enableRunnerPlugin(machineId, options.plan.plugin.id, undefined, options.request.reload !== false)
                    : undefined
                const inventory = await loadRunnerInventory(options.engine, machine)
                const latestPlugins = inventory.plugins.map((plugin) => withTarget(plugin, inventory.target))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: inventory.target,
                    ok: reload?.ok ?? true,
                    action: 'unchanged',
                    pluginId: options.plan.plugin.id,
                    diagnostics: [],
                    plugins: latestPlugins
                })
                attempted.push({ ok: reload?.ok ?? true, action: 'unchanged' })
                continue
            }
            const result = await options.engine.installRunnerPluginPackage(machineId, {
                ...packageRequestFromPlan(options.request),
                overwrite: target.action === 'overwrite' || options.request.overwrite === true
            })
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            const latestPlugins = result.plugins.map((plugin) => withTarget(plugin, targetSummary))
            plugins.push(...latestPlugins)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                action: result.action,
                pluginId: result.pluginId,
                targetPath: result.targetPath,
                diagnostics: result.diagnostics,
                plugins: latestPlugins
            })
            attempted.push({ ok: result.ok, action: result.action })
        } catch (error) {
            const cached = cachedRunnerInventory(machine, errorMessage(error))
            plugins.push(...cached.plugins)
            targetResults.push({
                target: cached.target,
                ok: false,
                error: errorMessage(error),
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: cached.plugins
            })
            attempted.push({ ok: false })
        }
    }

    const firstExecutableAction = executableTargets.find((target) => isExecutablePlanAction(target.action))?.action

    return PluginInstallResultSchema.parse({
        ok: attempted.every((entry) => entry.ok),
        action: attempted.find((entry) => entry.action)?.action ?? (firstExecutableAction && isExecutablePlanAction(firstExecutableAction) ? installActionFromPlan(firstExecutableAction) : 'unchanged'),
        pluginId: options.plan.plugin.id,
        targetResults,
        diagnostics: [],
        plugins
    })
}
