import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
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

vi.mock('@/hooks/useComposerEnterBehavior', () => ({
    useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send', setComposerEnterBehavior: vi.fn() }),
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

vi.mock('@/hooks/useSessionPreviewLimit', () => ({
    MIN_SESSION_PREVIEW_LIMIT: 1,
    MAX_SESSION_PREVIEW_LIMIT: 99,
    normalizeSessionPreviewLimit: (value: number) => Number.isInteger(value) ? Math.min(99, Math.max(1, value)) : 8,
    useSessionPreviewLimit: () => ({ sessionPreviewLimit: 8, setSessionPreviewLimit: vi.fn() }),
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
        { value: 'soft-green', labelKey: 'settings.chat.surfaceColor.softGreen' },
        { value: 'soft-yellow', labelKey: 'settings.chat.surfaceColor.softYellow' },
    ],
    getChatSurfaceColorPickerValue: () => '#7db7ff',
    toPresetChatSurfaceColorPreference: (value: string) => value === 'default' ? 'default' : `preset:${value}`,
    toCustomChatSurfaceColorPreference: (value: string) => `custom:${value}`,
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

// Use vi.hoisted so these mocks are available when vi.mock factories run
const { mockFetchVoices, mockApi } = vi.hoisted(() => {
    const mockFetchVoices = vi.fn(() => Promise.resolve<unknown[]>([]))
    const mockApi = {
        fetchVoices: vi.fn(() => Promise.resolve({ voices: [] })),
    }
    return { mockFetchVoices, mockApi }
})

// Mock static voices list
vi.mock('@/lib/voices', () => ({
    VOICES: [{ id: 'voice1', name: 'Jessica', gender: 'female', description: 'Default' }],
    DEFAULT_VOICE_ID: 'voice1',
    getVoiceById: (id: string | null) =>
        id === 'voice1' ? { id: 'voice1', name: 'Jessica', gender: 'female', description: 'Default' } : undefined,
    getFallbackVoices: () => [{ id: 'voice1', name: 'Jessica', gender: 'female', description: 'Default' }],
}))

// Mock fetchVoices to return a resolved list by default
vi.mock('@/api/voice', () => ({
    fetchVoices: mockFetchVoices,
    fetchVoiceToken: vi.fn(() => Promise.resolve({ allowed: true, token: 'tok' })),
}))

// Mock useAppContext so the page doesn't throw "AppContext is not available"
vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: mockApi, token: 'test', baseUrl: '' }),
    AppContextProvider: ({ children }: { children: React.ReactNode }) => children,
}))


