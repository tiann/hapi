import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    DISMISS_COOLDOWN_MS,
    FIRST_PROMPT_DELAY_MS,
    NATIVE_APP_PROMO_STORAGE_KEY,
    detectStorePlatform,
    dismissPromo,
    markPromoFirstSeen,
    releaseLine,
    resetNativeAppPromoStoreForTests,
    shouldShowPromoEntry,
    shouldShowPromoModal,
} from './nativeAppPromo'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

describe('releaseLine', () => {
    it('keeps major.minor', () => {
        expect(releaseLine('0.36.4')).toBe('0.36')
        expect(releaseLine('v1.2.0-beta.1')).toBe('1.2')
        expect(releaseLine('dev')).toBe('dev')
    })
})

describe('promo visibility', () => {
    it('shows the entry until dismissed', () => {
        expect(shouldShowPromoEntry({}, '0.36.4', T0)).toBe(true)
    })

    it('stays dismissed across patch releases', () => {
        const state = { dismissedLine: '0.36', dismissedAt: T0 }
        expect(shouldShowPromoEntry(state, '0.36.9', T0 + 365 * DAY)).toBe(false)
    })

    it('returns on the next minor release only after the cooldown', () => {
        const state = { dismissedLine: '0.36', dismissedAt: T0, firstSeenAt: T0 - 30 * DAY }
        expect(shouldShowPromoEntry(state, '0.37.0', T0 + DAY)).toBe(false)
        expect(shouldShowPromoEntry(state, '0.37.0', T0 + DISMISS_COOLDOWN_MS)).toBe(true)
        expect(shouldShowPromoModal(state, '0.37.0', T0 + DISMISS_COOLDOWN_MS)).toBe(true)
    })

    it('never opens the modal on the first visit', () => {
        expect(shouldShowPromoModal({}, '0.36.4', T0)).toBe(false)
        expect(shouldShowPromoModal({ firstSeenAt: T0 }, '0.36.4', T0 + DAY / 2)).toBe(false)
        expect(shouldShowPromoModal({ firstSeenAt: T0 }, '0.36.4', T0 + FIRST_PROMPT_DELAY_MS)).toBe(true)
    })
})

describe('detectStorePlatform', () => {
    const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints })

    it('maps user agents to stores', () => {
        expect(detectStorePlatform(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'))).toBe('ios')
        expect(detectStorePlatform(nav('Mozilla/5.0 (Linux; Android 15; Pixel 9)'))).toBe('android')
        expect(detectStorePlatform(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'))).toBe('mac')
        expect(detectStorePlatform(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5))).toBe('ios')
        expect(detectStorePlatform(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe('other')
        expect(detectStorePlatform(undefined)).toBe('other')
    })
})

describe('persistence', () => {
    beforeEach(() => {
        localStorage.clear()
        resetNativeAppPromoStoreForTests()
    })
    afterEach(() => localStorage.clear())

    it('records first-seen once and dismissal per release line', () => {
        markPromoFirstSeen(T0)
        markPromoFirstSeen(T0 + DAY)
        dismissPromo('0.36.4', T0 + 2 * DAY)
        expect(JSON.parse(localStorage.getItem(NATIVE_APP_PROMO_STORAGE_KEY) ?? '{}')).toEqual({
            firstSeenAt: T0,
            dismissedLine: '0.36',
            dismissedAt: T0 + 2 * DAY,
        })
    })

    it('ignores corrupt storage', () => {
        localStorage.setItem(NATIVE_APP_PROMO_STORAGE_KEY, '{not json')
        markPromoFirstSeen(T0)
        expect(JSON.parse(localStorage.getItem(NATIVE_APP_PROMO_STORAGE_KEY) ?? '{}')).toEqual({ firstSeenAt: T0 })
    })
})
