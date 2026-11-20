import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateDeviceId, resolveDeviceKind, resolveLiveBaseUrl, resolveOriginKind, telemetryAppVersion } from './device'
import { DEVICE_STORAGE_KEY } from './state'

/**
 * Device identity: kind priority (berry marker > telegram > pwa > browser),
 * origin classification (local / cf-orange / direct), live baseUrl
 * re-resolution and the persisted device id.
 */

const originalMatchMedia = window.matchMedia

afterEach(() => {
    window.matchMedia = originalMatchMedia
    try {
        delete (window as unknown as { __HAPI_WEB_SHELL__?: boolean }).__HAPI_WEB_SHELL__
    } catch {
        // ignore
    }
    window.location.hash = ''
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    vi.unstubAllGlobals()
})

describe('resolveDeviceKind priority', () => {
    it('berry: the android-web shell marker wins over everything', () => {
        window.matchMedia = (() => ({
            matches: true, // standalone too — berry still wins
            media: '',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        })) as typeof window.matchMedia
        window.location.hash = '#tgWebAppData=x'
        ;(window as unknown as { __HAPI_WEB_SHELL__?: boolean }).__HAPI_WEB_SHELL__ = true
        expect(resolveDeviceKind()).toBe('berry')
    })

    it('telegram: Mini App launch params beat pwa signals', () => {
        window.location.hash = '#tgWebAppVersion=8&tgWebAppData=x'
        expect(resolveDeviceKind()).toBe('telegram')
    })

    it('pwa: navigator.standalone', () => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
        try {
            expect(resolveDeviceKind()).toBe('pwa')
        } finally {
            delete (navigator as Navigator & { standalone?: boolean }).standalone
        }
    })

    it('pwa: display-mode standalone via matchMedia', () => {
        window.matchMedia = ((query: string) => ({
            matches: query.includes('standalone'),
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        })) as typeof window.matchMedia
        expect(resolveDeviceKind()).toBe('pwa')
    })

    it('browser: plain jsdom default', () => {
        expect(resolveDeviceKind()).toBe('browser')
    })
})

describe('resolveOriginKind', () => {
    it('classifies localhost as local', () => {
        expect(resolveOriginKind('http://localhost:5173')).toBe('local')
        expect(resolveOriginKind('http://127.0.0.1:3006')).toBe('local')
    })

    it('classifies known CF orange-cloud domains', () => {
        expect(resolveOriginKind('https://hapi.supertoken.lol')).toBe('cf-orange')
        expect(resolveOriginKind('https://x.y.supertoken.lol')).toBe('cf-orange')
    })

    it('classifies direct-origin hubs (nip.io 直连)', () => {
        expect(resolveOriginKind('https://hapi.38.76.198.224.nip.io')).toBe('direct')
        expect(resolveOriginKind('https://chat.flyme.chat:8443')).toBe('direct')
    })

    it('garbage falls back to direct', () => {
        expect(resolveOriginKind('not a url')).toBe('direct')
    })
})

describe('resolveLiveBaseUrl', () => {
    it('prefers ?hub=, then localStorage hapi_hub_url, then the fallback', () => {
        localStorage.setItem('hapi_hub_url', 'https://stored.example')
        expect(resolveLiveBaseUrl('https://fallback.example')).toBe('https://stored.example')
        window.history.replaceState(null, '', '/?hub=https%3A%2F%2Fquery.example%2F')
        expect(resolveLiveBaseUrl('https://fallback.example')).toBe('https://query.example')
        localStorage.removeItem('hapi_hub_url')
        window.history.replaceState(null, '', '/')
        expect(resolveLiveBaseUrl('https://fallback.example')).toBe('https://fallback.example')
        expect(resolveLiveBaseUrl('')).toBe(window.location.origin)
    })
})

describe('device identity', () => {
    it('generates once and persists under hapi:telemetry:device:v1', () => {
        const first = getOrCreateDeviceId()
        expect(first).toBe(localStorage.getItem(DEVICE_STORAGE_KEY))
        expect(getOrCreateDeviceId()).toBe(first)
    })

    it('regenerates when the stored value is garbage', () => {
        localStorage.setItem(DEVICE_STORAGE_KEY, 'x')
        const id = getOrCreateDeviceId()
        expect(id).not.toBe('x')
        expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(id)
    })
})

describe('appVersion', () => {
    it('uses the vite-injected __APP_VERSION__', () => {
        expect(telemetryAppVersion()).toBe(__APP_VERSION__)
        expect(typeof telemetryAppVersion()).toBe('string')
    })
})
