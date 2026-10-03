import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    cliT,
    getCliLocale,
    normalizeCliLocale,
    readSettingsLanguage,
    resolveCliLocale,
    setCliLocale
} from './cliI18n'

const tempDirs: string[] = []

afterEach(() => {
    setCliLocale(null)
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('normalizeCliLocale', () => {
    it('maps Russian tags', () => {
        expect(normalizeCliLocale('ru')).toBe('ru')
        expect(normalizeCliLocale('ru-RU')).toBe('ru')
        expect(normalizeCliLocale('RU')).toBe('ru')
        expect(normalizeCliLocale('ru_RU.UTF-8')).toBe('ru')
        expect(normalizeCliLocale('ru.UTF-8')).toBe('ru')
    })

    it('maps English tags', () => {
        expect(normalizeCliLocale('en')).toBe('en')
        expect(normalizeCliLocale('en_US.UTF-8')).toBe('en')
        expect(normalizeCliLocale('en_US@euro')).toBe('en')
    })

    it('ignores C/POSIX and unsupported locales', () => {
        expect(normalizeCliLocale('C')).toBeNull()
        expect(normalizeCliLocale('C.UTF-8')).toBeNull()
        expect(normalizeCliLocale('POSIX')).toBeNull()
        expect(normalizeCliLocale('de_DE.UTF-8')).toBeNull()
        expect(normalizeCliLocale('de.UTF-8')).toBeNull()
        expect(normalizeCliLocale('')).toBeNull()
        expect(normalizeCliLocale(null)).toBeNull()
        expect(normalizeCliLocale(undefined)).toBeNull()
    })
})

describe('resolveCliLocale', () => {
    it('prefers HAPI_LANG over everything else', () => {
        expect(
            resolveCliLocale(
                { HAPI_LANG: 'ru', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
                'en'
            )
        ).toBe('ru')
    })

    it('prefers the settings language over the POSIX environment', () => {
        expect(resolveCliLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }, 'ru')).toBe('ru')
    })

    it('uses LC_ALL, then LC_MESSAGES, then LANG', () => {
        expect(resolveCliLocale({ LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ru')
        expect(resolveCliLocale({ LC_MESSAGES: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ru')
        expect(resolveCliLocale({ LANG: 'ru_RU.UTF-8' })).toBe('ru')
    })

    it('lets a set LC_ALL win over LANG even when it is C', () => {
        expect(resolveCliLocale({ LC_ALL: 'C', LANG: 'ru_RU.UTF-8' })).toBe('en')
        expect(resolveCliLocale({ LC_MESSAGES: 'C.UTF-8', LANG: 'ru_RU.UTF-8' })).toBe('en')
    })

    it('ignores an unsupported HAPI_LANG and still uses the POSIX locale', () => {
        expect(resolveCliLocale({ HAPI_LANG: 'de', LANG: 'ru_RU.UTF-8' })).toBe('ru')
    })

    it('falls back to English for C or unsupported locales', () => {
        expect(resolveCliLocale({ LC_ALL: 'C.UTF-8', LANG: 'de_DE.UTF-8' })).toBe('en')
        expect(resolveCliLocale({}, 'de')).toBe('en')
    })
})

describe('readSettingsLanguage', () => {
    it('reads the language field', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-cli-i18n-'))
        tempDirs.push(dir)
        const file = join(dir, 'settings.json')
        writeFileSync(file, JSON.stringify({ language: 'ru', machineId: 'x' }))

        expect(readSettingsLanguage(file)).toBe('ru')
    })

    it('returns null for a missing, malformed or language-less file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-cli-i18n-'))
        tempDirs.push(dir)

        expect(readSettingsLanguage(join(dir, 'missing.json'))).toBeNull()

        const malformed = join(dir, 'malformed.json')
        writeFileSync(malformed, '{ not json')
        expect(readSettingsLanguage(malformed)).toBeNull()

        const withoutLanguage = join(dir, 'no-language.json')
        writeFileSync(withoutLanguage, JSON.stringify({ machineId: 'x' }))
        expect(readSettingsLanguage(withoutLanguage)).toBeNull()
    })
})

describe('cliT', () => {
    it('returns English by default', () => {
        setCliLocale('en')

        expect(getCliLocale()).toBe('en')
        expect(cliT('common.error')).toBe('Error:')
    })

    it('translates and interpolates for Russian', () => {
        setCliLocale('ru')

        expect(cliT('auth.prompt.token')).toBe('Введите CLI_API_TOKEN: ')
        expect(cliT('auth.error.unknownSubcommand', { subcommand: 'nope' })).toBe(
            'Неизвестная подкоманда auth: nope'
        )
    })

    it('falls back to English and then to the key', () => {
        setCliLocale('ru')

        expect(cliT('not.a.key')).toBe('not.a.key')
    })
})
