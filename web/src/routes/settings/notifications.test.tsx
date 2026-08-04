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

const defaultCopyResponse = {
    copy: {},
    defaults: {
        permissionRequest: { title: 'Permission Request', body: '{sessionName}{tool}' },
        ready: { title: 'Ready for input', body: '{agentName} is waiting in {sessionName}' },
        taskCompleted: { title: 'Task completed', body: '{agentName} · {sessionName} · {summary}' },
        taskFailed: { title: 'Task failed', body: '{agentName} · {sessionName} · {summary}' },
        sessionCompletion: { title: 'Session completed', body: '{agentName} · {sessionName}' },
    },
}

const getNotificationPreferences = vi.fn()
const updateNotificationPreferences = vi.fn()
const sendTestPush = vi.fn()
const getNotificationCopy = vi.fn()
const updateNotificationCopy = vi.fn()

function makeToken(ns: string): string {
    return `header.${btoa(JSON.stringify({ ns }))}.sig`
}

let mockToken = makeToken('default')

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getNotificationPreferences, updateNotificationPreferences, sendTestPush, getNotificationCopy, updateNotificationCopy },
        token: mockToken,
    }),
}))

describe('SettingsNotificationsPage', () => {
    beforeEach(() => {
        mockToken = makeToken('default')
        getNotificationPreferences.mockResolvedValue(defaultPrefs)
        updateNotificationPreferences.mockResolvedValue(defaultPrefs)
        sendTestPush.mockResolvedValue({ ok: true })
        getNotificationCopy.mockResolvedValue(defaultCopyResponse)
        updateNotificationCopy.mockResolvedValue(defaultCopyResponse)
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

    it('hides the copy section for non-admin namespaces', async () => {
        mockToken = makeToken('user-1')
        renderPage()
        expect(screen.queryByText('Push notification copy')).toBeNull()
    })

    it('renders the copy section for the admin namespace', async () => {
        renderPage()
        expect(await screen.findByText('Push notification copy')).toBeTruthy()
        expect(await screen.findByText('Session completed')).toBeTruthy()
    })

    it('saves edited copy through the API', async () => {
        renderPage()
        const titleInputs = await screen.findAllByLabelText('Title')
        // Index 1 = "ready" block (after permissionRequest).
        fireEvent.change(titleInputs[1], { target: { value: 'Custom {agentName}' } })
        const saveButton = screen.getByRole('button', { name: 'Save copy' })
        fireEvent.click(saveButton)
        await waitFor(() => {
            expect(updateNotificationCopy).toHaveBeenCalledWith({
                ready: { title: 'Custom {agentName}', body: '' },
            })
        })
    })

    it('inserts a variable chip into the focused body field', async () => {
        renderPage()
        await screen.findByText('Push notification copy')
        const chip = screen.getAllByText('{agentName}')[0]
        fireEvent.click(chip)
        const bodyInputs = screen.getAllByLabelText('Body') as HTMLTextAreaElement[]
        expect(bodyInputs[0].value).toBe('{agentName}')
    })

    it('shows a live preview with sample values', async () => {
        renderPage()
        expect(await screen.findByText(/Claude is waiting in My Project/)).toBeTruthy()
    })

    it('previews a title-only override with the default body', async () => {
        renderPage()
        const titleInputs = await screen.findAllByLabelText('Title')
        fireEvent.change(titleInputs[1], { target: { value: 'Custom {agentName}' } })

        expect(await screen.findByText(/Custom Claude.*Claude is waiting in My Project/)).toBeTruthy()
    })
})
