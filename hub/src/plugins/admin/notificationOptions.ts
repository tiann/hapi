import { PluginNotificationFilterOptionsResponseSchema, type PluginNotificationFilterOption } from '@hapi/protocol/plugins/admin'
import { getAgentName } from '../../notifications/sessionInfo'
import type { Session, SyncEngine } from '../../sync/syncEngine'

type NotificationFilterOptionDraft = {
    value: string
    count: number
    lastSeenAt: number
}

function sessionLastSeenAt(session: Session): number {
    return Math.max(session.updatedAt ?? 0, session.activeAt ?? 0, session.createdAt ?? 0)
}

function addNotificationFilterOption(map: Map<string, NotificationFilterOptionDraft>, rawValue: unknown, lastSeenAt: number): void {
    if (typeof rawValue !== 'string') return
    const value = rawValue.trim()
    if (!value) return
    const existing = map.get(value)
    if (!existing) {
        map.set(value, { value, count: 1, lastSeenAt })
        return
    }
    existing.count += 1
    existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt)
}

function ensureNotificationFilterOption(map: Map<string, NotificationFilterOptionDraft>, rawValue: unknown, lastSeenAt: number): void {
    if (typeof rawValue !== 'string') return
    const value = rawValue.trim()
    if (!value || map.has(value)) return
    map.set(value, { value, count: 0, lastSeenAt })
}

function notificationFilterOptions(map: Map<string, NotificationFilterOptionDraft>): PluginNotificationFilterOption[] {
    return Array.from(map.values())
        .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt || left.value.localeCompare(right.value))
        .slice(0, 100)
        .map((entry) => ({
            value: entry.value,
            label: entry.value,
            ...(entry.count > 0 ? { count: entry.count } : {}),
            ...(entry.lastSeenAt > 0 ? { lastSeenAt: entry.lastSeenAt } : {})
        }))
}

export function buildNotificationFilterOptions(engine: SyncEngine | null, namespace: string) {
    const namespaces = new Map<string, NotificationFilterOptionDraft>()
    const agents = new Map<string, NotificationFilterOptionDraft>()
    const workspaces = new Map<string, NotificationFilterOptionDraft>()

    const sessions = engine?.getSessionsByNamespace(namespace) ?? []
    if (sessions.length === 0) {
        ensureNotificationFilterOption(namespaces, namespace, Date.now())
    }

    for (const session of sessions) {
        const lastSeenAt = sessionLastSeenAt(session)
        addNotificationFilterOption(namespaces, session.namespace || namespace, lastSeenAt)
        addNotificationFilterOption(agents, getAgentName(session), lastSeenAt)
        addNotificationFilterOption(workspaces, session.metadata?.path, lastSeenAt)
    }

    if (!namespaces.has(namespace)) {
        ensureNotificationFilterOption(namespaces, namespace, Date.now())
    }

    return PluginNotificationFilterOptionsResponseSchema.parse({
        namespaces: notificationFilterOptions(namespaces),
        agents: notificationFilterOptions(agents),
        workspaces: notificationFilterOptions(workspaces)
    })
}
