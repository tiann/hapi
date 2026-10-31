import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from './i18n-context'
import { useTranslation } from './use-translation'
import { translateInputRequestTitle } from './input-request-toast'

describe('input request toast title', () => {
    beforeEach(() => localStorage.clear())

    it.each([
        ['en', 'Codex needs your input'],
        ['zh-CN', 'Codex 需要你回答']
    ])('localizes the title in %s', (locale, expected) => {
        localStorage.setItem('hapi-lang', locale)
        const { result } = renderHook(() => useTranslation(), { wrapper: I18nProvider })
        expect(translateInputRequestTitle(' Codex needs your input ', result.current.t)).toBe(expected)
    })

    it('leaves approval, ready, task and arbitrary titles on their existing paths', () => {
        const { result } = renderHook(() => useTranslation(), { wrapper: I18nProvider })
        for (const title of ['Permission Request', 'Ready for input', 'Task completed', 'Task failed', 'Custom title']) {
            expect(translateInputRequestTitle(title, result.current.t)).toBeNull()
        }
    })
})
