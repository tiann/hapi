import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { LanguageSwitcher } from './LanguageSwitcher'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: vi.fn()
}))

import { useTranslation } from '@/lib/use-translation'

describe('LanguageSwitcher', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders language button', () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        expect(screen.getByLabelText('language.title')).toBeInTheDocument()
    })

    it('opens dropdown when button clicked', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        expect(screen.getByText('English')).toBeInTheDocument()
        expect(screen.getByText('简体中文')).toBeInTheDocument()
    })

    it('closes dropdown when clicking outside', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(
            <div>
                <LanguageSwitcher />
                <div data-testid="outside">Outside</div>
            </div>
        )

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        expect(screen.getByText('English')).toBeInTheDocument()

        const outside = screen.getByTestId('outside')
        fireEvent.mouseDown(outside)

        expect(screen.queryByText('English')).not.toBeInTheDocument()
    })

    it('calls setLocale when selecting a language', async () => {
        const setLocale = vi.fn()
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale,
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        const zhOption = screen.getByText('简体中文')
        fireEvent.click(zhOption)

        expect(setLocale).toHaveBeenCalledWith('zh-CN')
    })

    it('closes dropdown after selecting a language', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        const zhOption = screen.getByText('简体中文')
        fireEvent.click(zhOption)

        expect(screen.queryByText('简体中文')).not.toBeInTheDocument()
    })

    it('marks current locale as selected', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'zh-CN',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        const zhOption = screen.getByRole('option', { name: /简体中文/ })
        expect(zhOption).toHaveAttribute('aria-selected', 'true')

        const enOption = screen.getByRole('option', { name: /English/ })
        expect(enOption).toHaveAttribute('aria-selected', 'false')
    })

    it('displays check icon for selected language', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        const { container } = render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        fireEvent.click(button)

        const svgs = container.querySelectorAll('svg')
        expect(svgs.length).toBeGreaterThan(1) // Language icon + check icon
    })

    it('toggles dropdown on button click', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')

        // Open
        fireEvent.click(button)
        expect(screen.getByText('English')).toBeInTheDocument()

        // Close
        fireEvent.click(button)
        expect(screen.queryByText('English')).not.toBeInTheDocument()
    })

    it('sets aria-expanded correctly', async () => {
        vi.mocked(useTranslation).mockReturnValue({
            locale: 'en',
            setLocale: vi.fn(),
            t: (key: string) => key
        })

        render(<LanguageSwitcher />)

        const button = screen.getByLabelText('language.title')
        expect(button).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(button)
        expect(button).toHaveAttribute('aria-expanded', 'true')
    })
})
