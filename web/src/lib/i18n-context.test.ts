import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    applyLateTelegramLocale,
    detectInitialLocale,
    normalizeLocaleTag,
    resolveLateTelegramLocale
} from './i18n-context'

function setTelegramLanguage(code: string | undefined) {
    if (code === undefined) {
        delete (window as unknown as { Telegram?: unknown }).Telegram
        return
    }
    ;(window as unknown as { Telegram?: unknown }).Telegram = {
        WebApp: { initDataUnsafe: { user: { language_code: code } } }
    }
}

beforeEach(() => {
    localStorage.clear()
    setTelegramLanguage(undefined)
})

afterEach(() => {
    localStorage.clear()
    setTelegramLanguage(undefined)
    vi.restoreAllMocks()
})

describe('normalizeLocaleTag', () => {
    it('maps Russian tags', () => {
        expect(normalizeLocaleTag('ru')).toBe('ru')
        expect(normalizeLocaleTag('ru-RU')).toBe('ru')
        expect(normalizeLocaleTag('RU')).toBe('ru')
        expect(normalizeLocaleTag('ru_RU')).toBe('ru')
    })

    it('maps Chinese tags to the simplified locale we ship', () => {
        expect(normalizeLocaleTag('zh')).toBe('zh-CN')
        expect(normalizeLocaleTag('zh-Hans')).toBe('zh-CN')
        expect(normalizeLocaleTag('zh-CN')).toBe('zh-CN')
        expect(normalizeLocaleTag('zh_CN')).toBe('zh-CN')
    })

    it('maps English tags', () => {
        expect(normalizeLocaleTag('en')).toBe('en')
        expect(normalizeLocaleTag('en-US')).toBe('en')
    })

    it('rejects unsupported or empty tags', () => {
        expect(normalizeLocaleTag('de')).toBeNull()
        expect(normalizeLocaleTag('')).toBeNull()
        expect(normalizeLocaleTag(null)).toBeNull()
        expect(normalizeLocaleTag(undefined)).toBeNull()
    })
})

describe('detectInitialLocale', () => {
    it('prefers an explicit stored choice over Telegram', () => {
        localStorage.setItem('hapi-lang', 'en')
        setTelegramLanguage('ru')

        expect(detectInitialLocale()).toBe('en')
    })

    it('uses the Telegram Mini App language when nothing is stored', () => {
        setTelegramLanguage('ru')

        expect(detectInitialLocale()).toBe('ru')
    })

    it('normalizes the Telegram language tag', () => {
        setTelegramLanguage('zh-hans')

        expect(detectInitialLocale()).toBe('zh-CN')
    })

    it('falls back to the browser language', () => {
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('ru-RU')

        expect(detectInitialLocale()).toBe('ru')
    })

    it('falls back to English for unsupported languages', () => {
        setTelegramLanguage('de')
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE')

        expect(detectInitialLocale()).toBe('en')
    })
})

describe('resolveLateTelegramLocale', () => {
    it('picks up the language when the SDK appears after the timeout', async () => {
        vi.useFakeTimers()
        setTelegramLanguage(undefined)

        const pending = resolveLateTelegramLocale(500, 5)
        await vi.advanceTimersByTimeAsync(1500)
        setTelegramLanguage('ru')
        await vi.advanceTimersByTimeAsync(500)

        await expect(pending).resolves.toBe('ru')
        vi.useRealTimers()
    })

    it('resolves null when the SDK never loads', async () => {
        vi.useFakeTimers()
        setTelegramLanguage(undefined)

        const pending = resolveLateTelegramLocale(500, 2)
        await vi.advanceTimersByTimeAsync(1500)

        await expect(pending).resolves.toBeNull()
        vi.useRealTimers()
    })
})

describe('applyLateTelegramLocale', () => {
    it('applies the detected locale when nothing is stored', () => {
        const apply = vi.fn()

        expect(applyLateTelegramLocale('ru', apply)).toBe(true)
        expect(apply).toHaveBeenCalledWith('ru')
    })

    it('does not override a manual choice made while the SDK loaded', () => {
        localStorage.setItem('hapi-lang', 'en')
        const apply = vi.fn()

        expect(applyLateTelegramLocale('ru', apply)).toBe(false)
        expect(apply).not.toHaveBeenCalled()
    })

    it('ignores a null detection', () => {
        const apply = vi.fn()

        expect(applyLateTelegramLocale(null, apply)).toBe(false)
        expect(apply).not.toHaveBeenCalled()
    })
})
