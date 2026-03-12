import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from './i18n-context'
import { useTranslation } from './use-translation'

function LocaleProbe() {
    const { locale, t, setLocale } = useTranslation()

    return (
        <>
            <div data-testid="locale">{locale}</div>
            <div data-testid="title">{t('login.submit')}</div>
            <button type="button" onClick={() => setLocale('en')}>
                switch-en
            </button>
        </>
    )
}

describe('I18nProvider default locale', () => {
    beforeEach(() => {
        cleanup()
        localStorage.clear()
        document.documentElement.lang = ''
    })

    it('defaults to zh-CN when no saved locale exists', () => {
        render(
            <I18nProvider>
                <LocaleProbe />
            </I18nProvider>
        )

        expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN')
        expect(screen.getByTestId('title')).toHaveTextContent('登录')
        expect(document.documentElement.lang).toBe('zh-CN')
    })

    it('keeps saved english locale when present', () => {
        localStorage.setItem('zs-lang', 'en')

        render(
            <I18nProvider>
                <LocaleProbe />
            </I18nProvider>
        )

        expect(screen.getByTestId('locale')).toHaveTextContent('en')
        expect(screen.getByTestId('title')).toHaveTextContent('Sign In')
        expect(document.documentElement.lang).toBe('en')
    })

    it('keeps saved chinese locale when present', () => {
        localStorage.setItem('zs-lang', 'zh-CN')

        render(
            <I18nProvider>
                <LocaleProbe />
            </I18nProvider>
        )

        expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN')
        expect(screen.getByTestId('title')).toHaveTextContent('登录')
        expect(document.documentElement.lang).toBe('zh-CN')
    })

    it('persists user-selected locale after switching', () => {
        render(
            <I18nProvider>
                <LocaleProbe />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'switch-en' }))

        expect(screen.getByTestId('locale')).toHaveTextContent('en')
        expect(screen.getByTestId('title')).toHaveTextContent('Sign In')
        expect(localStorage.getItem('zs-lang')).toBe('en')
        expect(document.documentElement.lang).toBe('en')
    })
})
