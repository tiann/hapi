import {
    parseRunnerPluginTargetScope,
    PluginCapabilitiesResponseSchema,
    type PluginCapabilitiesResponse,
    type PluginTargetScope
} from '@hapi/protocol/plugins/admin'
import { mergeCapabilityViews } from '@hapi/protocol/plugins/runtime/capabilityView'
import type { HubPluginManager } from '../pluginManager'
import type { SyncEngine } from '../../sync/syncEngine'
import { loadRunnerInventory } from './inventoryService'

export type PluginCapabilityServiceResult =
    | { payload: PluginCapabilitiesResponse }
    | { error: string; status: 404 }

export async function buildCapabilitiesPayload(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    target: PluginTargetScope | null
    sessionId?: string | null
}): Promise<PluginCapabilityServiceResult> {
    const { manager, engine, namespace, target, sessionId } = options

    if (target === 'hub') {
        return { payload: parseCapabilities(manager.collectCapabilities()) }
    }

    const runnerMachineId = target ? parseRunnerPluginTargetScope(target) : null
    if (runnerMachineId) {
        if (!engine) {
            return { payload: parseCapabilities([]) }
        }
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) {
            return { error: 'Runner target not found', status: 404 }
        }
        const inventory = await loadRunnerInventory(engine, machine)
        return { payload: parseCapabilities(inventory.capabilities ?? []) }
    }

    if (sessionId && !target) {
        if (!engine) {
            return { payload: parseCapabilities([]) }
        }
        const session = engine.getSessionByNamespace(sessionId, namespace)
        if (!session) {
            return { error: 'Session not found', status: 404 }
        }
        const capabilities = [...manager.collectCapabilities()]
        const sessionMachineId = typeof session.metadata?.machineId === 'string' ? session.metadata.machineId : null
        if (sessionMachineId) {
            const machine = engine.getMachineByNamespace(sessionMachineId, namespace)
            if (machine) {
                const inventory = await loadRunnerInventory(engine, machine)
                capabilities.push(...(inventory.capabilities ?? []))
            }
        }
        return { payload: parseCapabilities(mergeCapabilityViews(capabilities)) }
    }

    const capabilities = target === 'all-runners' ? [] : [...manager.collectCapabilities()]
    if (engine && (!target || target === 'all-runners')) {
        const machines = engine.getMachinesByNamespace(namespace)
        const inventories = await Promise.all(machines.map((machine) => loadRunnerInventory(engine, machine)))
        capabilities.push(...inventories.flatMap((inventory) => inventory.capabilities ?? []))
    }
    return { payload: parseCapabilities(mergeCapabilityViews(capabilities)) }
}

function parseCapabilities(capabilities: PluginCapabilitiesResponse['capabilities']): PluginCapabilitiesResponse {
    return PluginCapabilitiesResponseSchema.parse({ capabilities })
}
