import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureTelegramWebApp, loadTelegramSdk, normalizeCssColorToHex, syncTelegramWebAppThemeColors } from './useTelegram'

afterEach(() => {
    delete window.Telegram
    document.head.querySelectorAll('script[src="https://telegram.org/js/telegram-web-app.js"]').forEach((script) => script.remove())
    vi.useRealTimers()
})

describe('configureTelegramWebApp', () => {
    it('marks Telegram Mini App ready, expands it, and disables vertical swipe close', () => {
        const ready = vi.fn()
        const expand = vi.fn()
        const disableVerticalSwipes = vi.fn()
        const setHeaderColor = vi.fn()
        const setBackgroundColor = vi.fn()
        const setBottomBarColor = vi.fn()

        window.Telegram = {
            WebApp: {
                initData: 'init-data',
                themeParams: {},
                ready,
                expand,
                disableVerticalSwipes,
                setHeaderColor,
                setBackgroundColor,
                setBottomBarColor,
            },
        }

        configureTelegramWebApp()

        expect(ready).toHaveBeenCalledOnce()
        expect(expand).toHaveBeenCalledOnce()
        expect(disableVerticalSwipes).toHaveBeenCalledOnce()
    })

    it('does nothing when the Telegram SDK is unavailable', () => {
        expect(() => configureTelegramWebApp()).not.toThrow()
    })

    it('supports older Telegram clients without vertical swipe controls', () => {
        const ready = vi.fn()
        const expand = vi.fn()

        window.Telegram = {
            WebApp: {
                initData: 'init-data',
                themeParams: {},
                ready,
                expand,
            },
        }

        configureTelegramWebApp()

        expect(ready).toHaveBeenCalledOnce()
        expect(expand).toHaveBeenCalledOnce()
    })

    it('syncs app background color to Telegram chrome', () => {
        const setHeaderColor = vi.fn()
        const setBackgroundColor = vi.fn()
        const setBottomBarColor = vi.fn()

        window.Telegram = {
            WebApp: {
                initData: 'init-data',
                themeParams: {},
                ready: vi.fn(),
                expand: vi.fn(),
                setHeaderColor,
                setBackgroundColor,
                setBottomBarColor,
            },
        }

        syncTelegramWebAppThemeColors('#123abc')

        expect(setHeaderColor).toHaveBeenCalledWith('#123abc')
        expect(setBackgroundColor).toHaveBeenCalledWith('#123abc')
        expect(setBottomBarColor).toHaveBeenCalledWith('#123abc')
    })

    it('normalizes CSS color values for Telegram APIs', () => {
        expect(normalizeCssColorToHex('#abc')).toBe('#aabbcc')
        expect(normalizeCssColorToHex('rgb(18, 58, 188)')).toBe('#123abc')
        expect(normalizeCssColorToHex('rgba(300, -1, 16, 0.5)')).toBe('#ff0010')
        expect(normalizeCssColorToHex('transparent')).toBeNull()
    })

    it('configures Telegram when the SDK loads after the timeout fallback', async () => {
        vi.useFakeTimers()
        const ready = vi.fn()
        const expand = vi.fn()
        const disableVerticalSwipes = vi.fn()

        const loadPromise = loadTelegramSdk(3000)
        const script = document.head.querySelector<HTMLScriptElement>('script[src="https://telegram.org/js/telegram-web-app.js"]')

        expect(script).not.toBeNull()

        vi.advanceTimersByTime(3000)
        await loadPromise

        window.Telegram = {
            WebApp: {
                initData: 'init-data',
                themeParams: {},
                ready,
                expand,
                disableVerticalSwipes,
            },
        }

        script!.dispatchEvent(new Event('load'))

        expect(ready).toHaveBeenCalledOnce()
        expect(expand).toHaveBeenCalledOnce()
        expect(disableVerticalSwipes).toHaveBeenCalledOnce()
    })

    it('does not emit haptics for programmatic clicks', () => {
        const impactOccurred = vi.fn()
        window.Telegram = {
            WebApp: {
                initData: 'init-data',
                themeParams: {},
                ready: vi.fn(),
                expand: vi.fn(),
                HapticFeedback: {
                    impactOccurred,
                    notificationOccurred: vi.fn(),
                    selectionChanged: vi.fn(),
                },
            },
        }
        const button = document.createElement('button')
        document.body.appendChild(button)

        configureTelegramWebApp()
        button.click()

        expect(impactOccurred).not.toHaveBeenCalled()
        button.remove()
    })
})
