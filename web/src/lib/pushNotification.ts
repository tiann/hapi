export type PushPayload = {
    title: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: {
        type?: string
        sessionId?: string
        url?: string
        unreadCount?: number
        totalUnreadCount?: number
    }
}

export type PushNotificationOptions = NotificationOptions & {
    renotify?: boolean
}

export type PushWindowClientLike = {
    visibilityState?: string
    focused?: boolean
}

export type PushClientsLike = {
    matchAll: (options: { type: 'window'; includeUncontrolled: boolean }) => Promise<readonly PushWindowClientLike[]>
}

export function buildNotificationOptions(payload: PushPayload): PushNotificationOptions {
    const icon = payload.icon ?? '/pwa-192x192.png'
    const badge = payload.badge ?? '/pwa-64x64.png'
    const data = payload.data
    const tag = payload.tag

    return {
        body: payload.body ?? '',
        icon,
        badge,
        data,
        tag,
        renotify: Boolean(tag)
    }
}

export async function shouldShowPushNotification(clientsApi: PushClientsLike): Promise<boolean> {
    try {
        const windowClients = await clientsApi.matchAll({
            type: 'window',
            includeUncontrolled: true
        })

        return !windowClients.some((client) => client.focused === true)
    } catch {
        return true
    }
}
