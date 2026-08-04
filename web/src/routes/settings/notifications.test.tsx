import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
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
        return queryClient
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

    it('keeps the confirmation open when disabling permission notifications fails', async () => {
        updateNotificationPreferences.mockRejectedValueOnce(new Error('save failed'))
        renderPage()
        fireEvent.click(await screen.findByLabelText('Permission requests'))
        fireEvent.click(screen.getByText('Turn off anyway'))

        expect(await screen.findByText('save failed')).toBeTruthy()
        expect(screen.getByText('Turn off permission request notifications?')).toBeTruthy()
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

    it('does not expose the editor before existing copy is loaded', async () => {
        let resolveCopy: (value: typeof defaultCopyResponse) => void = () => {}
        getNotificationCopy.mockReturnValue(new Promise((resolve) => {
            resolveCopy = resolve
        }))
        renderPage()
        await screen.findByLabelText('Permission requests')

        expect(screen.queryByText('Push notification copy')).toBeNull()
        resolveCopy(defaultCopyResponse)
        expect(await screen.findByText('Push notification copy')).toBeTruthy()
    })

    it('saves edited copy through the API', async () => {
        renderPage()
        const readyRow = await screen.findByRole('button', { name: /Session ready.*Ready for input/ })
        fireEvent.click(readyRow)
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Custom {agentName}' } })
        const saveButton = screen.getByRole('button', { name: 'Save copy' })
        fireEvent.click(saveButton)
        await waitFor(() => {
            expect(updateNotificationCopy).toHaveBeenCalledWith({
                ready: {
                    title: 'Custom {agentName}',
                    body: '{agentName} is waiting in {sessionName}'
                },
            })
        })
    })

    it('reports a rejected notification copy save', async () => {
        updateNotificationCopy.mockRejectedValueOnce(new Error('write failed'))
        renderPage()
        await screen.findByText('Push notification copy')

        fireEvent.click(screen.getByRole('button', { name: 'Save copy' }))

        expect(await screen.findByText('Failed to save notification copy')).toBeTruthy()
    })

    it('accepts refreshed copy after a successful save', async () => {
        updateNotificationCopy.mockResolvedValueOnce({
            ...defaultCopyResponse,
            copy: { ready: { title: 'Saved title', body: 'Saved body' } }
        })
        const queryClient = renderPage()
        const readyRow = await screen.findByRole('button', { name: /Session ready.*Ready for input/ })
        fireEvent.click(readyRow)
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Saved title' } })
        fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Saved body' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save copy' }))
        expect(await screen.findByText('Copy saved')).toBeTruthy()

        act(() => {
            queryClient.setQueryData(queryKeys.notificationCopy, {
                ...defaultCopyResponse,
                copy: { ready: { title: 'Remote title', body: 'Remote body' } }
            })
        })

        expect(await screen.findByRole('button', { name: /Session ready.*Remote title.*Remote body/ })).toBeTruthy()
    })

    it('keeps copy editors collapsed and prefills defaults when opened', async () => {
        renderPage()
        const readyRow = await screen.findByRole('button', { name: /Session ready.*Ready for input/ })
        expect(screen.queryByLabelText('Title')).toBeNull()

        fireEvent.click(readyRow)
        expect(screen.getByLabelText('Title')).toHaveValue('Ready for input')
        expect(screen.getByLabelText('Body')).toHaveValue('{agentName} is waiting in {sessionName}')
    })

    it('updates the collapsed summary while editing', async () => {
        renderPage()
        const readyRow = await screen.findByRole('button', { name: /Session ready.*Ready for input/ })
        fireEvent.click(readyRow)
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Custom {agentName}' } })

        expect(await screen.findByRole('button', { name: /Custom Claude.*Claude is waiting in My Project/ })).toBeTruthy()
    })

    it('restores a customized block to its visible defaults', async () => {
        getNotificationCopy.mockResolvedValue({
            ...defaultCopyResponse,
            copy: {
                ready: { title: 'Custom title', body: 'Custom body' }
            }
        })
        renderPage()
        const readyRow = await screen.findByRole('button', { name: /Session ready.*Custom title.*Custom body/ })
        fireEvent.click(readyRow)
        fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

        expect(screen.getByLabelText('Title')).toHaveValue('Ready for input')
        expect(screen.getByLabelText('Body')).toHaveValue('{agentName} is waiting in {sessionName}')
    })
})
