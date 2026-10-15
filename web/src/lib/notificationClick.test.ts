import { describe, expect, it, vi } from 'vitest'
import {
    focusOrOpenNotificationClient,
    getNotificationClickHref,
    NOTIFICATION_CLICK_ACK_TYPE,
    NOTIFICATION_CLICK_MESSAGE_TYPE,
    resolveNotificationTarget,
    type NotificationClickClient,
    type NotificationClickClients
} from './notificationClick'

const APP_SCOPE = 'https://hapi.test/'

function createClient(
    url: string,
    overrides: Partial<NotificationClickClient> = {}
): NotificationClickClient {
    return {
        url,
        focused: false,
        focus: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockResolvedValue(null),
        ...overrides
    }
}

function createClients(
    windows: NotificationClickClient[],
    opened: NotificationClickClient | null = null
): NotificationClickClients {
    return {
        matchAll: vi.fn().mockResolvedValue(windows),
        openWindow: vi.fn().mockResolvedValue(opened)
    }
}

describe('focusOrOpenNotificationClient', () => {
    it('sends the route to an existing HAPI window instead of opening another', async () => {
        const existing = createClient('https://hapi.test/', {
            postMessage: vi.fn((_message, transfer) => {
                transfer[0] && (transfer[0] as MessagePort).postMessage({ type: NOTIFICATION_CLICK_ACK_TYPE })
            })
        })
        const clients = createClients([existing])

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)

        expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
        expect(existing.postMessage).toHaveBeenCalledWith(
            {
                type: NOTIFICATION_CLICK_MESSAGE_TYPE,
                url: 'https://hapi.test/sessions/session-1'
            },
            expect.any(Array)
        )
        expect(existing.navigate).not.toHaveBeenCalled()
        expect(existing.focus).toHaveBeenCalledOnce()
        expect(clients.openWindow).not.toHaveBeenCalled()
    })

    it('delivers repeated notification clicks to the same existing window', async () => {
        const existing = createClient('https://hapi.test/', {
            postMessage: vi.fn((_message, transfer) => {
                transfer[0] && (transfer[0] as MessagePort).postMessage({ type: NOTIFICATION_CLICK_ACK_TYPE })
            })
        })
        const clients = createClients([existing])

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)
        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-2', APP_SCOPE)

        expect(existing.postMessage).toHaveBeenCalledTimes(2)
        expect(existing.navigate).not.toHaveBeenCalled()
        expect(existing.focus).toHaveBeenCalledTimes(2)
        expect(clients.openWindow).not.toHaveBeenCalled()
    })

    it('focuses an existing window already at the notification URL', async () => {
        const existing = createClient('https://hapi.test/sessions/session-1')
        const clients = createClients([existing])

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)

        expect(existing.focus).toHaveBeenCalledOnce()
        expect(existing.navigate).not.toHaveBeenCalled()
        expect(clients.openWindow).not.toHaveBeenCalled()
    })

    it('opens and focuses a new window when no HAPI window exists', async () => {
        const opened = createClient('https://hapi.test/')
        const clients = createClients([], opened)

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)

        expect(clients.openWindow).toHaveBeenCalledWith('https://hapi.test/sessions/session-1')
        expect(opened.focus).toHaveBeenCalledOnce()
    })

    it('focuses the existing window even if navigation fails', async () => {
        const existing = createClient('https://hapi.test/', {
            navigate: vi.fn().mockRejectedValue(new Error('navigation failed'))
        })
        const clients = createClients([existing])

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)

        expect(existing.navigate).toHaveBeenCalledWith('https://hapi.test/sessions/session-1')
        expect(existing.focus).toHaveBeenCalledOnce()
        expect(clients.openWindow).not.toHaveBeenCalled()
    })

    it('falls back to navigation if the existing window cannot receive the route message', async () => {
        const existing = createClient('https://hapi.test/', {
            postMessage: vi.fn(() => {
                throw new Error('message failed')
            })
        })
        const clients = createClients([existing])

        await focusOrOpenNotificationClient(clients, 'https://hapi.test/sessions/session-1', APP_SCOPE)

        expect(existing.navigate).toHaveBeenCalledWith('https://hapi.test/sessions/session-1')
        expect(existing.focus).toHaveBeenCalledOnce()
        expect(clients.openWindow).not.toHaveBeenCalled()
    })

    it('does not reuse an uncontrolled same-origin window outside the app scope', async () => {
        const unrelated = createClient('https://hapi.test/other/', {
            focused: true,
            postMessage: vi.fn()
        })
        const opened = createClient('https://hapi.test/app/')
        const clients = createClients([unrelated], opened)

        await focusOrOpenNotificationClient(
            clients,
            'https://hapi.test/app/sessions/session-1',
            'https://hapi.test/app/'
        )

        expect(unrelated.postMessage).not.toHaveBeenCalled()
        expect(unrelated.navigate).not.toHaveBeenCalled()
        expect(unrelated.focus).not.toHaveBeenCalled()
        expect(clients.openWindow).toHaveBeenCalledWith('https://hapi.test/app/sessions/session-1')
        expect(opened.focus).toHaveBeenCalledOnce()
    })
})

describe('getNotificationClickHref', () => {
    it('converts a same-origin notification message into a router href', () => {
        expect(getNotificationClickHref({
            type: NOTIFICATION_CLICK_MESSAGE_TYPE,
            url: 'https://hapi.test/sessions/session-1?tab=activity#latest'
        }, 'https://hapi.test')).toBe('/sessions/session-1?tab=activity#latest')
    })

    it('ignores malformed and cross-origin messages', () => {
        expect(getNotificationClickHref(null, 'https://hapi.test')).toBeNull()
        expect(getNotificationClickHref({ type: 'OTHER', url: 'https://hapi.test/sessions/session-1' }, 'https://hapi.test')).toBeNull()
        expect(getNotificationClickHref({
            type: NOTIFICATION_CLICK_MESSAGE_TYPE,
            url: 'https://attacker.test/sessions/session-1'
        }, 'https://hapi.test')).toBeNull()
    })
})

describe('resolveNotificationTarget', () => {
    it('resolves root-relative routes inside a subpath service-worker scope', () => {
        expect(resolveNotificationTarget('/sessions/session-1', 'https://hapi.test/app/'))
            .toBe('https://hapi.test/app/sessions/session-1')
    })
})
