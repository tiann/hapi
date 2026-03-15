import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsPage } from './SettingsPage'

// Mock dependencies
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
        locale: 'en',
        setLocale: vi.fn(),
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/shared/hooks/useFontScale', () => ({
    useFontScale: () => ({
        fontScale: 1,
        setFontScale: vi.fn(),
    }),
    getFontScaleOptions: () => [
        { value: 0.875, label: '87.5%' },
        { value: 1, label: '100%' },
        { value: 1.125, label: '112.5%' },
    ],
}))

vi.mock('@/shared/hooks/useTheme', () => ({
    useAppearance: () => ({
        appearance: 'system',
        setAppearance: vi.fn(),
    }),
    getAppearanceOptions: () => [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ],
}))

describe('SettingsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('renders the page', () => {
        render(<SettingsPage />)
        expect(screen.getByText('settings.title')).toBeInTheDocument()
    })

    it('renders language section', () => {
        render(<SettingsPage />)
        expect(screen.getAllByText('settings.language.title')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.language.label')[0]).toBeInTheDocument()
    })

    it('renders display section', () => {
        render(<SettingsPage />)
        expect(screen.getAllByText('settings.display.title')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.display.appearance')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.display.fontSize')[0]).toBeInTheDocument()
    })

    it('renders about section', () => {
        render(<SettingsPage />)
        expect(screen.getAllByText('settings.about.title')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.about.website')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.about.appVersion')[0]).toBeInTheDocument()
        expect(screen.getAllByText('settings.about.protocolVersion')[0]).toBeInTheDocument()
    })

    it('renders back button', () => {
        render(<SettingsPage />)
        const backButtons = screen.getAllByRole('button')
        expect(backButtons.length).toBeGreaterThan(0)
    })

    it('displays website link', () => {
        render(<SettingsPage />)
        const links = screen.getAllByRole('link', { name: 'hapi.run' })
        expect(links[0]).toHaveAttribute('href', 'https://hapi.run')
        expect(links[0]).toHaveAttribute('target', '_blank')
        expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer')
    })
})
