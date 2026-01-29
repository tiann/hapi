import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nContext, type I18nContextValue } from '@/lib/i18n-context'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import SettingsPage from './index'

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

// Mock languages
vi.mock('@/lib/languages', () => ({
    getElevenLabsSupportedLanguages: () => [
        { code: null, name: 'Auto-detect' },
        { code: 'en', name: 'English' },
    ],
    getLanguageDisplayName: (lang: { code: string | null; name: string }) => lang.name,
}))

const mockT: I18nContextValue['t'] = (key: string) => {
    const translations: Record<string, string> = {
        'settings.title': 'Settings',
        'settings.language.title': 'Language',
        'settings.language.label': 'Language',
        'settings.display.title': 'Display',
        'settings.display.fontSize': 'Font Size',
        'settings.voice.title': 'Voice Assistant',
        'settings.voice.language': 'Voice Language',
        'settings.voice.autoDetect': 'Auto-detect',
        'settings.about.title': 'About',
        'settings.about.appVersion': 'App Version',
        'settings.about.protocolVersion': 'Protocol Version',
    }
    return translations[key] ?? key
}

const mockI18nContext: I18nContextValue = {
    t: mockT,
    locale: 'en',
    setLocale: vi.fn(),
}

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nContext.Provider value={mockI18nContext}>
            {ui}
        </I18nContext.Provider>
    )
}

describe('SettingsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // Mock localStorage
        const localStorageMock = {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock })
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
})
