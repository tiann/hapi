import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { deliverWithActivationRetry } from './deliverWithActivationRetry'

function sessionInactiveError(): ApiError {
    return new ApiError('HTTP 409', 409, 'session_inactive', JSON.stringify({ error: 'Session is inactive', code: 'session_inactive' }))
}

describe('deliverWithActivationRetry', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('returns immediately on first-attempt success, with no delay', async () => {
        const deliver = vi.fn().mockResolvedValue('ok')
        await expect(deliverWithActivationRetry(deliver)).resolves.toBe('ok')
        expect(deliver).toHaveBeenCalledTimes(1)
    })

    it('retries through a transient session_inactive 409 and succeeds once the session activates', async () => {
        const deliver = vi.fn()
            .mockRejectedValueOnce(sessionInactiveError())
            .mockRejectedValueOnce(sessionInactiveError())
            .mockResolvedValueOnce('ok')

        const promise = deliverWithActivationRetry(deliver)
        await vi.runAllTimersAsync()

        await expect(promise).resolves.toBe('ok')
        expect(deliver).toHaveBeenCalledTimes(3)
    })

    it('gives up after the bounded number of retries and surfaces the last error', async () => {
        const deliver = vi.fn().mockRejectedValue(sessionInactiveError())

        const promise = deliverWithActivationRetry(deliver)
        promise.catch(() => {}) // attach a handler before advancing timers — avoid an unhandled-rejection warning mid-run
        await vi.runAllTimersAsync()

        await expect(promise).rejects.toBeInstanceOf(ApiError)
        // Initial attempt + one retry per configured backoff delay.
        expect(deliver.mock.calls.length).toBeGreaterThan(1)
    })

    it('does not retry a non-session_inactive error — fails immediately', async () => {
        const otherError = new ApiError('HTTP 500', 500, undefined, '{}')
        const deliver = vi.fn().mockRejectedValue(otherError)

        await expect(deliverWithActivationRetry(deliver)).rejects.toBe(otherError)
        expect(deliver).toHaveBeenCalledTimes(1)
    })

    it('does not retry a plain Error that happens to carry an unrelated shape', async () => {
        const plainError = new Error('network down')
        const deliver = vi.fn().mockRejectedValue(plainError)

        await expect(deliverWithActivationRetry(deliver)).rejects.toBe(plainError)
        expect(deliver).toHaveBeenCalledTimes(1)
    })
})
