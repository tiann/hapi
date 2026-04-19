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

    it('retries when auth context changes', async () => {
        const subscribe = vi.fn(async () => true)
        const firstApi = {} as never
        const secondApi = {} as never

        const { rerender } = renderHook(
            ({ api, token }) => useAutoPushSubscription({
                api,
                token,
                isTelegram: false,
                isSupported: true,
                permission: 'granted',
                subscribe
            }),
            {
                initialProps: {
                    api: firstApi,
                    token: 'token-1'
                }
            }
        )

        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

        rerender({ api: secondApi, token: 'token-2' })
        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    })

    it('retries when subscribe resolves false and auth context changes', async () => {
        const subscribe = vi.fn(async () => false)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
        const firstApi = {} as never
        const secondApi = {} as never

        const { rerender } = renderHook(
            ({ api, token }) => useAutoPushSubscription({
                api,
                token,
                isTelegram: false,
                isSupported: true,
                permission: 'granted',
                subscribe
            }),
            {
                initialProps: {
                    api: firstApi,
                    token: 'token-1'
                }
            }
        )

        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

        rerender({ api: secondApi, token: 'token-2' })
        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    })

    it('retries when subscribe rejects and auth context changes', async () => {
        const subscribe = vi.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce(true)
        const firstApi = {} as never
        const secondApi = {} as never

        const { rerender } = renderHook(
            ({ api, token }) => useAutoPushSubscription({
                api,
                token,
                isTelegram: false,
                isSupported: true,
                permission: 'granted',
                subscribe
            }),
            {
                initialProps: {
                    api: firstApi,
                    token: 'token-1'
                }
            }
        )

        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

        rerender({ api: secondApi, token: 'token-2' })
        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    })
})