afterEach(() => {
    cleanup()
})
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
        // Reset fetchVoices mock to return empty list by default
        mockFetchVoices.mockResolvedValue([])
        // Mock localStorage
        const localStorageMock = {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
            key: vi.fn(() => null),
            length: 0,
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
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
        expect(calledKeys).toContain('settings.display.sessionPreviewLimit')
        expect(calledKeys).toContain('settings.display.sessionPreviewLimit.decrease')
        expect(calledKeys).toContain('settings.display.sessionPreviewLimit.increase')
    })

    it('renders the Terminal Font Size setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Terminal Font Size').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('13px').length).toBeGreaterThanOrEqual(1)
    })

    it('renders the Session Preview Limit setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Sessions Before Folding').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByLabelText('Sessions Before Folding')).toHaveValue(8)
        expect(screen.getAllByLabelText('Show fewer sessions before folding').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByLabelText('Show more sessions before folding').length).toBeGreaterThanOrEqual(1)
    })

    it('renders the Enter Key setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Enter Key').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Send message').length).toBeGreaterThanOrEqual(1)
    })

    it('renders the Terminal Tool Display setting', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Terminal Tool Cards').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Compact (command only)').length).toBeGreaterThanOrEqual(1)
    })

    it('renders grouped tool and user message background settings', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Grouped Tool Use Background').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('User Message Background').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Default color').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Soft blue').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Soft green').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Soft yellow').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByLabelText('Custom color').length).toBeGreaterThanOrEqual(2)
    })

    it('uses correct i18n keys for the Enter Key setting', () => {
        const spyT = renderWithSpyT(<SettingsPage />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.chat.title')
        expect(calledKeys).toContain('settings.chat.enterBehavior')
        expect(calledKeys).toContain('settings.chat.enterBehavior.send')
        expect(calledKeys).toContain('settings.chat.terminalToolDisplay')
        expect(calledKeys).toContain('settings.chat.terminalToolDisplay.compact')
        expect(calledKeys).toContain('settings.chat.groupedToolBackground')
        expect(calledKeys).toContain('settings.chat.userMessageBackground')
        expect(calledKeys).toContain('settings.chat.surfaceColor.default')
    })

    // Voice picker tests
    it('renders the Voice section with "Voice" label', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getAllByText('Voice').length).toBeGreaterThanOrEqual(1)
    })

    it('uses correct i18n keys for the voice picker', () => {
        const spyT = renderWithSpyT(<SettingsPage />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.voice.voice')
        expect(calledKeys).toContain('settings.voice.voiceDefault')
    })

    it('voice picker shows "Default" option when opened', () => {
        renderWithProviders(<SettingsPage />)
        // The current value "Default" is shown in the closed picker button
        expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1)
    })

    it('opens voice picker and shows "Default" option in the list', () => {
        renderWithProviders(<SettingsPage />)
        // Click the voice picker button (aria-label target via the label text)
        const voiceButtons = screen.getAllByRole('button', { name: /Default/i })
        // Find the button that has aria-haspopup — that's the voice picker trigger
        const pickerButton = voiceButtons.find(btn => btn.getAttribute('aria-haspopup') === 'listbox')
        expect(pickerButton).toBeTruthy()
        fireEvent.click(pickerButton!)
        // The listbox should appear with a "Default" option inside
        const listbox = screen.getByRole('listbox', { name: 'Voice' })
        expect(listbox).toBeInTheDocument()
        expect(listbox.textContent).toContain('Default')
    })

    it('shows dynamic voices in picker when fetchVoices returns a list', async () => {
        mockFetchVoices.mockResolvedValue([
            { id: 'dyn1', name: 'Alice', previewUrl: '', category: 'premade' },
            { id: 'dyn2', name: 'Bob', previewUrl: 'https://example.com/bob.mp3', category: 'premade' },
        ])

        renderWithProviders(<SettingsPage />)

        const pickerButton = screen.getByRole('button', { name: /Voice\s*Default/i })
        fireEvent.click(pickerButton)

        await waitFor(() => {
            expect(screen.getByText('Alice')).toBeInTheDocument()
            expect(screen.getByText('Bob')).toBeInTheDocument()
        })
    })


    it('shows a disabled preview button with tooltip when previewUrl is missing', async () => {
        mockFetchVoices.mockResolvedValue([
            { id: 'dyn1', name: 'Alice', previewUrl: '', category: 'premade' },
        ])

        renderWithProviders(<SettingsPage />)

        const pickerButton = screen.getByRole('button', { name: /Voice\s*Default/i })
        fireEvent.click(pickerButton)

        const previewButton = await screen.findByLabelText('Preview voice')
        expect(previewButton).toBeDisabled()
        expect(previewButton).toHaveAttribute('title', 'Preview unavailable without an ElevenLabs API key')
    })

    it('shows a play button for voices with a previewUrl', async () => {
        mockFetchVoices.mockResolvedValue([
            { id: 'dyn1', name: 'Alice', previewUrl: 'https://example.com/alice.mp3', category: 'premade' },
        ])

        renderWithProviders(<SettingsPage />)

        const pickerButton = screen.getByRole('button', { name: /Voice\s*Default/i })
        fireEvent.click(pickerButton)

        await screen.findByText('Alice')
        expect(screen.getByLabelText('Preview voice')).toBeInTheDocument()
        expect(screen.getByLabelText('Preview voice')).not.toBeDisabled()
    })

    it('stops preview audio on unmount', async () => {
        mockFetchVoices.mockResolvedValue([
            { id: 'dyn1', name: 'Alice', previewUrl: 'https://example.com/alice.mp3', category: 'premade' },
        ])

        const pause = vi.fn()
        const play = vi.fn(() => Promise.resolve())
        const addEventListener = vi.fn()
        class MockAudio {
            pause = pause
            play = play
            addEventListener = addEventListener
            constructor(_url: string) {}
        }
        const OriginalAudio = globalThis.Audio
        const OriginalWindowAudio = window.Audio
        // @ts-expect-error test override
        globalThis.Audio = MockAudio
        // @ts-expect-error test override
        window.Audio = MockAudio

        const view = renderWithProviders(<SettingsPage />)
        const pickerButton = screen.getByRole('button', { name: /Voice\s*Default/i })
        fireEvent.click(pickerButton)
        const aliceLabel = await screen.findByText('Alice')
        const optionRow = aliceLabel.closest('[role="option"]')
        expect(optionRow).toBeTruthy()
        const enabledPreview = optionRow?.querySelector('button[aria-label="Preview voice"]') as HTMLButtonElement | null
        expect(enabledPreview).toBeTruthy()
        expect(enabledPreview?.disabled).toBe(false)
        fireEvent.click(enabledPreview as HTMLElement)

        view.unmount()
        expect(pause).toHaveBeenCalled()

        globalThis.Audio = OriginalAudio
        window.Audio = OriginalWindowAudio
    })

    it('selecting a voice calls localStorage.setItem with the voice id', async () => {
        mockFetchVoices.mockResolvedValue([
            { id: 'dyn1', name: 'Alice', previewUrl: '', category: 'premade' },
        ])

        renderWithProviders(<SettingsPage />)

        const pickerButton = screen.getByRole('button', { name: /Voice\s*Default/i })
        fireEvent.click(pickerButton)

        const alice = await screen.findByText('Alice')
        fireEvent.click(alice)
        expect(window.localStorage.setItem).toHaveBeenCalledWith('hapi-voice-id', 'dyn1')
    })
})
