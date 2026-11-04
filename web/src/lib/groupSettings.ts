import { getPathDisplayName } from '@/utils/path'

/**
 * Client-side display preferences for directory groups in the session list.
 *
 * Groups are derived on the client from session metadata (machine + working
 * directory); the hub has no group entity to store preferences against. So
 * pin/rename state lives in localStorage next to the other per-browser
 * session-list state (`hapi.sessionLastSeen.v1`), keyed by the same group key
 * the list uses for collapse state (`${machineId}::${directory}`).
 */
export type GroupSettingsEntry = {
    pinned?: boolean
    name?: string
}

export type GroupSettings = Record<string, GroupSettingsEntry>

export const GROUP_SETTINGS_STORAGE_KEY = 'hapi.groupSettings.v1'

export function loadGroupSettings(): GroupSettings {
    let raw: string | null = null
    try {
        raw = localStorage.getItem(GROUP_SETTINGS_STORAGE_KEY)
    } catch {
        return {}
    }
    if (!raw) return {}
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const result: GroupSettings = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue
            const source = value as { pinned?: unknown; name?: unknown }
            const entry: GroupSettingsEntry = {}
            if (source.pinned === true) entry.pinned = true
            if (typeof source.name === 'string' && source.name.trim()) entry.name = source.name.trim()
            if (entry.pinned !== undefined || entry.name !== undefined) result[key] = entry
        }
        return result
    } catch {
        return {}
    }
}

export function saveGroupSettings(settings: GroupSettings): void {
    try {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
        // Storage unavailable (private mode / quota) — preferences stay in memory.
    }
}

export function isGroupPinned(settings: GroupSettings, key: string): boolean {
    return settings[key]?.pinned === true
}

export function getGroupCustomName(settings: GroupSettings, key: string): string | null {
    return settings[key]?.name ?? null
}

export function resolveGroupDisplayName(settings: GroupSettings, key: string, directory: string): string {
    return getGroupCustomName(settings, key) ?? getPathDisplayName(directory)
}

/**
 * Override each group's display name with the stored custom name, if any.
 * Pure so it composes with the existing grouping/sorting pipeline in tests.
 */
export function applyGroupDisplayNames<T extends { key: string; displayName: string }>(
    groups: T[],
    settings: GroupSettings
): T[] {
    return groups.map(group => {
        const name = getGroupCustomName(settings, group.key)
        if (!name || name === group.displayName) return group
        return { ...group, displayName: name }
    })
}

/**
 * Stable re-sort that floats user-pinned groups to the top while preserving
 * the existing relative order (pinned sessions, active sessions, recency).
 */
export function sortPinnedGroupsFirst<T extends { key: string }>(
    groups: T[],
    settings: GroupSettings
): T[] {
    return groups.slice().sort((a, b) => {
        const rankA = isGroupPinned(settings, a.key) ? 0 : 1
        const rankB = isGroupPinned(settings, b.key) ? 0 : 1
        return rankA - rankB
    })
}
