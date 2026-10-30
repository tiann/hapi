import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages, markMessagesIndeterminate } from '@/lib/message-window-store'
import { useSteerQueuedMessage } from './useSteerQueuedMessage'

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const sid = 'steer-rest-reconciliation'
const input = { sessionId: sid, messageId: 'server-id' }
const pendingState = { queuedLocalIds: [], indeterminateLocalIds: ['local-id'], dispatchingLocalIds: ['local-id'], invokedLocalMessages: [] }
const message = () => getMessageWindowState(sid).messages[0]!
function setup(steerMessage = vi.fn().mockResolvedValue({ status: 'steered', localId: 'local-id' }), getQueuedState = vi.fn().mockResolvedValue(pendingState)) {
    ingestIncomingMessages(sid, [{ id: 'server-id', localId: 'local-id', seq: 1, createdAt: 1000, invokedAt: null, status: 'sent', content: { role: 'user', content: { type: 'text', text: 'correction' } } } as DecryptedMessage])
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider> }
    const hook = renderHook(() => useSteerQueuedMessage({ steerMessage, getQueuedState } as unknown as ApiClient), { wrapper: Wrapper })
    return { ...hook, getQueuedState }
}
beforeEach(() => addToast.mockClear())
afterEach(() => clearMessageWindow(sid))

describe('Steer REST and SSE ordering', () => {
    it('holds an uninvoked row when REST succeeds before any pending SSE', async () => {
        const hook = setup()
        await act(async () => { await hook.result.current.mutateAsync(input) })
        expect(message()).toMatchObject({ invokedAt: null, deliveryPending: true })
        expect(hook.getQueuedState).toHaveBeenCalledWith(sid, ['local-id'])
        expect(addToast).not.toHaveBeenCalled()
    })

    it('does not replace a genuine unknown outcome that arrived before the REST response', async () => {
        let reply!: (value: unknown) => void
        const hook = setup(vi.fn(() => new Promise(resolve => { reply = resolve })))
        let mutation!: Promise<unknown>
        act(() => { mutation = hook.result.current.mutateAsync(input) })
        await waitFor(() => expect(reply).toBeDefined())
        markMessagesIndeterminate(sid, ['local-id'])
        await act(async () => { reply({ status: 'steered', localId: 'local-id' }); await mutation })
        expect(message().deliveryState).toBe('indeterminate')
        expect(message().deliveryPending).toBeUndefined()
        expect(hook.getQueuedState).not.toHaveBeenCalled()
    })

    it('does not let a stale pending readback overwrite a newer unknown SSE', async () => {
        let readback!: (value: unknown) => void
        const hook = setup(undefined, vi.fn(() => new Promise(resolve => { readback = resolve })))
        let mutation!: Promise<unknown>
        act(() => { mutation = hook.result.current.mutateAsync(input) })
        await waitFor(() => expect(readback).toBeDefined())
        expect(message().deliveryPending).toBe(true)
        markMessagesIndeterminate(sid, ['local-id'])
        await act(async () => { readback(pendingState); await mutation })
        expect(message().deliveryPending).toBeUndefined()
        expect(message().deliveryState).toBe('indeterminate')
    })

    it('keeps confirmation pending when readback fails without claiming delivery or failure', async () => {
        const hook = setup(undefined, vi.fn().mockRejectedValue(new Error('offline')))
        await act(async () => { await hook.result.current.mutateAsync(input) })
        expect(message()).toMatchObject({ invokedAt: null, deliveryPending: true })
        expect(addToast).not.toHaveBeenCalled()
    })

    it('reconciles a missed consumed SSE from authoritative invoked readback', async () => {
        const hook = setup(undefined, vi.fn().mockResolvedValue({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [{ localId: 'local-id', invokedAt: 2000 }] }))
        await act(async () => { await hook.result.current.mutateAsync(input) })
        expect(message()).toMatchObject({ invokedAt: 2000, status: 'sent' })
        expect(message().deliveryPending).toBeUndefined()
    })

    it('removes only an unchanged row that authoritative readback reports absent', async () => {
        const hook = setup(undefined, vi.fn().mockResolvedValue({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] }))
        await act(async () => { await hook.result.current.mutateAsync(input) })
        expect(getMessageWindowState(sid).messages).toHaveLength(0)
    })

})
