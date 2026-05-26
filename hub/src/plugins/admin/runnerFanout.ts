import {
    parseRunnerPluginTargetScope,
    PluginDeleteResultSchema,
    PluginInstallResultSchema,
    PluginReloadResultSchema,
    type PluginDeleteResult,
    type PluginInstallResult,
    type PluginListItem,
    type PluginReloadResult,
    type PluginTargetActionResult,
    type PluginTargetScope
} from '@hapi/protocol/plugins/admin'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { errorMessage } from './errors'
import { cachedRunnerInventory } from './inventoryService'
import { runnerTargetSummary, withTarget } from './target'

function jsonErrorResponse(error: string, status: number): Response {
    return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
}

function runnerNotFoundResponse(): Response {
    return jsonErrorResponse('Runner target not found', 404)
}

function runnerOfflineResponse(): Response {
    return jsonErrorResponse('Runner target is offline', 503)
}

function appendPluginsWithTarget(list: PluginListItem[], plugins: PluginListItem[], target = plugins[0]?.target): void {
    if (!target) {
        list.push(...plugins)
        return
    }
    list.push(...plugins.map((plugin) => withTarget(plugin, target)))
}

export async function runRunnerReloadAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    action: (machineId: string) => Promise<PluginReloadResult>
}): Promise<PluginReloadResult | Response> {
    const { engine, namespace, target, action } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return runnerNotFoundResponse()
        if (!machine.active) return runnerOfflineResponse()
        return await action(machine.id)
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: PluginTargetActionResult[] = []
    const results: PluginReloadResult['results'] = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({ target: result.target ?? targetSummary, ok: result.ok, results: result.results, plugins: result.plugins })
            results.push(...result.results)
            appendPluginsWithTarget(plugins, result.plugins, result.target ?? targetSummary)
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginReloadResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        targetResults,
        results,
        plugins
    })
}

export async function runRunnerInstallAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    action: (machineId: string) => Promise<PluginInstallResult>
    preflight?: (machine: Machine) => string[]
}): Promise<PluginInstallResult | Response> {
    const { engine, namespace, target, action, preflight } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return runnerNotFoundResponse()
        if (!machine.active) return runnerOfflineResponse()
        const problems = preflight?.(machine) ?? []
        if (problems.length > 0) return jsonErrorResponse(problems.join(' '), 409)
        try {
            const result = await action(machine.id)
            return PluginInstallResultSchema.parse({ ...result, target: result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory) })
        } catch (error) {
            return jsonErrorResponse(errorMessage(error), 500)
        }
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: NonNullable<PluginInstallResult['targetResults']> = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', diagnostics: [], plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        const problems = preflight?.(machine) ?? []
        if (problems.length > 0) {
            targetResults.push({ target: cached.target, ok: false, error: problems.join(' '), diagnostics: [], plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                action: result.action,
                pluginId: result.pluginId,
                targetPath: result.targetPath,
                diagnostics: result.diagnostics,
                plugins: result.plugins
            })
            appendPluginsWithTarget(plugins, result.plugins, targetSummary)
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), diagnostics: [], plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginInstallResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        action: targetResults.find((entry) => entry.action)?.action ?? 'unchanged',
        targetResults,
        diagnostics: [],
        plugins
    })
}

export async function runRunnerDeleteAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    pluginId: string
    action: (machineId: string) => Promise<PluginDeleteResult>
}): Promise<PluginDeleteResult | Response> {
    const { engine, namespace, target, pluginId, action } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return runnerNotFoundResponse()
        if (!machine.active) return runnerOfflineResponse()
        const result = await action(machine.id)
        return PluginDeleteResultSchema.parse({ ...result, target: result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory) })
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: NonNullable<PluginDeleteResult['targetResults']> = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', pluginId, plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                pluginId: result.pluginId,
                rootPath: result.rootPath,
                deleted: result.deleted,
                plugins: result.plugins
            })
            appendPluginsWithTarget(plugins, result.plugins, targetSummary)
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), pluginId, plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginDeleteResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        pluginId,
        deleted: targetResults.length > 0 && targetResults.every((entry) => entry.ok && entry.deleted !== false),
        targetResults,
        plugins
    })
}
