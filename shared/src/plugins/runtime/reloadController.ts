import type { PluginReloadItem } from '../admin'
import type { DiscoveredPluginRecord } from '../foundation'
import type { PluginRuntimeName } from '../manifest'
import { diagnosticView } from './diagnostics'

export type RuntimeReloadActiveInstance = {
    record: DiscoveredPluginRecord
    signature: string
}

export type RuntimeActivationResult<TInstance extends RuntimeReloadActiveInstance> =
    | {
        ok: true
        instance: TInstance
    }
    | {
        ok: false
        message: string
        diagnostics: PluginReloadItem['diagnostics']
    }

export async function performRuntimeReload<TInstance extends RuntimeReloadActiveInstance>(options: {
    records: DiscoveredPluginRecord[]
    activePlugins: Map<string, TInstance>
    targetId?: string
    runtime: Extract<PluginRuntimeName, 'hub' | 'runner'>
    runtimeDisplayName: 'Hub' | 'Runner'
    pluginDisplayId(record: DiscoveredPluginRecord): string
    computeSignature(record: DiscoveredPluginRecord): Promise<string>
    activateRecord(record: DiscoveredPluginRecord, signature: string): Promise<RuntimeActivationResult<TInstance>>
    disposeActive(pluginId: string): Promise<void>
    disposeInstance(instance: TInstance): Promise<void>
    shouldDiscardActivatedInstance?(instance: TInstance): boolean
    discardedActivationMessage?: string
}): Promise<PluginReloadItem[]> {
    const items: PluginReloadItem[] = []
    const recordByPluginId = new Map<string, DiscoveredPluginRecord>()
    for (const record of options.records) {
        if (record.manifest) {
            recordByPluginId.set(record.manifest.id, record)
        }
    }

    const seenIds = new Set(recordByPluginId.keys())
    for (const [pluginId, instance] of Array.from(options.activePlugins.entries())) {
        if (options.targetId && pluginId !== options.targetId) {
            continue
        }
        if (!seenIds.has(pluginId)) {
            await options.disposeActive(pluginId)
            items.push({
                id: pluginId,
                action: 'deactivated',
                status: 'disabled',
                message: 'Plugin is no longer discovered.',
                diagnostics: []
            })
        } else if (!isEnabledRuntimeRecord(recordByPluginId.get(pluginId), pluginId, options.runtime)) {
            await options.disposeActive(pluginId)
            items.push({
                id: pluginId,
                action: 'deactivated',
                status: 'disabled',
                message: `Plugin is no longer enabled for the ${options.runtimeDisplayName} runtime.`,
                diagnostics: []
            })
        } else {
            instance.record = recordByPluginId.get(pluginId) ?? instance.record
        }
    }

    for (const record of options.records) {
        const id = options.pluginDisplayId(record)
        if (options.targetId && id !== options.targetId && record.manifest?.id !== options.targetId) {
            continue
        }

        if (!isEnabledRuntimeRecord(record, record.manifest?.id, options.runtime)) {
            if (!items.some((item) => item.id === id)) {
                items.push({
                    id,
                    action: 'unchanged',
                    status: record.status,
                    diagnostics: record.diagnostics.map((entry) => diagnosticView(id, entry))
                })
            }
            continue
        }

        const pluginId = record.manifest!.id
        const signature = await options.computeSignature(record)
        const existing = options.activePlugins.get(pluginId)
        if (existing && existing.signature === signature) {
            record.status = 'active'
            existing.record = record
            items.push({ id: pluginId, action: 'unchanged', status: 'active', diagnostics: [] })
            continue
        }

        const activation = await options.activateRecord(record, signature)
        if (activation.ok) {
            if (options.shouldDiscardActivatedInstance?.(activation.instance)) {
                await options.disposeInstance(activation.instance)
                items.push({
                    id: pluginId,
                    action: 'deactivated',
                    status: 'disabled',
                    message: options.discardedActivationMessage ?? 'Plugin manager disposed during activation.',
                    diagnostics: []
                })
                continue
            }
            const action = existing ? 'reloaded' : 'activated'
            options.activePlugins.set(pluginId, activation.instance)
            record.status = 'active'
            if (existing) {
                await options.disposeInstance(existing)
            }
            items.push({ id: pluginId, action, status: 'active', diagnostics: [] })
            continue
        }

        record.diagnostics.push(...activation.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            ...(diagnostic.path ? { path: diagnostic.path } : {})
        })))
        if (existing) {
            record.status = 'reload-failed'
            existing.record = record
            items.push({
                id: pluginId,
                action: 'kept-previous',
                status: 'reload-failed',
                message: activation.message,
                diagnostics: activation.diagnostics
            })
        } else {
            record.status = 'failed'
            items.push({
                id: pluginId,
                action: 'failed',
                status: 'failed',
                message: activation.message,
                diagnostics: activation.diagnostics
            })
        }
    }

    return items
}

function isEnabledRuntimeRecord(
    record: DiscoveredPluginRecord | undefined,
    pluginId: string | undefined,
    runtime: Extract<PluginRuntimeName, 'hub' | 'runner'>
): boolean {
    return Boolean(
        pluginId
        && record?.manifest?.id === pluginId
        && record.status === 'enabled'
        && record.manifest.runtimes?.[runtime]
    )
}
