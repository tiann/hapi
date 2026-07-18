import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    clearRunnerSkewTempDismiss,
    isRunnerSkewMinimized,
    isRunnerSkewTempDismissed,
    resetRunnerSkewBannerMemoryForTests,
    setRunnerSkewMinimized,
    tempDismissRunnerSkew,
} from './runnerSkewBannerState'

describe('runnerSkewBannerState', () => {
    beforeEach(() => {
        window.sessionStorage.clear()
        resetRunnerSkewBannerMemoryForTests()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        window.sessionStorage.clear()
        resetRunnerSkewBannerMemoryForTests()
    })

    it('persists minimize to sessionStorage', () => {
        setRunnerSkewMinimized(true)
        expect(isRunnerSkewMinimized()).toBe(true)
        expect(window.sessionStorage.getItem('hapi.runnerSkew.minimized.v1')).toBe('1')
    })

    it('still minimizes when sessionStorage setItem throws QuotaExceededError', () => {
        const proto = Object.getPrototypeOf(window.sessionStorage) as Storage
        vi.spyOn(proto, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError')
        })

        expect(() => setRunnerSkewMinimized(true)).not.toThrow()
        expect(isRunnerSkewMinimized()).toBe(true)
    })

    it('still temp-dismisses when sessionStorage is full', () => {
        const proto = Object.getPrototypeOf(window.sessionStorage) as Storage
        vi.spyOn(proto, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError')
        })

        const now = 1_700_000_000_000
        expect(() => tempDismissRunnerSkew(now)).not.toThrow()
        expect(isRunnerSkewTempDismissed(now + 1)).toBe(true)
        clearRunnerSkewTempDismiss()
        expect(isRunnerSkewTempDismissed(now + 1)).toBe(false)
    })
})
