import { expect, it, vi } from 'vitest'
import { settleAcpLauncherShutdown } from './settleAcpLauncherShutdown'

it('settles after disconnect and launcher exit even if cancellation stalls', async () => {
    const cancel = Promise.withResolvers<void>()
    const disconnect = vi.fn(async () => {})
    const order: string[] = []
    vi.useFakeTimers()
    try {
        const settled = vi.fn()
        const shutdown = settleAcpLauncherShutdown({
            logTag: 'test',
            cancel: () => {
                order.push('cancel')
                return cancel.promise
            },
            disconnect: async () => {
                order.push('disconnect')
                await disconnect()
            },
            running: Promise.resolve()
        }).then(settled)
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['cancel', 'disconnect'])
        expect(settled).toHaveBeenCalledOnce()
        await shutdown
        expect(disconnect).toHaveBeenCalledOnce()
    } finally {
        cancel.resolve()
        vi.useRealTimers()
    }
})


it.each(['cancel-only', 'disconnect'] as const)('retains the grace period for stalled %s', async (phase) => {
    const stalled = Promise.withResolvers<void>()
    vi.useFakeTimers()
    try {
        const settled = vi.fn()
        const shutdown = settleAcpLauncherShutdown({
            logTag: 'test',
            cancel: () => stalled.promise,
            disconnect: () => phase === 'disconnect' ? stalled.promise : undefined,
            running: Promise.resolve()
        }).then(settled)
        await vi.advanceTimersByTimeAsync(4_999)
        expect(settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        await shutdown
        expect(settled).toHaveBeenCalledOnce()
    } finally {
        stalled.resolve()
        vi.useRealTimers()
    }
})
