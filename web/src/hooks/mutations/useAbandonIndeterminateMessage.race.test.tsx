import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState, ingestIncomingMessages, markMessagesConsumed } from '@/lib/message-window-store'
import { I18nProvider } from '@/lib/i18n-context'
import { useAbandonIndeterminateMessage } from './useAbandonIndeterminateMessage'

const sessionId = 'abandon-consumption-race'
const row: DecryptedMessage = {
    id: 'server-message', localId: 'local-message', seq: 1, createdAt: 1000,
    invokedAt: null, deliveryState: 'indeterminate', status: 'queued',
    content: { role: 'user', content: { type: 'text', text: 'original input' } },
}

afterEach(() => clearMessageWindow(sessionId))

describe('late resolution responses and authoritative consumption', () => {
    it.each(['abandoned', 'not-found'])('preserves consumed input received before a delayed %s response', async (status) => {
        appendOptimisticMessage(sessionId, row)
        let respond!: (value: unknown) => void
        const held = new Promise(resolve => { respond = resolve })
        const api = { cancelMessage: vi.fn().mockResolvedValue({ status: 'busy', localId: row.localId }),
            abandonIndeterminateMessage: vi.fn().mockReturnValue(held) } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
        const { result, unmount } = renderHook(() => useAbandonIndeterminateMessage(api), { wrapper })
        let pending!: Promise<unknown>
        try {
            act(() => { pending = result.current.mutateAsync({ sessionId, messageId: row.id, localId: row.localId! }) })
            await waitFor(() => expect(api.abandonIndeterminateMessage).toHaveBeenCalled())
            act(() => {
                markMessagesConsumed(sessionId, [row.localId!], 2000)
                ingestIncomingMessages(sessionId, [{ ...row, invokedAt: 2000, status: 'sent', deliveryState: undefined }])
            })
            await act(async () => { respond({ status, localId: row.localId }); await pending })
            expect(getMessageWindowState(sessionId).messages).toEqual([
                expect.objectContaining({ id: row.id, localId: row.localId, invokedAt: 2000, status: 'sent' }),
            ])
        } finally { unmount(); client.clear() }
    })
})
