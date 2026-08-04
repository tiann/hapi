import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsNotificationsPage from './notifications'

const defaultPrefs = {
    namespace: 'default',
    permissionRequests: 1,
    sessionReady: 1,
    taskNotifications: 1,
    sessionCompletion: 1,
    updatedAt: Date.now(),
}

const getNotificationPreferences = vi.fn()
const updateNotificationPreferences = vi.fn()
const sendTestPush = vi.fn()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getNotificationPreferences, updateNotificationPreferences, sendTestPush },
    }),
}))

describe('SettingsNotificationsPage', () => {
    beforeEach(() => {
        getNotificationPreferences.mockResolvedValue(defaultPrefs)
        updateNotificationPreferences.mockResolvedValue(defaultPrefs)
        sendTestPush.mockResolvedValue({ ok: true })
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    function renderPage() {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsNotificationsPage />
                </I18nProvider>
            </QueryClientProvider>,
        )
    }

    it('renders all four toggles from server preferences', async () => {
        renderPage()
        const permissionSwitch = await screen.findByLabelText('Permission requests')
        expect(permissionSwitch).toBeChecked()
        expect(screen.getByLabelText('Session ready')).toBeChecked()
        expect(screen.getByLabelText('Task notifications')).toBeChecked()
        expect(screen.getByLabelText('Session completion')).toBeChecked()
    })

    it('saves a toggle change through the API', async () => {
        renderPage()
        const sessionReadySwitch = await screen.findByLabelText('Session ready')
        fireEvent.click(sessionReadySwitch)
        await waitFor(() => {
            expect(updateNotificationPreferences).toHaveBeenCalledWith({ sessionReady: 0 })
        })
    })

    it('asks for confirmation before disabling permission requests', async () => {
        renderPage()
        const permissionSwitch = await screen.findByLabelText('Permission requests')
        fireEvent.click(permissionSwitch)
        expect(updateNotificationPreferences).not.toHaveBeenCalled()
        expect(screen.getByText('Turn off permission request notifications?')).toBeTruthy()
    })

    it('applies the permission disable after confirming', async () => {
        renderPage()
        const permissionSwitch = await screen.findByLabelText('Permission requests')
        fireEvent.click(permissionSwitch)
        const confirmButton = screen.getByText('Turn off anyway')
        fireEvent.click(confirmButton)
        await waitFor(() => {
            expect(updateNotificationPreferences).toHaveBeenCalledWith({ permissionRequests: 0 })
        })
    })

    it('sends a test push and reports success', async () => {
        renderPage()
        const button = await screen.findByRole('button', { name: 'Send test push' })
        fireEvent.click(button)
        expect(sendTestPush).toHaveBeenCalled()
        expect(await screen.findByText('Test notification sent!')).toBeTruthy()
    })
})
