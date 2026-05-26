import type { DiscoveredPluginRecord } from '../foundation'
import type { PluginCapabilityPart } from '../manifest'
import type { PluginCapabilityPartStatus, PluginCapabilityView, PluginTargetSummary } from '../admin'

const WEB_CONTRIBUTION_GROUPS = {
    settingsPanel: 'settingsPanels',
    newSessionField: 'newSessionFields',
    action: 'actions',
    badge: 'badges',
    composerAction: 'composerActions'
} as const

type WebContributionType = keyof typeof WEB_CONTRIBUTION_GROUPS
type WebContributionGroup = typeof WEB_CONTRIBUTION_GROUPS[WebContributionType]

export function aggregateCapabilityStatus(parts: {
    web?: PluginCapabilityPartStatus
    hub?: PluginCapabilityPartStatus
    runner?: PluginCapabilityPartStatus
}): PluginCapabilityView['status'] {
    const required = Object.values(parts).filter((part): part is PluginCapabilityPartStatus => Boolean(part) && part.required !== false)
    if (required.length === 0) {
        return 'ready'
    }
    const priority: PluginCapabilityView['status'][] = [
        'disabled',
        'failed',
        'incompatible',
        'offline',
        'missing-target',
        'partial'
    ]
    for (const status of priority) {
        if (required.some((part) => part.status === status)) {
            return status
        }
    }
    return required.every((part) => part.status === 'ready') ? 'ready' : 'partial'
}

export function webContributionsForPart(
    record: DiscoveredPluginRecord,
    part: PluginCapabilityPart
): NonNullable<PluginCapabilityView['web']> | undefined {
    const web = record.manifest?.contributions?.web
    if (!web) {
        return undefined
    }

    const result: NonNullable<PluginCapabilityView['web']> = {}
    for (const contribution of part.contributions) {
        const group = webContributionGroup(contribution.type)
        if (!group) {
            continue
        }
        const match = web[group]?.find((entry) => entry.id === contribution.id)
        if (match) {
            const resultRecord = result as Record<WebContributionGroup, unknown[] | undefined>
            resultRecord[group] = [...(resultRecord[group] ?? []), match]
        }
    }

    return Object.keys(result).length > 0 ? result : undefined
}

export function webPartStatus(record: DiscoveredPluginRecord, part: PluginCapabilityPart): PluginCapabilityPartStatus {
    const declaredIds = new Set(part.contributions.map((entry) => `${entry.type}:${entry.id}`))
    const registeredIds = new Set<string>()
    const web = record.manifest?.contributions?.web
    for (const contribution of part.contributions) {
        const type = contribution.type
        const id = contribution.id
        const group = webContributionGroup(type)
        const exists = group ? Boolean(web?.[group]?.some((entry) => entry.id === id)) : false
        if (exists) {
            registeredIds.add(`${type}:${id}`)
        }
    }
    return {
        status: record.enabled !== true
            ? 'disabled'
            : Array.from(declaredIds).every((id) => registeredIds.has(id))
                ? 'ready'
                : 'partial',
        required: part.required,
        declared: true,
        registered: registeredIds.size === declaredIds.size,
        active: record.enabled === true,
        diagnostics: []
    }
}

function webContributionGroup(type: string): WebContributionGroup | null {
    return Object.prototype.hasOwnProperty.call(WEB_CONTRIBUTION_GROUPS, type)
        ? WEB_CONTRIBUTION_GROUPS[type as WebContributionType]
        : null
}

export function betterCapabilityPart(left: PluginCapabilityPartStatus | undefined, right: PluginCapabilityPartStatus | undefined): PluginCapabilityPartStatus | undefined {
    if (!left) return right
    if (!right) return left
    if (left.status === 'missing-target' && right.status !== 'missing-target') return right
    if (left.status !== 'ready' && right.status === 'ready') return right
    if (left.active !== true && right.active === true) return right
    return left
}

export function mergeWebContributions(left: PluginCapabilityView['web'], right: PluginCapabilityView['web']): PluginCapabilityView['web'] {
    if (!left) return right
    if (!right) return left
    return {
        ...(left.settingsPanels || right.settingsPanels ? { settingsPanels: [...(left.settingsPanels ?? []), ...(right.settingsPanels ?? [])] } : {}),
        ...(left.newSessionFields || right.newSessionFields ? { newSessionFields: [...(left.newSessionFields ?? []), ...(right.newSessionFields ?? [])] } : {}),
        ...(left.actions || right.actions ? { actions: [...(left.actions ?? []), ...(right.actions ?? [])] } : {}),
        ...(left.badges || right.badges ? { badges: [...(left.badges ?? []), ...(right.badges ?? [])] } : {}),
        ...(left.composerActions || right.composerActions ? { composerActions: [...(left.composerActions ?? []), ...(right.composerActions ?? [])] } : {})
    }
}

export function mergeCapabilityViews(views: PluginCapabilityView[]): PluginCapabilityView[] {
    const byKey = new Map<string, PluginCapabilityView>()
    for (const view of views) {
        const key = `${view.pluginId}:${view.capabilityId}`
        const existing = byKey.get(key)
        if (!existing) {
            byKey.set(key, view)
            continue
        }
        const parts = {
            web: betterCapabilityPart(existing.parts.web, view.parts.web),
            hub: betterCapabilityPart(existing.parts.hub, view.parts.hub),
            runner: betterCapabilityPart(existing.parts.runner, view.parts.runner)
        }
        byKey.set(key, {
            ...existing,
            pluginName: existing.pluginName ?? view.pluginName,
            pluginVersion: existing.pluginVersion ?? view.pluginVersion,
            displayName: existing.displayName ?? view.displayName,
            description: existing.description ?? view.description,
            status: aggregateCapabilityStatus(parts),
            target: undefined,
            parts,
            web: mergeWebContributions(existing.web, view.web),
            diagnostics: [...existing.diagnostics, ...view.diagnostics]
        })
    }
    return Array.from(byKey.values())
}

export function withCapabilityTarget(capability: PluginCapabilityView, target: PluginTargetSummary): PluginCapabilityView {
    const runnerPart = capability.parts.runner
    const nextRunnerPart = runnerPart
        ? {
            ...runnerPart,
            target,
            ...(target.runtime === 'runner' && (!target.active || target.error) ? {
                status: 'offline' as const,
                active: false
            } : {})
        }
        : undefined
    const parts = {
        ...capability.parts,
        ...(nextRunnerPart ? { runner: nextRunnerPart } : {})
    }
    return {
        ...capability,
        target,
        parts,
        status: aggregateCapabilityStatus(parts)
    }
}
