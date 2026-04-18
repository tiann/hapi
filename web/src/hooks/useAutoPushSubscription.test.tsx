import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutoPushSubscription } from './useAutoPushSubscription'

describe('useAutoPushSubscription', () => {
    it('subscribes automatically only when permission is already granted', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: false,
            isSupported: true,
            permission: 'granted',
            subscribe
        }))

        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
    })

    it('does not request or subscribe when permission is default', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: false,
            isSupported: true,
            permission: 'default',
            subscribe
        }))

        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(subscribe).not.toHaveBeenCalled()
    })

    it('does not subscribe inside Telegram', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: true,
            isSupported: true,
            permission: 'granted',
            subscribe
        }))

        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(subscribe).not.toHaveBeenCalled()
    })
})
