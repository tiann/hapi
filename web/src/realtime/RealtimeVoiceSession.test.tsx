import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import {
    getCurrentRealtimeSessionId,
    getVoiceSession,
    isVoiceSessionStarted,
    resetRealtimeSessionState,
    startRealtimeSession,
} from '@/realtime/RealtimeSession'

const startSessionMock = vi.fn().mockResolvedValue('conv-123')
const endSessionMock = vi.fn().mockResolvedValue(undefined)
const sendContextualUpdateMock = vi.fn()
const sendUserMessageMock = vi.fn()
const fetchVoiceTokenMock = vi.fn()
let bridgeLoadCount = 0

vi.mock('@/realtime/realtimeClientTools', () => ({
    registerSessionStore: vi.fn(),
    realtimeClientTools: {},
}))

vi.mock('@/api/voice', () => ({
    fetchVoiceToken: (...args: unknown[]) => fetchVoiceTokenMock(...args),
}))

let latestConversationCallback: ((conversation: unknown | null) => void) | null = null

vi.mock('@/realtime/ElevenLabsConversationBridge', () => {
    bridgeLoadCount += 1
    return {
        ElevenLabsConversationBridge: ({
            onConversationChange,
        }: {
            onConversationChange: (conversation: unknown | null) => void
        }) => {
            useEffect(() => {
                latestConversationCallback = onConversationChange
                onConversationChange({
                    startSession: startSessionMock,
                    endSession: endSessionMock,
                    sendContextualUpdate: sendContextualUpdateMock,
                    sendUserMessage: sendUserMessageMock,
                })
                return () => {
                    latestConversationCallback = null
                    onConversationChange(null)
                }
            }, [onConversationChange])
            return null
        },
    }
})

import { RealtimeVoiceSession } from '@/realtime/RealtimeVoiceSession'

const api = {} as ApiClient

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('RealtimeVoiceSession lazy bridge lifecycle', () => {
    const getUserMediaMock = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
        resetRealtimeSessionState()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: getUserMediaMock },
        })
        getUserMediaMock.mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
        })
    })

    afterEach(() => {
        cleanup()
        resetRealtimeSessionState()
    })

    it('does not load the ElevenLabs bridge on idle mount and aborts startup if unmounted while token is pending', async () => {
        const tokenDeferred = deferred<{ allowed: boolean; token: string }>()
        fetchVoiceTokenMock.mockReturnValue(tokenDeferred.promise)

        const { unmount } = render(<RealtimeVoiceSession api={api} micMuted={false} />)

        expect(getVoiceSession()).not.toBeNull()
        expect(bridgeLoadCount).toBe(0)

        const startPromise = getVoiceSession()!.startSession({
            sessionId: 'sess-1',
            initialContext: 'hello',
        })

        // Flush bridge dynamic import and getUserMedia microtasks so fetchVoiceToken is pending
        // with a resolved conversation handle from ElevenLabsConversationBridge.
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(bridgeLoadCount).toBeGreaterThanOrEqual(1)
        expect(fetchVoiceTokenMock).toHaveBeenCalledTimes(1)

        // Navigating away unmounts the voice session before fetchVoiceToken settles.
        unmount()

        await act(async () => {
            tokenDeferred.resolve({ allowed: true, token: 'tok-abc' })
            await expect(startPromise).rejects.toThrow('cancelled')
        })

        expect(startSessionMock).not.toHaveBeenCalled()
    })

    it('cancels in-flight session startup when endSession is called before token resolves', async () => {
        const tokenDeferred = deferred<{ allowed: boolean; token: string }>()
        fetchVoiceTokenMock.mockReturnValue(tokenDeferred.promise)

        render(<RealtimeVoiceSession api={api} micMuted={false} />)

        const startPromise = getVoiceSession()!.startSession({
            sessionId: 'sess-2',
            initialContext: 'hello',
        })

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        await getVoiceSession()!.endSession()

        await act(async () => {
            tokenDeferred.resolve({ allowed: true, token: 'tok-def' })
            await expect(startPromise).rejects.toThrow('cancelled')
        })

        expect(startSessionMock).not.toHaveBeenCalled()
    })

    it('keeps a starting session alive when ElevenLabs rerenders with a fresh wrapper object', async () => {
        fetchVoiceTokenMock.mockResolvedValue({ allowed: true, token: 'tok-live' })
        const connectDeferred = deferred<string>()
        startSessionMock.mockImplementationOnce(() => connectDeferred.promise)

        render(<RealtimeVoiceSession api={api} micMuted={false} />)

        const startPromise = getVoiceSession()!.startSession({
            sessionId: 'sess-3',
            initialContext: 'hello context',
        })

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(startSessionMock).toHaveBeenCalledTimes(1)

        // Simulate @elevenlabs/react useConversation returning a brand-new wrapper instance on rerender.
        await act(async () => {
            latestConversationCallback?.({
                startSession: startSessionMock,
                endSession: endSessionMock,
                sendContextualUpdate: sendContextualUpdateMock,
                sendUserMessage: sendUserMessageMock,
            })
            connectDeferred.resolve('conv-live')
            await startPromise
        })

        expect(endSessionMock).not.toHaveBeenCalled()
        expect(sendContextualUpdateMock).toHaveBeenCalled()
    })

    it('preserves replacement session state and closes only originating handle when stale connection settles after B connects', async () => {
        const endA = vi.fn().mockResolvedValue(undefined)
        const startB = vi.fn().mockResolvedValue('conv-B')
        const endB = vi.fn().mockResolvedValue(undefined)
        const sendContextB = vi.fn()

        const connectADeferred = deferred<string>()
        startSessionMock.mockImplementationOnce(() => connectADeferred.promise)
        endSessionMock.mockImplementation(endA)
        fetchVoiceTokenMock.mockResolvedValue({ allowed: true, token: 'tok-multi' })

        render(<RealtimeVoiceSession api={api} micMuted={false} />)

        const startAPromise = startRealtimeSession('sess-A', 'context-A')

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(startSessionMock).toHaveBeenCalledTimes(1)

        // Switch bridge to handle B and start replacement call through the real startRealtimeSession wrapper.
        latestConversationCallback?.({
            startSession: startB,
            endSession: endB,
            sendContextualUpdate: sendContextB,
            sendUserMessage: vi.fn(),
        })

        const startBPromise = startRealtimeSession('sess-B', 'context-B')

        await act(async () => {
            await startBPromise
        })

        expect(getCurrentRealtimeSessionId()).toBe('sess-B')
        expect(isVoiceSessionStarted()).toBe(true)

        // Stale call A now settles: must close only A without clearing B's shared session state.
        await act(async () => {
            connectADeferred.resolve('conv-A')
            await startAPromise
        })

        expect(endA).toHaveBeenCalledTimes(1)
        expect(endB).not.toHaveBeenCalled()
        expect(sendContextB).toHaveBeenCalledWith('context-B')
        expect(getCurrentRealtimeSessionId()).toBe('sess-B')
        expect(isVoiceSessionStarted()).toBe(true)
    })
})
