import { describe, expect, it, vi } from 'vitest'
import { focusOrOpenNotificationUrl } from './notificationClick'

describe('focusOrOpenNotificationUrl', () => {
    it('focuses the navigated existing client when navigation succeeds', async () => {
        const navigatedClient = {
            focus: vi.fn(async () => undefined),
        }
        const existingClient = {
            navigate: vi.fn(async () => navigatedClient),
            focus: vi.fn(async () => undefined),
        }
        const clientsApi = {
            matchAll: vi.fn(async () => [existingClient]),
            openWindow: vi.fn(async () => null),
        }

        await focusOrOpenNotificationUrl(clientsApi, '/sessions/session-1')

        expect(existingClient.navigate).toHaveBeenCalledWith('/sessions/session-1')
        expect(navigatedClient.focus).toHaveBeenCalledTimes(1)
        expect(existingClient.focus).not.toHaveBeenCalled()
        expect(clientsApi.openWindow).not.toHaveBeenCalled()
    })

    it('opens a new window instead of focusing a stale client when navigation fails', async () => {
        const existingClient = {
            navigate: vi.fn(async () => null),
            focus: vi.fn(async () => undefined),
        }
        const clientsApi = {
            matchAll: vi.fn(async () => [existingClient]),
            openWindow: vi.fn(async () => null),
        }
        const logger = { warn: vi.fn() }

        await focusOrOpenNotificationUrl(clientsApi, '/sessions/session-2', logger)

        expect(existingClient.navigate).toHaveBeenCalledWith('/sessions/session-2')
        expect(existingClient.focus).not.toHaveBeenCalled()
        expect(clientsApi.openWindow).toHaveBeenCalledWith('/sessions/session-2')
    })
})
