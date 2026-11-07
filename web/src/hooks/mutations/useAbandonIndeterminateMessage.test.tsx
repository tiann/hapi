import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { useAbandonIndeterminateMessage } from './useAbandonIndeterminateMessage'
const calls = vi.hoisted(() => ({ consumed: vi.fn(), removed: vi.fn() }))
vi.mock('@/lib/message-window-store', () => ({ getMessageWindowState: () => ({ messages: [] }), markMessagesConsumed: calls.consumed, removeOptimisticMessage: calls.removed }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
}
describe('explicit abandon mutation', () => {
    it('cancels input that remains natively queued after reconnection without abandoning it', async () => {
        calls.removed.mockClear()
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'cancelled', localId: 'local' }),
            abandonIndeterminateMessage: vi.fn().mockResolvedValue({ status: 'unavailable' }) } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' }) })
        expect(api.cancelMessage).toHaveBeenCalledWith('s', 'm')
        expect(api.abandonIndeterminateMessage).not.toHaveBeenCalled()
        expect(calls.removed).toHaveBeenCalledWith('s', 'local')
    })
    it.each(['abandoned', 'not-found'])('removes the pending row only after %s', async status => {
        calls.removed.mockClear(); calls.consumed.mockClear()
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'busy' }), abandonIndeterminateMessage: vi.fn().mockResolvedValue({ status, localId: 'local' }) } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' }) })
        expect(calls.removed).toHaveBeenCalledWith('s', 'local'); expect(calls.consumed).not.toHaveBeenCalled()
    })
    it('uses consumption proved by normal cancellation without attempting abandonment', async () => {
        calls.removed.mockClear(); calls.consumed.mockClear()
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'invoked', message: { localId: 'local', invokedAt: 456 } }),
            abandonIndeterminateMessage: vi.fn() } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' }) })
        expect(calls.consumed).toHaveBeenCalledWith('s', ['local'], 456)
        expect(api.abandonIndeterminateMessage).not.toHaveBeenCalled()
        expect(calls.removed).not.toHaveBeenCalled()
    })
    it('keeps the input when the normal cancellation response is lost', async () => {
        calls.removed.mockClear()
        const api = { cancelMessage: vi.fn().mockRejectedValue(new Error('cancel response lost')),
            abandonIndeterminateMessage: vi.fn() } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await expect(result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' })).rejects.toThrow('cancel response lost') })
        expect(api.abandonIndeterminateMessage).not.toHaveBeenCalled()
        expect(calls.removed).not.toHaveBeenCalled()
    })
    it('preserves the row on refusal or a lost response', async () => {
        calls.removed.mockClear()
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'busy' }), abandonIndeterminateMessage: vi.fn().mockResolvedValue({ status: 'unavailable', localId: 'local' }) } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await expect(result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' })).rejects.toThrow('queuedMessages.abandonUnavailable') })
        expect(calls.removed).not.toHaveBeenCalled()
        vi.mocked(api.abandonIndeterminateMessage).mockRejectedValueOnce(new Error('response lost'))
        await act(async () => { await expect(result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' })).rejects.toThrow('response lost') })
        expect(calls.removed).not.toHaveBeenCalled()
    })
    it('uses a concurrent consumption proof instead of reporting abandonment', async () => {
        calls.removed.mockClear(); calls.consumed.mockClear()
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'busy' }), abandonIndeterminateMessage: vi.fn().mockResolvedValue({ status: 'invoked', message: { localId: 'local', invokedAt: 123 } }) } as unknown as ApiClient
        const { result } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        await act(async () => { await result.current.mutateAsync({ sessionId: 's', messageId: 'm', localId: 'local' }) })
        expect(calls.consumed).toHaveBeenCalledWith('s', ['local'], 123); expect(calls.removed).not.toHaveBeenCalled()
    })
})
