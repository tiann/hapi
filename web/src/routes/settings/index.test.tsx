import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nContext, I18nProvider } from '@/lib/i18n-context'
import { en } from '@/lib/locales'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import SettingsPage from './index'

const updateMachineSessionProfilesMock = vi.fn()
const useMachinesMock = vi.fn()
const useMachineSessionProfilesMock = vi.fn()

vi.mock('@hapi/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@hapi/protocol')>()
    return {
        ...actual,
        PROTOCOL_VERSION: 1,
    }
})

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {} as never,
        token: 'token',
        baseUrl: 'http://localhost'
    })
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useRouter: () => ({ history: { back: vi.fn() } }),
    useLocation: ({ select }: { select?: (location: { pathname: string; search: object }) => unknown } = {}) => {
        const location = { pathname: '/settings', search: {} }
        return select ? select(location) : location
    },
}))

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

vi.mock('@/hooks/useTheme', () => ({
    useAppearance: () => ({ appearance: 'system', setAppearance: vi.fn() }),
    getAppearanceOptions: () => [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ],
}))

vi.mock('@/lib/languages', () => ({
    getElevenLabsSupportedLanguages: () => [
        { code: null, name: 'Auto-detect' },
        { code: 'en', name: 'English' },
    ],
    getLanguageDisplayName: (lang: { code: string | null; name: string }) => lang.name,
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: (...args: unknown[]) => useMachinesMock(...args)
}))

vi.mock('@/hooks/queries/useMachineSessionProfiles', () => ({
    useMachineSessionProfiles: (...args: unknown[]) => useMachineSessionProfilesMock(...args)
}))

vi.mock('@/hooks/mutations/useUpdateMachineSessionProfiles', () => ({
    useUpdateMachineSessionProfiles: () => ({
        updateMachineSessionProfiles: updateMachineSessionProfilesMock,
        isPending: false,
        error: null
    })
}))

const machineSessionProfiles = {
    profiles: [
        {
            id: 'ice',
            label: 'Ice',
            agent: 'codex' as const,
            defaults: {
                model: 'gpt-5.4',
                permissionMode: 'safe-yolo' as const
            }
        },
        {
            id: 'focus',
            label: 'Focus',
            agent: 'codex' as const,
            defaults: {
                modelReasoningEffort: 'high' as const,
                sessionType: 'worktree' as const
            }
        }
    ],
    defaults: {
        codexProfileId: 'ice'
    }
}

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

        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock })

        useMachinesMock.mockReturnValue({
            machines: [
                {
                    id: 'machine-1',
                    active: true,
                    metadata: {
                        host: 'localhost',
                        platform: 'darwin',
                        happyCliVersion: '0.1.0'
                    }
                }
            ],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        useMachineSessionProfilesMock.mockReturnValue({
            ...machineSessionProfiles,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        updateMachineSessionProfilesMock.mockResolvedValue(machineSessionProfiles)
    })

    it('renders the About section', () => {
        renderWithProviders(<SettingsPage />)
        expect(screen.getByText('About')).toBeInTheDocument()
    })

    it('renders the Codex Profiles section', async () => {
        renderWithProviders(<SettingsPage />)

        await waitFor(() => {
            expect(screen.getByText('Codex Profiles')).toBeInTheDocument()
        })

        expect(screen.getByLabelText('Default profile')).toHaveValue('ice')
        expect(screen.getAllByText('Ice').length).toBeGreaterThanOrEqual(1)
    })

    it('saves the selected default profile for the chosen machine', async () => {
        renderWithProviders(<SettingsPage />)

        fireEvent.change(screen.getByLabelText('Default profile'), {
            target: { value: 'focus' }
        })

        await waitFor(() => {
            expect(updateMachineSessionProfilesMock).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-1',
                payload: expect.objectContaining({
                    defaults: { codexProfileId: 'focus' }
                })
            }))
        })
    })

    it('saves edited Codex profile fields', async () => {
        renderWithProviders(<SettingsPage />)

        fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
        fireEvent.change(screen.getByLabelText('Label'), {
            target: { value: 'Ice Updated' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

        await waitFor(() => {
            expect(updateMachineSessionProfilesMock).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-1',
                payload: expect.objectContaining({
                    profiles: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'ice',
                            label: 'Ice Updated'
                        })
                    ])
                })
            }))
        })
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

    it('uses correct i18n keys for About and Codex profiles sections', () => {
        const spyT = renderWithSpyT(<SettingsPage />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.about.title')
        expect(calledKeys).toContain('settings.about.website')
        expect(calledKeys).toContain('settings.about.appVersion')
        expect(calledKeys).toContain('settings.about.protocolVersion')
        expect(calledKeys).toContain('settings.codexProfiles.title')
        expect(calledKeys).toContain('settings.codexProfiles.default')
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
})
