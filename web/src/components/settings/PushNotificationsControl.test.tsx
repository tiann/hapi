import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { PushNotificationsControl } from './PushNotificationsControl'

const push = vi.hoisted(() => ({
    isSupported: true,
    permission: 'default' as NotificationPermission,
    isSubscribed: false,
    requestPermission: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
}))
vi.mock('@/hooks/usePushNotifications', () => ({ usePushNotifications: () => push }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: {} }) }))

describe('push notification settings', () => {
    beforeEach(() => {
        push.isSupported = true
        push.permission = 'default'
        push.isSubscribed = false
        push.requestPermission.mockReset().mockResolvedValue(true)
        push.subscribe.mockReset().mockResolvedValue(true)
        push.unsubscribe.mockReset().mockResolvedValue(true)
    })

    it('requests permission on the click and then registers the device', async () => {
        render(<I18nProvider><PushNotificationsControl /></I18nProvider>)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Push notifications on this device' }))
        expect(push.requestPermission).toHaveBeenCalledOnce()
        await waitFor(() => expect(push.subscribe).toHaveBeenCalledOnce())
    })

    it('unsubscribes when switched off and explains blocked permission', async () => {
        push.isSubscribed = true
        const view = render(<I18nProvider><PushNotificationsControl /></I18nProvider>)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Push notifications on this device' }))
        await waitFor(() => expect(push.unsubscribe).toHaveBeenCalledOnce())
        push.permission = 'denied'
        view.rerender(<I18nProvider><PushNotificationsControl /></I18nProvider>)
        expect(screen.getByRole('checkbox', { name: 'Push notifications on this device' })).toBeDisabled()
        expect(screen.getByText(/Notifications are blocked/)).toBeInTheDocument()
    })
})
