import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { clearMessageWindow } from '@/lib/message-window-store'
import { useMessages } from './useMessages'

const sessionId = 'use-messages-search-target-cache'

afterEach(() => {
    clearMessageWindow(sessionId)
    sessionStorage.clear()
    vi.restoreAllMocks()
})

describe('useMessages search-target initialization', () => {
    it('enters history mode before skipping the initial tail for a legacy cached window', async () => {
        const cachedMessage = {
            id: 'cached-message',
            role: 'agent',
            content: { type: 'text', text: 'cached message' },
            createdAt: 1_000,
            seq: 1,
            invokedAt: 1_000,
        } as unknown as DecryptedMessage
        sessionStorage.setItem(`hapi:message-window:v2:${sessionId}`, JSON.stringify({
            messages: [cachedMessage],
            hasMore: true,
            oldestPositionAt: 1_000,
            oldestPositionSeq: 1,
            newestPositionAt: 1_000,
            newestPositionSeq: 1,
            epoch: 1,
            requiresLatestReset: true,
        }))
        const api = { getMessages: vi.fn() } as unknown as ApiClient

        const { result } = renderHook(() => useMessages(api, sessionId, {
            skipInitialTailSync: true,
        }))

        await waitFor(() => expect(result.current.isSyncingTail).toBe(false))
        expect(result.current.viewMode).toBe('history')
        expect(result.current.messages).toEqual([cachedMessage])
        expect(api.getMessages).not.toHaveBeenCalled()
    })
})
