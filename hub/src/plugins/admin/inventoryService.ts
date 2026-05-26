import {
    parseRunnerPluginTargetScope,
    PluginListResponseSchema,
    type PluginDetail,
    type PluginListItem,
    type PluginTargetInventory,
    type PluginTargetScope,
    type RunnerPluginInventory
} from '@hapi/protocol/plugins/admin'
import { withCapabilityTarget } from '@hapi/protocol/plugins/runtime/capabilityView'
import type { HubPluginManager } from '../pluginManager'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { errorMessage } from './errors'
import { hubTargetSummary, runnerTargetSummary, withTarget } from './target'

export function hubInventory(manager: HubPluginManager): PluginTargetInventory {
    const target = hubTargetSummary()
    return {
        target,
        plugins: manager.listPlugins().map((plugin) => withTarget(plugin, target)),
        webContributions: typeof manager.collectWebContributions === 'function'
            ? manager.collectWebContributions()
            : [],
        contributionStates: typeof manager.collectContributionStates === 'function'
            ? manager.collectContributionStates()
            : [],
        capabilities: typeof manager.collectCapabilities === 'function'
            ? manager.collectCapabilities()
            : []
    }
}

export function cachedRunnerInventory(machine: Machine, error?: string): PluginTargetInventory {
    const inventory = machine.runnerState?.pluginInventory
    const target = runnerTargetSummary(machine, inventory, error ?? (inventory ? undefined : 'No Runner plugin inventory has been reported yet.'))
    return {
        target,
        plugins: (inventory?.plugins ?? []).map((plugin) => withTarget(plugin, target)),
        ...(inventory?.webContributions ? { webContributions: inventory.webContributions } : {}),
        ...(inventory?.contributionStates ? { contributionStates: inventory.contributionStates } : {}),
        ...(inventory?.capabilities ? { capabilities: inventory.capabilities.map((capability) => withCapabilityTarget(capability, target)) } : {}),
        ...(target.error ? { error: target.error } : {})
    }
}

export function freshRunnerInventory(machine: Machine, inventory: RunnerPluginInventory): PluginTargetInventory {
    const target = runnerTargetSummary(machine, inventory)
    return {
        target,
        plugins: inventory.plugins.map((plugin) => withTarget(plugin, target)),
        webContributions: inventory.webContributions,
        contributionStates: inventory.contributionStates,
        capabilities: inventory.capabilities?.map((capability) => withCapabilityTarget(capability, target))
    }
}

export async function loadRunnerInventory(engine: SyncEngine, machine: Machine): Promise<PluginTargetInventory> {
    if (!machine.active) {
        return cachedRunnerInventory(machine, 'Runner is offline; showing stale cached plugin inventory.')
    }
    try {
        return freshRunnerInventory(machine, await engine.listRunnerPlugins(machine.id))
    } catch (error) {
        return cachedRunnerInventory(machine, `Runner plugin RPC failed: ${errorMessage(error)}`)
    }
}

export async function buildListPayload(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    target: PluginTargetScope | null
}): Promise<{ payload?: unknown }> {
    const { manager, engine, namespace, target } = options
    if (target === 'hub') {
        const inventory = hubInventory(manager)
        return { payload: PluginListResponseSchema.parse({ plugins: inventory.plugins, targets: [inventory] }) }
    }

    const runnerMachineId = target ? parseRunnerPluginTargetScope(target) : null
    if (runnerMachineId) {
        if (!engine) {
            return { payload: PluginListResponseSchema.parse({ plugins: [], targets: [] }) }
        }
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) {
            return { payload: { error: 'Runner target not found' } }
        }
        const inventory = await loadRunnerInventory(engine, machine)
        return { payload: PluginListResponseSchema.parse({ plugins: inventory.plugins, targets: [inventory] }) }
    }

    const targets: PluginTargetInventory[] = []
    if (!target) {
        targets.push(hubInventory(manager))
    }

    if (engine) {
        const machines = engine.getMachinesByNamespace(namespace)
        const runnerInventories = await Promise.all(machines.map((machine) => loadRunnerInventory(engine, machine)))
        targets.push(...runnerInventories)
    }

    const plugins = targets.flatMap((entry) => entry.plugins)
    return { payload: PluginListResponseSchema.parse({ plugins, targets }) }
}

export function fallbackDetailFromListItem(item: PluginListItem): PluginDetail {
    return {
        ...item,
        permissions: { network: [], secrets: [] },
        contributions: { notificationChannels: [] },
        runtimeEntryPaths: []
    }
}

export async function getRunnerDetail(engine: SyncEngine, namespace: string, target: PluginTargetScope, pluginId: string): Promise<PluginDetail | Response> {
    const machineId = parseRunnerPluginTargetScope(target)
    if (!machineId) throw new Error('Runner target expected')
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (!machine) {
        return new Response(JSON.stringify({ error: 'Runner target not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    if (machine.active) {
        try {
            return (await engine.inspectRunnerPlugin(machine.id, pluginId)).plugin
        } catch {
            // fall through to stale cache if possible
        }
    }
    const inventory = cachedRunnerInventory(machine, machine.active ? 'Runner plugin RPC failed; showing cached detail.' : 'Runner is offline; showing stale cached plugin detail.')
    const item = inventory.plugins.find((plugin) => plugin.id === pluginId)
    if (!item) {
        return new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return fallbackDetailFromListItem(item)
}
