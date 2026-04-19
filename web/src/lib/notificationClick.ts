export type NotificationWindowClientLike = {
    focus?: () => Promise<unknown>
    navigate?: (url: string) => Promise<NotificationWindowClientLike | null>
}

export type NotificationClientsLike = {
    matchAll: (options: { type: 'window'; includeUncontrolled: true }) => Promise<NotificationWindowClientLike[]>
    openWindow: (url: string) => Promise<unknown>
}

type NotificationClickLogger = Pick<Console, 'warn'>

export async function focusOrOpenNotificationUrl(
    clientsApi: NotificationClientsLike,
    url: string,
    logger: NotificationClickLogger = console
): Promise<void> {
    const windowClients = await clientsApi.matchAll({
        type: 'window',
        includeUncontrolled: true
    })

    for (const client of windowClients) {
        if (!client.navigate || !client.focus) {
            continue
        }

        let navigatedClient: NotificationWindowClientLike | null = null
        try {
            navigatedClient = await client.navigate(url)
        } catch (error) {
            logger.warn('Failed to navigate existing window client from notification click', error)
            continue
        }

        if (!navigatedClient?.focus) {
            continue
        }

        try {
            await navigatedClient.focus()
            return
        } catch (error) {
            logger.warn('Failed to focus existing window client from notification click', error)
        }
    }

    try {
        await clientsApi.openWindow(url)
    } catch (error) {
        logger.warn('Failed to open window from notification click', error)
    }
}
