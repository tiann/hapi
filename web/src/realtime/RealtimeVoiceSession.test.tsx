import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { VoiceSession } from '@/realtime/types'

let registeredSession: VoiceSession | null = null
const startSessionMock = vi.fn().mockResolvedValue('conv-123')
const endSessionMock = vi.fn().mockResolvedValue(undefined)
const sendContextualUpdateMock = vi.fn()
const sendUserMessageMock = vi.fn()
const fetchVoiceTokenMock = vi.fn()
let bridgeLoadCount = 0

vi.mock('@/realtime/RealtimeSession', () => ({
    registerVoiceSession: (session: VoiceSession) => {
        registeredSession = session
    },
    resetRealtimeSessionState: vi.fn(),
}))

vi.mock('@/realtime/realtimeClientTools', () => ({
    registerSessionStore: vi.fn(),
    realtimeClientTools: {},
}))

vi.mock('@/api/voice', () => ({
    fetchVoiceToken: (...args: unknown[]) => fetchVoiceTokenMock(...args),
}))

vi.mock('@/realtime/ElevenLabsConversationBridge', () => {
    bridgeLoadCount += 1
    return {
        ElevenLabsConversationBridge: ({
            onConversationChange,
        }: {
            onConversationChange: (conversation: unknown | null) => void
        }) => {
            useEffect(() => {
                onConversationChange({
                    startSession: startSessionMock,
                    endSession: endSessionMock,
                    sendContextualUpdate: sendContextualUpdateMock,
                    sendUserMessage: sendUserMessageMock,
                })
                return () => onConversationChange(null)
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
        registeredSession = null
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
    })

    it('does not load the ElevenLabs bridge on idle mount and aborts startup if unmounted while token is pending', async () => {
        const tokenDeferred = deferred<{ allowed: boolean; token: string }>()
        fetchVoiceTokenMock.mockReturnValue(tokenDeferred.promise)

        const { unmount } = render(<RealtimeVoiceSession api={api} micMuted={false} />)

        expect(registeredSession).not.toBeNull()
        expect(bridgeLoadCount).toBe(0)

        const startPromise = registeredSession!.startSession({
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

        const startPromise = registeredSession!.startSession({
            sessionId: 'sess-2',
            initialContext: 'hello',
        })

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        await registeredSession!.endSession()

        await act(async () => {
            tokenDeferred.resolve({ allowed: true, token: 'tok-def' })
            await expect(startPromise).rejects.toThrow('cancelled')
        })

        expect(startSessionMock).not.toHaveBeenCalled()
    })
})
