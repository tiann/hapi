import { useCallback, useSyncExternalStore } from 'react'

/**
 * Native-app promo: nudges web users toward the paid App Store / Google Play
 * apps, framed as "HAPI is fully open source; the app is how you support it".
 *
 * Frequency rules (patterned on store banners and rating prompts that avoid
 * nagging):
 *   - Never on the very first visit: the modal waits FIRST_PROMPT_DELAY_MS
 *     after the browser first opened HAPI, so it never interrupts setup.
 *   - Dismissal holds for the whole release line (`major.minor`): patch
 *     releases never bring it back; the next minor release may.
 *   - Even across release lines, a dismissal suppresses for
 *     DISMISS_COOLDOWN_MS so frequent minor releases cannot turn into nagging.
 */

export const APP_STORE_URL = 'https://apps.apple.com/app/id6805699104'
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=run.hapi.companion'
/** Website section listing both store badges — used for the desktop QR code. */
export const NATIVE_APPS_PAGE_URL = 'https://hapi.run/#apps'

export const NATIVE_APP_PROMO_STORAGE_KEY = 'hapi.nativeAppPromo.v1'
export const FIRST_PROMPT_DELAY_MS = 24 * 60 * 60 * 1000
export const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000

export type NativeAppPromoState = {
    firstSeenAt?: number
    dismissedLine?: string
    dismissedAt?: number
}

export type StorePlatform = 'ios' | 'android' | 'mac' | 'other'

/** `0.36.4` → `0.36`. Unparseable versions are their own line. */
export function releaseLine(version: string): string {
    const match = version.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)/)
    return match ? `${match[1]}.${match[2]}` : version
}

export function isPromoDismissed(state: NativeAppPromoState, version: string, now: number): boolean {
    if (state.dismissedLine === undefined && state.dismissedAt === undefined) return false
    if (state.dismissedLine === releaseLine(version)) return true
    return state.dismissedAt !== undefined && now - state.dismissedAt < DISMISS_COOLDOWN_MS
}

/** Unobtrusive entry points (desktop header icon) only need "not dismissed". */
export function shouldShowPromoEntry(state: NativeAppPromoState, version: string, now: number): boolean {
    return !isPromoDismissed(state, version, now)
}

/** The interrupting modal additionally waits until this is not the first visit. */
export function shouldShowPromoModal(state: NativeAppPromoState, version: string, now: number): boolean {
    if (isPromoDismissed(state, version, now)) return false
    return state.firstSeenAt !== undefined && now - state.firstSeenAt >= FIRST_PROMPT_DELAY_MS
}

export function detectStorePlatform(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined): StorePlatform {
    if (!nav) return 'other'
    const ua = nav.userAgent
    if (/Android/i.test(ua)) return 'android'
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
    if (/Macintosh/.test(ua)) {
        // iPadOS Safari reports a desktop Mac UA; touch support gives it away.
        return (nav.maxTouchPoints ?? 0) > 1 ? 'ios' : 'mac'
    }
    return 'other'
}

// --- persisted state + shared store -----------------------------------------

function parseState(raw: string | null): NativeAppPromoState {
    if (!raw) return {}
    try {
        const value = JSON.parse(raw) as unknown
        if (!value || typeof value !== 'object') return {}
        const record = value as Record<string, unknown>
        const state: NativeAppPromoState = {}
        if (typeof record.firstSeenAt === 'number') state.firstSeenAt = record.firstSeenAt
        if (typeof record.dismissedLine === 'string') state.dismissedLine = record.dismissedLine
        if (typeof record.dismissedAt === 'number') state.dismissedAt = record.dismissedAt
        return state
    } catch {
        return {}
    }
}

function readRaw(): string | null {
    try {
        return window.localStorage.getItem(NATIVE_APP_PROMO_STORAGE_KEY)
    } catch {
        return null
    }
}

let cachedRaw: string | null | undefined
let cachedState: NativeAppPromoState = {}
const listeners = new Set<() => void>()

function getSnapshot(): NativeAppPromoState {
    const raw = typeof window === 'undefined' ? null : readRaw()
    if (raw !== cachedRaw) {
        cachedRaw = raw
        cachedState = parseState(raw)
    }
    return cachedState
}

function writeState(next: NativeAppPromoState): void {
    try {
        window.localStorage.setItem(NATIVE_APP_PROMO_STORAGE_KEY, JSON.stringify(next))
    } catch {
        // Storage unavailable: the promo simply reappears next load.
        cachedRaw = JSON.stringify(next)
        cachedState = next
    }
    listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    const onStorage = (event: StorageEvent) => {
        if (event.key === NATIVE_APP_PROMO_STORAGE_KEY) listener()
    }
    window.addEventListener('storage', onStorage)
    return () => {
        listeners.delete(listener)
        window.removeEventListener('storage', onStorage)
    }
}

/** Record the first visit once; later calls are no-ops. */
export function markPromoFirstSeen(now: number = Date.now()): void {
    const state = getSnapshot()
    if (state.firstSeenAt !== undefined) return
    writeState({ ...state, firstSeenAt: now })
}

export function dismissPromo(version: string, now: number = Date.now()): void {
    writeState({ ...getSnapshot(), dismissedLine: releaseLine(version), dismissedAt: now })
}

export function useNativeAppPromo(version: string = __APP_VERSION__): {
    state: NativeAppPromoState
    showEntry: boolean
    showModal: boolean
    dismiss: () => void
} {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const now = Date.now()
    const dismiss = useCallback(() => dismissPromo(version), [version])
    return {
        state,
        showEntry: shouldShowPromoEntry(state, version, now),
        showModal: shouldShowPromoModal(state, version, now),
        dismiss,
    }
}

/** Test helper. */
export function resetNativeAppPromoStoreForTests(): void {
    cachedRaw = undefined
    cachedState = {}
}
