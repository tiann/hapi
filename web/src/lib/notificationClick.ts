export const NOTIFICATION_CLICK_MESSAGE_TYPE = 'HAPI_NOTIFICATION_CLICK'
export const NOTIFICATION_CLICK_ACK_TYPE = 'HAPI_NOTIFICATION_CLICK_HANDLED'

export type NotificationClickMessage = {
    type: typeof NOTIFICATION_CLICK_MESSAGE_TYPE
    url: string
}

export type NotificationClickAck = {
    type: typeof NOTIFICATION_CLICK_ACK_TYPE
}

export function resolveNotificationTarget(rawUrl: string | undefined, appScope: string): string {
    const route = (rawUrl ?? '/').replace(/^\/+/, '')
    return new URL(route, appScope).toString()
}

export function getNotificationClickHref(message: unknown, origin: string): string | null {
    if (!message || typeof message !== 'object') {
        return null
    }

    const candidate = message as { type?: unknown; url?: unknown }
    if (candidate.type !== NOTIFICATION_CLICK_MESSAGE_TYPE || typeof candidate.url !== 'string') {
        return null
    }

    let targetUrl: URL
    try {
        targetUrl = new URL(candidate.url, origin)
    } catch {
        return null
    }
    if (targetUrl.origin !== origin) {
        return null
    }

    return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
}

export type NotificationClickClient = {
    url: string
    focused?: boolean
    focus: () => Promise<unknown>
    navigate: (url: string) => Promise<NotificationClickClient | null>
    postMessage?: (message: NotificationClickMessage, transfer: Transferable[]) => void
}

export type NotificationClickClients = {
    matchAll: (options: { type: 'window'; includeUncontrolled: true }) => Promise<readonly NotificationClickClient[]>
    openWindow?: (url: string) => Promise<NotificationClickClient | null>
}

async function deliverNotificationClickMessage(
    client: NotificationClickClient,
    targetUrl: string
): Promise<boolean> {
    if (!client.postMessage) {
        return false
    }
    const postMessage = (message: NotificationClickMessage, transfer: Transferable[]) => {
        client.postMessage?.(message, transfer)
    }

    if (typeof MessageChannel === 'undefined') {
        try {
            postMessage({
                type: NOTIFICATION_CLICK_MESSAGE_TYPE,
                url: targetUrl
            }, [])
            return false
        } catch {
            return false
        }
    }

    const channel = new MessageChannel()
    return new Promise((resolve) => {
        let settled = false
        const timeoutId = setTimeout(() => finish(false), 1000)

        const finish = (handled: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timeoutId)
            channel.port1.close()
            resolve(handled)
        }

        channel.port1.onmessage = (event) => {
            const data = event.data as { type?: unknown } | null
            if (data?.type === NOTIFICATION_CLICK_ACK_TYPE) {
                finish(true)
            }
        }
        channel.port1.start()

        try {
            postMessage({
                type: NOTIFICATION_CLICK_MESSAGE_TYPE,
                url: targetUrl
            }, [channel.port2])
        } catch {
            finish(false)
        }
    })
}

export async function focusOrOpenNotificationClient(
    clients: NotificationClickClients,
    targetUrl: string,
    appScope: string
): Promise<void> {
    const windowClients = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true
    })
    const scopeUrl = new URL(appScope)
    const scopePath = scopeUrl.pathname.endsWith('/')
        ? scopeUrl.pathname
        : `${scopeUrl.pathname}/`
    const targetOrigin = new URL(targetUrl).origin
    const appClients = windowClients.filter((client) => {
        try {
            const clientUrl = new URL(client.url)
            return clientUrl.origin === targetOrigin
                && (clientUrl.pathname === scopeUrl.pathname || clientUrl.pathname.startsWith(scopePath))
        } catch {
            return false
        }
    })
    const targetClient = appClients.find((client) => client.url === targetUrl)
        ?? appClients.find((client) => client.focused)
        ?? appClients[0]

    if (targetClient) {
        if (targetClient.url === targetUrl) {
            await targetClient.focus()
            return
        }

        // Keep the SPA's router in control of an already-open app window. Some
        // installed browser runtimes resolve WindowClient.navigate() without
        // updating the active SPA route on subsequent notification clicks.
        if (await deliverNotificationClickMessage(targetClient, targetUrl)) {
            await targetClient.focus()
            return
        }

        try {
            const navigatedClient = await targetClient.navigate(targetUrl)
            await (navigatedClient ?? targetClient).focus()
        } catch {
            await targetClient.focus()
        }
        return
    }

    const openedClient = await clients.openWindow?.(targetUrl)
    await openedClient?.focus()
}
