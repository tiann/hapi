import type { PluginListItem } from '@hapi/protocol/plugins/admin'
import type { PluginMarketplaceEntry, PluginMarketplaceEntryView } from '@hapi/protocol/plugins/marketplace'
import {
    installedPluginVersions,
    isPluginVersionGreater,
    latestCompatibleMarketplaceRelease,
    type PluginMarketplaceHostContext
} from '@hapi/protocol/plugins/runtime/versioning'

export function marketplaceEntryMatches(entry: PluginMarketplaceEntry, filters: {
    query?: string
    category?: string
    runtime?: string
}): boolean {
    if (filters.category && !(entry.categories ?? []).some((category) => category === filters.category)) {
        return false
    }
    if (filters.runtime && !(entry.runtimes ?? []).some((runtime) => runtime === filters.runtime)) {
        return false
    }
    if (!filters.query) {
        return true
    }
    const query = filters.query.toLowerCase()
    const haystack = [
        entry.id,
        entry.name,
        entry.description ?? '',
        entry.repo,
        ...(entry.keywords ?? [])
    ].join('\n').toLowerCase()
    return haystack.includes(query)
}

export function latestMarketplaceVersion(entry: PluginMarketplaceEntry, hostContext?: PluginMarketplaceHostContext): string | undefined {
    return latestCompatibleMarketplaceRelease(entry, hostContext)?.version
}

export function marketplaceEntriesWithInstallState(entries: PluginMarketplaceEntry[], plugins: PluginListItem[], hostContext?: PluginMarketplaceHostContext): PluginMarketplaceEntryView[] {
    const installedById = new Map<string, PluginListItem[]>()
    for (const plugin of plugins) {
        const existing = installedById.get(plugin.id) ?? []
        existing.push(plugin)
        installedById.set(plugin.id, existing)
    }
    return entries.map((entry) => {
        const installedPlugins = installedById.get(entry.id) ?? []
        const latestVersion = latestMarketplaceVersion(entry, hostContext)
        if (installedPlugins.length === 0) {
            return {
                ...entry,
                ...(latestVersion ? { latestCompatibleVersion: latestVersion } : {})
            }
        }
        const installedVersions = installedPluginVersions(installedPlugins, entry.id)
        const updateVersion = installedVersions.some((version) => Boolean(latestVersion && isPluginVersionGreater(latestVersion, version)))
            ? latestVersion
            : undefined
        return {
            ...entry,
            ...(latestVersion ? { latestCompatibleVersion: latestVersion } : {}),
            installed: {
                ...(installedVersions.length > 0 ? { version: installedVersions.join(' + ') } : {}),
                enabled: installedPlugins.some((plugin) => plugin.enabled),
                yanked: installedVersions.some((version) => entry.releases.find((candidate) => candidate.version === version)?.yanked !== undefined),
                updateAvailable: Boolean(updateVersion),
                ...(updateVersion ? { updateVersion } : {})
            }
        }
    })
}
