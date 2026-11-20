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

describe('useMessages cachedTailFirstFrame composition', () => {
    const tailSessionId = 'use-messages-cached-tail-first-frame'

    afterEach(() => {
        clearMessageWindow(tailSessionId)
        sessionStorage.clear()
        vi.restoreAllMocks()
    })

    function seedTailWindow(options: { requiresLatestReset?: boolean } = {}) {
        const cachedMessage = {
            id: 'cached-tail-message',
            role: 'agent',
            content: { type: 'text', text: 'cached tail message' },
            createdAt: 2_000,
            seq: 2,
            invokedAt: 2_000,
        } as unknown as DecryptedMessage
        localStorage.setItem(`hapi:message-window:v3:${tailSessionId}`, JSON.stringify({
            messages: [cachedMessage],
            hasMore: false,
            oldestPositionAt: 2_000,
            oldestPositionSeq: 2,
            newestPositionAt: 2_000,
            newestPositionSeq: 2,
            epoch: 1,
            ...(options.requiresLatestReset ? { requiresLatestReset: true } : {}),
        }))
    }

    it('marks a hydrated tail window while the authoritative sync is in flight', async () => {
        seedTailWindow()
        // The latest-page fetch never settles: the fast-path signal must not
        // depend on the sync resolving.
        const api = { getMessages: vi.fn(() => new Promise(() => {})) } as unknown as ApiClient

        const { result } = renderHook(() => useMessages(api, tailSessionId))

        await waitFor(() => expect(result.current.isCatchingUpFromCache).toBe(true))
        expect(result.current.cachedTailFirstFrame).toBe(true)
        expect(result.current.isSyncingTail).toBe(true)
        expect(result.current.viewMode).toBe('tail')
    })

    it('excludes a window that still requires the authoritative latest reset', async () => {
        seedTailWindow({ requiresLatestReset: true })
        const api = { getMessages: vi.fn(() => new Promise(() => {})) } as unknown as ApiClient

        const { result } = renderHook(() => useMessages(api, tailSessionId))

        // Activation never offers a usable tail cursor (forceLatest), so no
        // signal may claim the rendered rows are the tail.
        await waitFor(() => expect(result.current.viewMode).toBe('tail'))
        expect(result.current.cachedTailFirstFrame).toBe(false)
        expect(result.current.isCatchingUpFromCache).toBe(false)
        expect(result.current.isSyncingTail).toBe(true)
    })
})
