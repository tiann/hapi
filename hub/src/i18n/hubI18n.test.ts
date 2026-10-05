import { describe, expect, it } from 'bun:test'
import { hubPluralCategory, hubT, resolveHubLocale } from './hubI18n'

describe('resolveHubLocale', () => {
    it('maps Russian tags', () => {
        expect(resolveHubLocale('ru')).toBe('ru')
        expect(resolveHubLocale('ru-RU')).toBe('ru')
        expect(resolveHubLocale('RU')).toBe('ru')
        expect(resolveHubLocale('ru_RU')).toBe('ru')
    })

    it('falls back to English', () => {
        expect(resolveHubLocale('en')).toBe('en')
        expect(resolveHubLocale('de-DE')).toBe('en')
        expect(resolveHubLocale(null)).toBe('en')
        expect(resolveHubLocale(undefined)).toBe('en')
    })
})

describe('hubT', () => {
    it('interpolates parameters', () => {
        expect(hubT('en', 'telegram.session', { name: 'deploy' })).toBe('Session: deploy')
        expect(hubT('ru', 'telegram.session', { name: 'deploy' })).toBe('Сессия: deploy')
    })

    it('leaves unknown placeholders intact', () => {
        expect(hubT('en', 'telegram.tool')).toBe('Tool: {tool}')
    })
})

describe('hubPluralCategory', () => {
    it('uses English one/other', () => {
        expect(hubPluralCategory('en', 1)).toBe('one')
        expect(hubPluralCategory('en', 2)).toBe('other')
        expect(hubPluralCategory('en', 11)).toBe('other')
    })

    it('uses Russian CLDR rules', () => {
        expect(hubPluralCategory('ru', 1)).toBe('one')
        expect(hubPluralCategory('ru', 21)).toBe('one')
        expect(hubPluralCategory('ru', 2)).toBe('few')
        expect(hubPluralCategory('ru', 24)).toBe('few')
        expect(hubPluralCategory('ru', 5)).toBe('many')
        expect(hubPluralCategory('ru', 11)).toBe('many')
        expect(hubPluralCategory('ru', 0)).toBe('many')
    })
})
