import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nContext, I18nProvider } from '@/lib/i18n-context'
import { en } from '@/lib/locales'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import SettingsPage from './index'

vi.mock('@hapi/protocol', () => ({
    PROTOCOL_VERSION: 1,
}))

// Mock the router hooks
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useRouter: () => ({ history: { back: vi.fn() } }),
    useLocation: () => '/settings',
}))

// Mock useFontScale hook
vi.mock('@/hooks/useFontScale', () => ({
    useFontScale: () => ({ fontScale: 1, setFontScale: vi.fn() }),
    getFontScaleOptions: () => [
        { value: 0.875, label: '87.5%' },
        { value: 1, label: '100%' },
        { value: 1.125, label: '112.5%' },
    ],
}))

vi.mock('@/hooks/useTerminalFontSize', () => ({
    useTerminalFontSize: () => ({ terminalFontSize: 13, setTerminalFontSize: vi.fn() }),
    getTerminalFontSizeOptions: () => [
        { value: 9, label: '9px' },
        { value: 13, label: '13px' },
        { value: 17, label: '17px' },
    ],
}))

// Mock useTheme hook
vi.mock('@/hooks/useTheme', () => ({
    useAppearance: () => ({ appearance: 'system', setAppearance: vi.fn() }),
    getAppearanceOptions: () => [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ],
}))

// Mock languages
vi.mock('@/lib/languages', () => ({
    getElevenLabsSupportedLanguages: () => [
        { code: null, name: 'Auto-detect' },
        { code: 'en', name: 'English' },
    ],
    getLanguageDisplayName: (lang: { code: string | null; name: string }) => lang.name,
}))

const mockRequestPermission = vi.fn(async () => true)
const mockSubscribe = vi.fn(async () => true)
const mockRefreshSubscription = vi.fn(async () => {})
let mockPushState = {
    isSupported: true,
    permission: 'default' as NotificationPermission,
    isSubscribed: false,
}

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {}, token: 'token', baseUrl: 'http://localhost' }),
}))

vi.mock('@/hooks/usePushNotifications', () => ({
    usePushNotifications: () => ({
        ...mockPushState,
        requestPermission: mockRequestPermission,
        subscribe: mockSubscribe,
        refreshSubscription: mockRefreshSubscription,
        unsubscribe: vi.fn(async () => true),
    }),
}))

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

function renderWithSpyT(ui: React.ReactElement) {
    const translations = en as Record<string, string>
    const spyT = vi.fn((key: string) => translations[key] ?? key)
    render(
        <I18nContext.Provider value={{ t: spyT, locale: 'en', setLocale: vi.fn() }}>
            {ui}
        </I18nContext.Provider>
    )
    return spyT
}

describe('SettingsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockPushState = {
            isSupported: true,
            permission: 'default',
            isSubscribed: false,
        }
        mockRequestPermission.mockClear()
        mockSubscribe.mockClear()
        mockRefreshSubscription.mockClear()
        // Mock localStorage
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock })
    })

    afterEach(() => {
        cleanup()
    })

    it('renders the About section', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getByText('About')).toBeInTheDocument()
    })

    it('displays the App Version with correct value', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('App Version').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText(__APP_VERSION__).length).toBeGreaterThanOrEqual(1)
    })

    it('displays the Protocol Version with correct value', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Protocol Version').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText(String(PROTOCOL_VERSION)).length).toBeGreaterThanOrEqual(1)
    })

    it('displays the website link with correct URL and security attributes', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Website').length).toBeGreaterThanOrEqual(1)
        const links = screen.getAllByRole('link', { name: 'hapi.run' })
        expect(links.length).toBeGreaterThanOrEqual(1)
        const link = links[0]
        expect(link).toHaveAttribute('href', 'https://hapi.run')
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('uses correct i18n keys for About section', () => {
        const spyT = renderWithSpyT(<SettingsPage />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.about.title')
        expect(calledKeys).toContain('settings.about.website')
        expect(calledKeys).toContain('settings.about.appVersion')
        expect(calledKeys).toContain('settings.about.protocolVersion')
    })

    it('renders the Appearance setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Appearance').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Follow System').length).toBeGreaterThanOrEqual(1)
    })

    it('uses correct i18n keys for Appearance setting', () => {
        const spyT = renderWithSpyT(<SettingsPage />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.display.appearance')
        expect(calledKeys).toContain('settings.display.appearance.system')
    })

    it('renders the Terminal Font Size setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Terminal Font Size').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('13px').length).toBeGreaterThanOrEqual(1)
    })

    it('renders notification settings state and enable button', () => {
        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Notifications').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Not enabled').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeInTheDocument()
    })

    it('enables notifications only after clicking the explicit button', async () => {
        renderWithProviders(<SettingsPage />)

        expect(mockRequestPermission).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))

        await waitFor(() => expect(mockRequestPermission).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(mockSubscribe).toHaveBeenCalledTimes(1))
    })

    it('does not refresh into an enabled state when hub subscription registration fails', async () => {
        mockSubscribe.mockResolvedValueOnce(false)
        renderWithProviders(<SettingsPage />)

        fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))

        await waitFor(() => expect(mockSubscribe).toHaveBeenCalledTimes(1))
        expect(mockRefreshSubscription).not.toHaveBeenCalled()
    })

    it('renders resubscribe button when permission is granted but subscription is missing', () => {
        mockPushState = {
            isSupported: true,
            permission: 'granted',
            isSubscribed: false,
        }

        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Permission granted, not subscribed').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('button', { name: 'Resubscribe notifications' })).toBeInTheDocument()
    })

    it('shows help text when notification permission is denied', () => {
        mockPushState = {
            isSupported: true,
            permission: 'denied',
            isSubscribed: false,
        }

        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Blocked by browser settings').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByText('Enable notifications from browser or system settings, then return here.')).toBeInTheDocument()
    })
})
