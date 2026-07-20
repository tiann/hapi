import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsHubPage from './index'
import SettingsGeneralPage from './general'
import SettingsDisplayPage from './display'
import SettingsChatPage from './chat'
import SettingsAboutPage from './about'
import SettingsVoicePage from './voice'
import SettingsVoiceVoicesPage from './voice-voices'
import SettingsVoiceAdvancedPage from './voice-advanced'

const { navigate, setAppearance, setColorTheme, setFontScale, setTerminalFontSize, setComposerEnterBehavior, setVoice } = vi.hoisted(() => ({
    navigate: vi.fn(),
    setAppearance: vi.fn(),
    setColorTheme: vi.fn(),
    setFontScale: vi.fn(),
    setTerminalFontSize: vi.fn(),
    setComposerEnterBehavior: vi.fn(),
    setVoice: vi.fn(),
}))

vi.mock('@/hooks/useColorTheme', () => ({
    useColorTheme: () => ({ colorTheme: 'default', setColorTheme }),
    getColorThemeOptions: () => [
        { value: 'default', labelKey: 'settings.display.colorTheme.default' },
        { value: 'nord', labelKey: 'settings.display.colorTheme.nord' },
    ],
    getColorThemePreview: (theme: string) => theme === 'nord'
        ? { light: '#eceff4', dark: '#2e3440', accent: '#88c0d0' }
        : { light: '#ffffff', dark: '#1c1c1e', accent: '#111827' },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate,
}))

vi.mock('@hapi/protocol', () => ({ PROTOCOL_VERSION: 1 }))

vi.mock('@/hooks/useTheme', () => ({
    useAppearance: () => ({ appearance: 'system', setAppearance }),
    getAppearanceOptions: () => [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'oled', labelKey: 'settings.display.appearance.oled' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ],
}))

vi.mock('@/hooks/useFontScale', () => ({
    useFontScale: () => ({ fontScale: 1, setFontScale }),
    getFontScaleOptions: () => [
        { value: 0.8, label: '80%' }, { value: 0.9, label: '90%' }, { value: 1, label: '100%' },
        { value: 1.1, label: '110%' }, { value: 1.2, label: '120%' },
    ],
}))

vi.mock('@/hooks/useTerminalFontSize', () => ({
    useTerminalFontSize: () => ({ terminalFontSize: 13, setTerminalFontSize }),
    getTerminalFontSizeOptions: () => [
        { value: 9, label: '9px' }, { value: 11, label: '11px' }, { value: 13, label: '13px' },
        { value: 15, label: '15px' }, { value: 17, label: '17px' },
    ],
}))

vi.mock('@/hooks/useSessionListStatusMode', () => ({
    useSessionListStatusMode: () => ({ sessionListStatusMode: 'standard', setSessionListStatusMode: vi.fn() }),
    getSessionListStatusModeOptions: () => [
        { value: 'standard', labelKey: 'settings.display.sessionListStatus.standard' },
        { value: 'detailed', labelKey: 'settings.display.sessionListStatus.detailed' },
    ],
}))

vi.mock('@/hooks/useShowActiveSessionsOnly', () => ({
    useShowActiveSessionsOnly: () => ({ showActiveSessionsOnly: false, setShowActiveSessionsOnly: vi.fn() }),
}))

vi.mock('@/hooks/useSessionPreviewLimit', () => ({
    MIN_SESSION_PREVIEW_LIMIT: 1,
    MAX_SESSION_PREVIEW_LIMIT: 99,
    normalizeSessionPreviewLimit: (value: number) => Math.max(1, Math.min(99, Math.round(value))),
    useSessionPreviewLimit: () => ({ sessionPreviewLimit: 8, setSessionPreviewLimit: vi.fn() }),
}))

vi.mock('@/hooks/useThemeColors', () => ({
    useThemeColors: () => ({
        keys: [],
        getPickerValue: vi.fn(),
        isCustomized: vi.fn(() => false),
        hasAnyCustom: false,
        setColor: vi.fn(),
        resetColor: vi.fn(),
        resetAll: vi.fn(),
    }),
}))

vi.mock('@/hooks/useComposerEnterBehavior', () => ({
    useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send', setComposerEnterBehavior }),
    getComposerEnterBehaviorOptions: () => [
        { value: 'send', labelKey: 'settings.chat.enterBehavior.send' },
        { value: 'newline', labelKey: 'settings.chat.enterBehavior.newline' },
    ],
}))

vi.mock('@/hooks/useTerminalToolDisplayMode', () => ({
    useTerminalToolDisplayMode: () => ({ terminalToolDisplayMode: 'compact', setTerminalToolDisplayMode: vi.fn() }),
    getTerminalToolDisplayModeOptions: () => [
        { value: 'compact', labelKey: 'settings.chat.terminalToolDisplay.compact' },
        { value: 'detailed', labelKey: 'settings.chat.terminalToolDisplay.detailed' },
    ],
}))

