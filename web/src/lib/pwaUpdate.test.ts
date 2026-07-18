import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS,
    SERVICE_WORKER_REFRESH_INTERVAL_MS,
    handleNeedRefresh,
    scheduleServiceWorkerRefresh
} from './pwaUpdate'

type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches'>

function matchMediaFor(activeQueries: string[]): MatchMedia {
    return (query: string) => ({ matches: activeQueries.includes(query) })
}

describe('handleNeedRefresh', () => {
    it('prompts before reloading updates for touch/mobile-like environments', async () => {
        const updateSW = vi.fn(async () => {})
        const confirmReload = vi.fn(() => false)

        await handleNeedRefresh(updateSW, {
            confirmReload,
            matchMedia: matchMediaFor(['(pointer: coarse)']),
            navigator: { standalone: false } as Navigator & { standalone?: boolean },
        })

        expect(confirmReload).toHaveBeenCalledTimes(1)
        expect(updateSW).not.toHaveBeenCalled()
    })

    it('prompts before reloading updates when installed as a standalone app', async () => {
        const updateSW = vi.fn(async () => {})
        const confirmReload = vi.fn(() => true)

        await handleNeedRefresh(updateSW, {
            confirmReload,
            matchMedia: matchMediaFor(['(display-mode: standalone)']),
            navigator: { standalone: false } as Navigator & { standalone?: boolean },
        })

        expect(confirmReload).toHaveBeenCalledTimes(1)
        expect(updateSW).toHaveBeenCalledWith(true)
    })

    it('keeps desktop confirm flow when not in mobile or standalone mode', async () => {
        const updateSW = vi.fn(async () => {})
        const confirmReload = vi.fn(() => true)

        await handleNeedRefresh(updateSW, {
            confirmReload,
            matchMedia: matchMediaFor([]),
            navigator: { standalone: false } as Navigator & { standalone?: boolean },
        })

        expect(confirmReload).toHaveBeenCalledTimes(1)
        expect(updateSW).toHaveBeenCalledWith(true)
    })

    it('does not reload on desktop when the user declines the prompt', async () => {
        const updateSW = vi.fn(async () => {})
        const confirmReload = vi.fn(() => false)

        await handleNeedRefresh(updateSW, {
            confirmReload,
            matchMedia: matchMediaFor([]),
            navigator: { standalone: false } as Navigator & { standalone?: boolean },
        })

        expect(updateSW).not.toHaveBeenCalled()
    })
})

describe('scheduleServiceWorkerRefresh', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('delays update checks, refreshes periodically, and schedules a visible-page check', async () => {
        vi.useFakeTimers()
        const update = vi.fn(async () => undefined)
        const listeners = new Map<string, () => void>()
        const setIntervalSpy = vi.fn((callback: () => void, delay: number) => {
            return setInterval(callback, delay)
        })
        const setTimeoutSpy = vi.fn((callback: () => void, delay: number) => {
            return setTimeout(callback, delay)
        })
        let visibilityState: DocumentVisibilityState = 'hidden'

        scheduleServiceWorkerRefresh({ update } as unknown as ServiceWorkerRegistration, {
            document: {
                addEventListener: vi.fn((event: string, callback: () => void) => {
                    listeners.set(event, callback)
                }),
                get visibilityState() {
                    return visibilityState
                },
            },
            setInterval: setIntervalSpy,
            setTimeout: setTimeoutSpy,
        })

        expect(update).not.toHaveBeenCalled()
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS)
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), SERVICE_WORKER_REFRESH_INTERVAL_MS)

        await vi.advanceTimersByTimeAsync(SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS)
        expect(update).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(SERVICE_WORKER_REFRESH_INTERVAL_MS)
        expect(update).toHaveBeenCalledTimes(2)

        visibilityState = 'visible'
        listeners.get('visibilitychange')?.()
        expect(update).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS)
        expect(update).toHaveBeenCalledTimes(3)
    })

    it('swallows registration update failures', async () => {
        vi.useFakeTimers()
        const update = vi.fn(async () => {
            throw new Error('network down')
        })

        expect(() => scheduleServiceWorkerRefresh({ update } as unknown as ServiceWorkerRegistration, {
            document,
            setInterval,
        })).not.toThrow()

        await vi.runOnlyPendingTimersAsync()
        expect(update).toHaveBeenCalled()
    })
})
