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
    stopRealtimeSession,
} from '@/realtime/RealtimeSession'

const startSessionMock = vi.fn().mockResolvedValue('conv-123')
const endSessionMock = vi.fn().mockResolvedValue(undefined)
const sendContextualUpdateMock = vi.fn()
const sendUserMessageMock = vi.fn()
const mockConversation = {
    startSession: startSessionMock,
    endSession: endSessionMock,
    sendContextualUpdate: sendContextualUpdateMock,
    sendUserMessage: sendUserMessageMock,
}
const createConversation = vi.fn(() => ({ ...mockConversation }))
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
                onConversationChange(createConversation())
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
        vi.resetAllMocks()
        startSessionMock.mockResolvedValue('conv-123')
        endSessionMock.mockResolvedValue(undefined)
        fetchVoiceTokenMock.mockResolvedValue({ allowed: true, token: 'token' })
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
        vi.useRealTimers()
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

    it('finishes superseded startup and teardown before starting B on the shared conversation', async () => {
        const connectA = deferred<void>()
        const disconnectA = deferred<void>()
        let connected: string | null = null
        const ended: (string | null)[] = []
        let onDisconnectA: () => void
        startSessionMock.mockImplementationOnce(async (options) => {
            onDisconnectA = options.onDisconnect
            await connectA.promise
            connected = 'A'
            return connected
        }).mockImplementationOnce(async () => {
            connected = 'B'
            return connected
        })
        endSessionMock.mockImplementationOnce(async () => {
            await disconnectA.promise
            ended.push(connected)
            connected = null
            onDisconnectA()
        })
        fetchVoiceTokenMock.mockResolvedValue({ allowed: true, token: 'tok-shared' })

        render(<RealtimeVoiceSession api={api} />)
        const startA = startRealtimeSession('sess-A', 'context-A')
        await act(async () => {})
        expect(startSessionMock).toHaveBeenCalledTimes(1)

        const startB = startRealtimeSession('sess-B', 'context-B')
        await act(async () => {})
        expect(fetchVoiceTokenMock).toHaveBeenCalledTimes(2)
        expect(startSessionMock).toHaveBeenCalledTimes(1)

        connectA.resolve()
        await act(async () => {})
        expect(endSessionMock).toHaveBeenCalledTimes(1)
        expect(startSessionMock).toHaveBeenCalledTimes(1)

        disconnectA.resolve()
        await Promise.all([startA, startB])
        expect(ended).toEqual(['A'])
        expect(connected).toBe('B')
        expect(sendContextualUpdateMock).toHaveBeenCalledWith('context-B')
        expect(getCurrentRealtimeSessionId()).toBe('sess-B')
        expect(isVoiceSessionStarted()).toBe(true)
    })

    it.each(['connected', 'connecting'])('disconnects exactly once when unmounted while %s', async (state) => {
        const pending = deferred<string>()
        const status = vi.fn()
        startSessionMock.mockReturnValueOnce(pending.promise)
        const view = render(<RealtimeVoiceSession api={api} onStatusChange={status} />)
        const start = startRealtimeSession('A', '')
        await act(async () => {})
        const callbacks = startSessionMock.mock.calls[0][0]
        if (state === 'connected') {
            callbacks.onConnect()
            pending.resolve('A')
            await start
            expect(isVoiceSessionStarted()).toBe(true)
        }
        const latestStatus = vi.fn()
        view.rerender(<RealtimeVoiceSession api={api} onStatusChange={latestStatus} />)
        status.mockClear()
        view.unmount()
        callbacks.onDisconnect()
        callbacks.onError('late error')
        callbacks.onConnect()
        pending.resolve('A')
        await start
        expect(status).not.toHaveBeenCalled()
        expect(latestStatus.mock.calls).toEqual([['disconnected']])
        expect(getCurrentRealtimeSessionId()).toBeNull()
        expect(isVoiceSessionStarted()).toBe(false)
    })

    it('skips disconnected notification on idle unmount', () => {
        const status = vi.fn()
        render(<RealtimeVoiceSession api={api} onStatusChange={status} />).unmount()
        expect(status).not.toHaveBeenCalled()
    })

    it('closes the open session before starting its replacement with new callbacks', async () => {
        const close = deferred<void>()
        const status = vi.fn()
        render(<RealtimeVoiceSession api={api} onStatusChange={status} />)
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        await a
        const old = startSessionMock.mock.calls[0][0]
        endSessionMock.mockReturnValueOnce(close.promise)
        const b = startRealtimeSession('B', '')
        await act(async () => {})
        expect(endSessionMock).toHaveBeenCalledOnce()
        expect(startSessionMock).toHaveBeenCalledTimes(1)
        old.onConnect()
        old.onError('late error')
        old.onDisconnect()
        expect(status.mock.calls).toEqual([['connecting'], ['connecting']])
        close.resolve()
        await b
        const current = startSessionMock.mock.calls[1][0]
        current.onConnect()
        current.onError('live error')
        expect(status.mock.calls.slice(-2)).toEqual([['connected'], ['error', 'live error']])
        current.onDisconnect()
        expect(status).toHaveBeenLastCalledWith('disconnected')
        expect(isVoiceSessionStarted()).toBe(false)
    })

    it('serializes stop between pending A and B without publishing stale status', async () => {
        const connect = deferred<string>()
        const close = deferred<void>()
        startSessionMock.mockReturnValueOnce(connect.promise)
        endSessionMock.mockReturnValueOnce(close.promise)
        const status = vi.fn()
        render(<RealtimeVoiceSession api={api} onStatusChange={status} />)
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        const stop = stopRealtimeSession()
        const b = startRealtimeSession('B', '')
        connect.resolve('A')
        await act(async () => {})
        expect(endSessionMock).toHaveBeenCalledOnce()
        expect(startSessionMock).toHaveBeenCalledTimes(1)
        close.resolve()
        await Promise.all([a, stop, b])
        startSessionMock.mock.calls[1][0].onConnect()
        expect(status.mock.calls).toEqual([['connecting'], ['connecting'], ['connected']])
        expect(getCurrentRealtimeSessionId()).toBe('B')
        expect(isVoiceSessionStarted()).toBe(true)
    })

    it.each(['start', 'end'])('recovers after an SDK %s rejection', async (operation) => {
        render(<RealtimeVoiceSession api={api} />)
        if (operation === 'start') startSessionMock.mockRejectedValueOnce(new Error('start failed'))
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        await a
        if (operation === 'end') {
            endSessionMock.mockRejectedValueOnce(new Error('close failed'))
            await expect(getVoiceSession()!.endSession()).rejects.toThrow('close failed')
            await act(async () => {})
        }
        await startRealtimeSession('B', '')
        expect(isVoiceSessionStarted()).toBe(true)
        expect(getCurrentRealtimeSessionId()).toBe('B')
    })

    it.each(['start', 'end', 'stop behind start', 'stale teardown'])('retires the bridge on a hung %s', async (scenario) => {
        vi.useFakeTimers()
        const pending = deferred<string>()
        const status = vi.fn()
        render(<RealtimeVoiceSession api={api} onStatusChange={status} />)
        if (scenario !== 'end') startSessionMock.mockReturnValueOnce(pending.promise)
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        const old = startSessionMock.mock.calls[0][0]
        const fresh = { ...mockConversation, startSession: vi.fn().mockResolvedValue('fresh') }
        createConversation.mockReturnValueOnce(fresh)
        let operation: Promise<unknown> = a
        if (scenario === 'end' || scenario === 'stop behind start') {
            endSessionMock.mockReturnValueOnce(new Promise(() => {}))
            operation = expect(getVoiceSession()!.endSession()).rejects.toThrow('timed out')
        } else if (scenario === 'stale teardown') {
            endSessionMock.mockReturnValueOnce(new Promise(() => {}))
            operation = startRealtimeSession('B', '')
            pending.resolve('A')
            await act(async () => {})
            expect(endSessionMock).toHaveBeenCalledOnce()
        }
        const timeout = scenario === 'start' ? 15_000 : 5_000
        await act(async () => { await vi.advanceTimersByTimeAsync(timeout - 1) })
        expect(createConversation).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(1) })
        await operation
        expect(createConversation).toHaveBeenCalledTimes(2)
        if (scenario === 'start') expect(status).toHaveBeenLastCalledWith('error', expect.stringContaining('timed out'))
        if (scenario !== 'stale teardown') await startRealtimeSession('B', '')
        pending.resolve('late A')
        await a
        status.mockClear()
        old.onConnect()
        old.onError('late error')
        old.onDisconnect()
        expect(status).not.toHaveBeenCalled()
        expect(fresh.startSession).toHaveBeenCalledOnce()
        expect(getCurrentRealtimeSessionId()).toBe('B')
        expect(isVoiceSessionStarted()).toBe(true)
    })

    it('gives a queued start its full timeout after the preceding start times out', async () => {
        vi.useFakeTimers()
        startSessionMock.mockReturnValueOnce(new Promise(() => {}))
        render(<RealtimeVoiceSession api={api} />)
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        expect(startSessionMock).toHaveBeenCalledOnce()
        const connectB = deferred<string>()
        const fresh = { ...mockConversation, startSession: vi.fn().mockReturnValue(connectB.promise) }
        createConversation.mockReturnValueOnce(fresh)
        await vi.advanceTimersByTimeAsync(100)
        const b = startRealtimeSession('B', '')
        await act(async () => {})
        await act(async () => { await vi.advanceTimersByTimeAsync(14_900) })
        await a
        expect(fresh.startSession).toHaveBeenCalledOnce()
        await act(async () => { await vi.advanceTimersByTimeAsync(14_999) })
        connectB.resolve('B')
        await b
        expect(createConversation).toHaveBeenCalledTimes(2)
        expect(isVoiceSessionStarted()).toBe(true)
        expect(getCurrentRealtimeSessionId()).toBe('B')
    })

    it.each(['microphone', 'token fetch', 'token denied'])('disconnects A once if B fails during %s', async (failure) => {
        const status = vi.fn()
        const view = render(<RealtimeVoiceSession api={api} onStatusChange={status} />)
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        await a
        const old = startSessionMock.mock.calls[0][0]
        const preflight = deferred<{ allowed: boolean }>()
        if (failure === 'microphone') getUserMediaMock.mockReturnValueOnce(preflight.promise)
        else fetchVoiceTokenMock.mockReturnValueOnce(preflight.promise)
        endSessionMock.mockImplementationOnce(async () => old.onDisconnect())
        const b = startRealtimeSession('B', '')
        await act(async () => {})
        old.onError('A is still live')
        expect(status).toHaveBeenLastCalledWith('error', 'A is still live')
        if (failure === 'token denied') preflight.resolve({ allowed: false })
        else preflight.reject(new Error(failure))
        await b
        old.onDisconnect()
        view.unmount()
        expect(startSessionMock).toHaveBeenCalledOnce()
        expect(endSessionMock).toHaveBeenCalledOnce()
        expect(status.mock.calls.filter(([value]) => value === 'disconnected')).toHaveLength(1)
        expect(status).toHaveBeenLastCalledWith('error', expect.any(String))
        expect(isVoiceSessionStarted()).toBe(false)
        expect(getCurrentRealtimeSessionId()).toBeNull()
    })

    it('keeps the registered open session and uses the latest API after rerender', async () => {
        const onRegistered = vi.fn()
        const view = render(<RealtimeVoiceSession api={api} onRegistered={onRegistered} />)
        const session = getVoiceSession()
        const a = startRealtimeSession('A', '')
        await act(async () => {})
        await a
        const nextApi = {} as ApiClient
        view.rerender(<RealtimeVoiceSession api={nextApi} onRegistered={onRegistered} />)
        expect(onRegistered).toHaveBeenCalledOnce()
        expect(getVoiceSession()).toBe(session)
        expect(isVoiceSessionStarted()).toBe(true)
        await startRealtimeSession('B', '')
        expect(fetchVoiceTokenMock.mock.lastCall?.[0]).toBe(nextApi)
        expect(endSessionMock).toHaveBeenCalledOnce()
        expect(isVoiceSessionStarted()).toBe(true)
    })

    it('preserves replacement session state and closes only originating handle when stale connection settles after B connects', async () => {
        const endA = vi.fn().mockResolvedValue(undefined)
        const startB = vi.fn().mockResolvedValue('conv-B')
        const endB = vi.fn().mockResolvedValue(undefined)
        const sendContextB = vi.fn()

        const connectADeferred = deferred<string>()
        startSessionMock.mockImplementationOnce(() => connectADeferred.promise)
        endSessionMock.mockImplementationOnce(endA)
        fetchVoiceTokenMock.mockResolvedValue({ allowed: true, token: 'tok-multi' })

        const { unmount } = render(<RealtimeVoiceSession api={api} micMuted={false} />)

        const startAPromise = startRealtimeSession('sess-A', 'context-A')

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(startSessionMock).toHaveBeenCalledTimes(1)

        unmount()
        render(<RealtimeVoiceSession api={api} micMuted={false} />)
        createConversation.mockReturnValueOnce({
            startSession: startB,
            endSession: endB,
            sendContextualUpdate: sendContextB,
            sendUserMessage: vi.fn(),
        })
        const startBPromise = startRealtimeSession('sess-B', 'context-B')
        await act(async () => {})

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
