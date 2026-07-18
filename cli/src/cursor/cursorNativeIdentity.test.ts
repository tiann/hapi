import { describe, expect, it, vi } from 'vitest'
import { createCursorNativeIdentityTracker, establishCursorNativeIdentity } from './cursorNativeIdentity'

describe('establishCursorNativeIdentity', () => {
    it('requires a successful provider bootstrap and awaits ownership acknowledgement', async () => {
        const order: string[] = []
        const acknowledge = vi.fn(async (sessionId: string) => {
            order.push(`ack:${sessionId}`)
        })

        await expect(establishCursorNativeIdentity({
            runBootstrap: async (onNativeIdentity) => {
                order.push('bootstrap')
                onNativeIdentity('cursor-native-1')
                return 0
            },
            acknowledge
        })).resolves.toBe('cursor-native-1')
        expect(order).toEqual(['bootstrap', 'ack:cursor-native-1'])
    })

    it('fails closed when bootstrap exits without a provider session id', async () => {
        await expect(establishCursorNativeIdentity({
            runBootstrap: async () => 0,
            acknowledge: async () => undefined
        })).rejects.toThrow('native session id')
    })
})

describe('createCursorNativeIdentityTracker', () => {
    it('keeps the last owned identity and fails closed when a rotation is rejected', async () => {
        const onRejected = vi.fn()
        const tracker = createCursorNativeIdentityTracker({
            initialSessionId: 'cursor-owned',
            acknowledge: async (sessionId) => {
                if (sessionId === 'cursor-unowned') throw new Error('lease collision')
            },
            onRejected
        })

        tracker.observe('cursor-unowned')

        await expect(tracker.settle()).rejects.toThrow('lease collision')
        expect(tracker.currentSessionId()).toBe('cursor-owned')
        expect(onRejected).toHaveBeenCalledOnce()
    })

    it('publishes a rotation only after acknowledgement settles', async () => {
        let acknowledge!: () => void
        const tracker = createCursorNativeIdentityTracker({
            initialSessionId: 'cursor-old',
            acknowledge: async () => new Promise<void>((resolve) => { acknowledge = resolve }),
            onRejected: vi.fn()
        })

        tracker.observe('cursor-new')
        await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
        expect(tracker.currentSessionId()).toBe('cursor-old')
        acknowledge()
        await tracker.settle()
        expect(tracker.currentSessionId()).toBe('cursor-new')
    })
})
