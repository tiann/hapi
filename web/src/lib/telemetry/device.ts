import type { TelemetryDeviceKind, TelemetryOriginKind } from '@hapi/protocol/telemetry'
import { DEVICE_STORAGE_KEY } from './state'

/**
 * Device identity & classification (design §4.1 TelemetryDevice).
 *
 * kind priority (研究 §9 开放问题 8 已拍板): android-web 壳标记
 * `window.__HAPI_WEB_SHELL__` → 'berry' > Telegram Mini App → 'telegram' >
 * standalone PWA (navigator.standalone / display-mode) → 'browser'.
 * origin = 延迟分层键(报告 §2.2 六类慢因判别): local / cf-orange / direct.
 */

declare global {
    interface Window {
        /** Injected by the android-web shell (StaticResourceInterceptor) as the
         *  earliest executing script in the served index.html. */
        __HAPI_WEB_SHELL__?: boolean
    }
}

/** CF orange-cloud entry domains (hapi.supertoken.lol …). Keep in sync with 部署拓扑. */
const CF_ORANGE_DOMAINS: readonly string[] = ['supertoken.lol']

/** Keep in sync with hooks/useServerUrl.ts (HUB_URL_KEY) — the SDK re-resolves
 *  the live hub on every send so a settings-side hub switch needs no reinstall. */
const HUB_URL_KEY = 'hapi_hub_url'

export function resolveDeviceKind(): TelemetryDeviceKind {
    try {
        if (typeof window !== 'undefined' && window.__HAPI_WEB_SHELL__ === true) return 'berry'
        if (isTelegramMiniApp()) return 'telegram'
        const nav = navigator as Navigator & { standalone?: boolean }
        if (nav.standalone === true) return 'pwa'
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(display-mode: standalone)').matches) {
            return 'pwa'
        }
    } catch {
        // fall through
    }
    return 'browser'
}

/** Mirrors hooks/useTelegram.ts isTelegramEnvironment (hash/query tgWebApp params). */
function isTelegramMiniApp(): boolean {
    try {
        if (typeof window === 'undefined') return false
        const hash = window.location.hash.slice(1)
        if (hash.includes('tgWebAppData=') || hash.includes('tgWebAppVersion=')) return true
        const query = new URLSearchParams(window.location.search)
        return query.has('tgWebAppData') || query.has('tgWebAppVersion')
    } catch {
        return false
    }
}

export function resolveOriginKind(baseUrl: string): TelemetryOriginKind {
    try {
        const url = new URL(baseUrl)
        const host = url.hostname
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return 'local'
        if (CF_ORANGE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 'cf-orange'
        return 'direct'
    } catch {
        return 'direct'
    }
}

/**
 * Live hub base URL, same priority as useServerUrl (?hub= param > localStorage
 * `hapi_hub_url` > install-time fallback > location.origin). Re-resolved at
 * every send so hub switches are picked up without touching App.tsx.
 */
export function resolveLiveBaseUrl(installedFallback: string): string {
    try {
        if (typeof window === 'undefined') return installedFallback
        const fromQuery = new URLSearchParams(window.location.search).get('hub')
        const candidates = [fromQuery, localStorage.getItem(HUB_URL_KEY)]
        for (const raw of candidates) {
            if (!raw) continue
            try {
                const parsed = new URL(raw.trim())
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
            } catch {
                // ignore malformed values
            }
        }
    } catch {
        // storage unavailable
    }
    if (installedFallback) return installedFallback
    try {
        return window.location.origin
    } catch {
        return ''
    }
}

/** localStorage-persisted device id (crypto.randomUUID, generated once). */
export function getOrCreateDeviceId(): string {
    let stored: string | null = null
    try {
        stored = localStorage.getItem(DEVICE_STORAGE_KEY)
        if (stored && stored.length >= 16 && stored.length <= 128) return stored
    } catch {
        // storage unavailable — fall through to ephemeral id
    }
    const id = randomTelemetryId()
    try {
        localStorage.setItem(DEVICE_STORAGE_KEY, id)
    } catch {
        // private mode / quota: keep the ephemeral id for this page lifetime
    }
    return id
}

export function randomTelemetryId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID()
        }
    } catch {
        // fall through
    }
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Vite injects __APP_VERSION__ (web/vite.config.ts define); guard for non-Vite contexts. */
export function telemetryAppVersion(): string {
    try {
        if (typeof __APP_VERSION__ !== 'undefined') return __APP_VERSION__
    } catch {
        // not defined in this context
    }
    const envVersion = import.meta.env.VITE_APP_VERSION
    return typeof envVersion === 'string' && envVersion ? envVersion : 'unknown'
}
