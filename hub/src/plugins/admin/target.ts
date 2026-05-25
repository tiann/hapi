import {
    PluginHostInfoSchema,
    type PluginHostInfo,
    type PluginListItem,
    type PluginTargetSummary,
    type RunnerPluginInventory
} from '@hapi/protocol/plugins/admin'
import { HAPI_PLUGIN_API_VERSION, HAPI_SUPPORTED_PLUGIN_API_VERSIONS } from '@hapi/protocol/plugins'
import { HUB_IMPLEMENTED_EXTENSION_POINTS } from '@hapi/protocol/plugins/extensionPoints'
import type { Machine } from '../../sync/syncEngine'
import packageJson from '../../../../cli/package.json'

export function hubHostInfo(): PluginHostInfo {
    return PluginHostInfoSchema.parse({
        runtime: 'hub',
        hapiVersion: packageJson.version,
        pluginApiVersion: HAPI_PLUGIN_API_VERSION,
        supportedPluginApiVersions: [...HAPI_SUPPORTED_PLUGIN_API_VERSIONS],
        os: process.platform,
        arch: process.arch,
        supportedExtensionPoints: [...HUB_IMPLEMENTED_EXTENSION_POINTS]
    })
}

export function hubTargetSummary(): PluginTargetSummary {
    return {
        scope: 'hub',
        runtime: 'hub',
        active: true,
        stale: false,
        displayName: 'Hub',
        updatedAt: Date.now(),
        hostInfo: hubHostInfo()
    }
}

export function machineDisplayName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id
}

export function runnerTargetSummary(machine: Machine, inventory?: RunnerPluginInventory, error?: string): PluginTargetSummary {
    return {
        scope: `runner:${machine.id}`,
        runtime: 'runner',
        machineId: machine.id,
        displayName: machineDisplayName(machine),
        active: machine.active,
        stale: !machine.active || Boolean(error),
        ...(inventory?.updatedAt ? { updatedAt: inventory.updatedAt } : {}),
        ...(inventory?.hostInfo ? { hostInfo: inventory.hostInfo } : {}),
        ...(error ? { error } : {})
    }
}

export function withTarget(plugin: PluginListItem, target: PluginTargetSummary): PluginListItem {
    if (target.runtime !== 'runner' || target.active) {
        return { ...plugin, target }
    }
    return {
        ...plugin,
        target,
        active: false,
        runtimes: {
            ...plugin.runtimes,
            ...(plugin.runtimes.runner ? { runner: { ...plugin.runtimes.runner, active: false } } : {})
        }
    }
}
