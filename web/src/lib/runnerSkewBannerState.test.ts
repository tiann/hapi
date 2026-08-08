import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    clearRunnerSkewTempDismiss,
    isRunnerSkewMinimized,
    isRunnerSkewTempDismissed,
    resetRunnerSkewBannerMemoryForTests,
    runnerSkewBannerScope,
    setRunnerSkewMinimized,
    tempDismissRunnerSkew,
} from './runnerSkewBannerState'

const SCOPE_A = runnerSkewBannerScope('http://hub-a.example', 'default')
const SCOPE_B = runnerSkewBannerScope('http://hub-b.example', 'default')

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
        setRunnerSkewMinimized(SCOPE_A, true)
        expect(isRunnerSkewMinimized(SCOPE_A)).toBe(true)
        expect(window.sessionStorage.getItem(`hapi.runnerSkew.minimized.v1.${encodeURIComponent(SCOPE_A)}`)).toBe('1')
    })

    it('keeps minimize/dismiss independent per hub scope', () => {
        setRunnerSkewMinimized(SCOPE_A, true)
        tempDismissRunnerSkew(SCOPE_A, 1_700_000_000_000)
        expect(isRunnerSkewMinimized(SCOPE_A)).toBe(true)
        expect(isRunnerSkewTempDismissed(SCOPE_A, 1_700_000_000_001)).toBe(true)
        expect(isRunnerSkewMinimized(SCOPE_B)).toBe(false)
        expect(isRunnerSkewTempDismissed(SCOPE_B, 1_700_000_000_001)).toBe(false)
    })

    it('still minimizes when sessionStorage setItem throws QuotaExceededError', () => {
        const proto = Object.getPrototypeOf(window.sessionStorage) as Storage
        vi.spyOn(proto, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError')
        })

        expect(() => setRunnerSkewMinimized(SCOPE_A, true)).not.toThrow()
        expect(isRunnerSkewMinimized(SCOPE_A)).toBe(true)
        expect(isRunnerSkewMinimized(SCOPE_B)).toBe(false)
    })

    it('still temp-dismisses when sessionStorage is full', () => {
        const proto = Object.getPrototypeOf(window.sessionStorage) as Storage
        vi.spyOn(proto, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError')
        })

        const now = 1_700_000_000_000
        expect(() => tempDismissRunnerSkew(SCOPE_A, now)).not.toThrow()
        expect(isRunnerSkewTempDismissed(SCOPE_A, now + 1)).toBe(true)
        clearRunnerSkewTempDismiss(SCOPE_A)
        expect(isRunnerSkewTempDismissed(SCOPE_A, now + 1)).toBe(false)
    })
})