vi.mock('@/hooks/useChatSurfaceColors', () => ({
    useChatSurfaceColors: () => ({
        toolGroupBackground: 'default',
        userMessageBackground: 'preset:soft-blue',
        setToolGroupBackground: vi.fn(),
        setUserMessageBackground: vi.fn(),
    }),
    getChatSurfaceColorPresetOptions: () => [
        { value: 'default', labelKey: 'settings.chat.surfaceColor.default' },
        { value: 'soft-blue', labelKey: 'settings.chat.surfaceColor.softBlue' },
    ],
    getChatSurfaceColorPickerValue: () => '#7db7ff',
    toPresetChatSurfaceColorPreference: (value: string) => value === 'default' ? 'default' : `preset:${value}`,
    toCustomChatSurfaceColorPreference: (value: string) => `custom:${value}`,
}))

vi.mock('@/components/settings/VoiceAdvancedControls', () => ({
    VoiceRespondsControls: () => <div>Response length controls</div>,
    VoiceSoundsControls: () => <div>Sound controls</div>,
    VoicePersonaControls: () => <div>Persona controls</div>,
    VoiceDiagnosticsControls: () => <div>Diagnostics controls</div>,
}))

vi.mock('./useVoiceSettings', () => ({
    useVoiceSettings: () => ({
        configuredBackends: ['elevenlabs'],
        backend: 'elevenlabs',
        setBackend: vi.fn(),
        voiceId: null,
        setVoice,
        voices: [
            { id: 'voice-1', name: 'Jessica', description: 'Warm', previewUrl: 'https://example.test/voice.mp3', category: 'premade' },
        ],
        voiceLanguage: null,
        setVoiceLanguage: vi.fn(),
        voiceLanguages: [{ code: null, name: 'Auto-detect' }, { code: 'en', name: 'English' }],
        playingVoiceId: null,
        previewVoice: vi.fn(),
    }),
}))

function renderPage(page: React.ReactElement) {
    return render(<I18nProvider>{page}</I18nProvider>)
}

describe('responsive settings pages', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
    })

    it('renders the mobile hub categories with current summaries', () => {
        renderPage(<SettingsHubPage />)
        expect(screen.getByText('General')).toBeInTheDocument()
        expect(screen.getAllByText('Display').length).toBeGreaterThan(0)
        expect(screen.getByText('Voice, language, and behavior')).toBeInTheDocument()
        expect(screen.getByText(`v${__APP_VERSION__}`)).toBeInTheDocument()
    })

    it('navigates from the hub to a category route', () => {
        renderPage(<SettingsHubPage />)
        fireEvent.click(screen.getByRole('button', { name: /General/ }))
        expect(navigate).toHaveBeenCalledWith({ to: '/settings/general' })
    })

    it('changes the application language inline', () => {
        renderPage(<SettingsGeneralPage />)
        fireEvent.click(screen.getByRole('radio', { name: '简体中文' }))
        expect(localStorage.getItem('hapi-lang')).toBe('zh-CN')
    })

    it('renders compact display controls without dropdown popovers', () => {
        renderPage(<SettingsDisplayPage />)
        expect(screen.getByRole('radio', { name: 'OLED Black' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Nord' }))
        expect(setColorTheme).toHaveBeenCalledWith('nord')
        expect(screen.getByRole('radio', { name: '120%' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Sessions Before Folding' })).toHaveValue(8)
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('keeps chat enum choices inline', () => {
        renderPage(<SettingsChatPage />)
        fireEvent.click(screen.getByRole('radio', { name: 'Insert newline' }))
        expect(setComposerEnterBehavior).toHaveBeenCalledWith('newline')
        expect(screen.getByText('Grouped Tool Use Background')).toBeInTheDocument()
    })

    it('renders About metadata on its own route page', () => {
        renderPage(<SettingsAboutPage />)
        expect(screen.getByText('App Version')).toBeInTheDocument()
        expect(screen.getByText(String(__APP_VERSION__))).toBeInTheDocument()
        expect(screen.getByText('Protocol Version')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'hapi.run' })).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('links common voice settings to full-page voices and advanced pages', () => {
        renderPage(<SettingsVoicePage />)
        fireEvent.click(screen.getByRole('button', { name: /Voice/ }))
        expect(navigate).toHaveBeenCalledWith({ to: '/settings/voice/voices' })
        fireEvent.click(screen.getByRole('button', { name: /Advanced voice settings/ }))
        expect(navigate).toHaveBeenCalledWith({ to: '/settings/voice/advanced' })
    })

    it('selects a voice from the full-page picker', () => {
        renderPage(<SettingsVoiceVoicesPage />)
        fireEvent.click(screen.getByRole('radio', { name: /Jessica/ }))
        expect(setVoice).toHaveBeenCalledWith('voice-1')
    })

    it('keeps persona, tuning, and diagnostics on the advanced route page', () => {
        renderPage(<SettingsVoiceAdvancedPage />)
        expect(screen.getByText('Persona controls')).toBeInTheDocument()
        expect(screen.getByText('Sound controls')).toBeInTheDocument()
        expect(screen.getByText('Diagnostics controls')).toBeInTheDocument()
    })
})
