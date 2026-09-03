import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import { useRealtimeDictation } from './useRealtimeDictation'

const scribe = vi.hoisted(() => ({
    options: null as unknown,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    commit: vi.fn()
}))

vi.mock('@elevenlabs/react', () => ({
    CommitStrategy: { MANUAL: 'manual' },
    useScribe: (options: unknown) => {
        scribe.options = options
        return {
            connect: scribe.connect,
            disconnect: scribe.disconnect,
            commit: scribe.commit
        }
    }
}))

type ScribeCallbacks = {
    onPartialTranscript: (event: { text: string }) => void
    onDisconnect: () => void
    onCommittedTranscript: (event: { text: string }) => void
    onError: (error: unknown) => void
}

describe('useRealtimeDictation', () => {
    afterEach(() => vi.clearAllMocks())

    it('preserves partial ElevenLabs text on an unexpected disconnect', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        const onFinalTranscript = vi.fn()
        const { result } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript
        }))

        await act(() => result.current.toggle())
        const callbacks = scribe.options as ScribeCallbacks
        act(() => callbacks.onPartialTranscript({ text: 'spoken words' }))
        expect(onFinalTranscript).not.toHaveBeenCalled()

        act(() => callbacks.onDisconnect())

        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toBe('ElevenLabs realtime transcription disconnected')
        expect(result.current.partialTranscript).toBe('')
        expect(onFinalTranscript).toHaveBeenCalledWith('spoken words')
    })

    it('resumes an inactive session, preserves its follow-up draft, and notifies the resolved session', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        let resolveSend: (() => void) | null = null
        const sendMessage = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
        const onFinalTranscript = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript,
            sendMessage
        }))

        // Real scribe.commit() emits the committed transcript; drive the same
        // path in the mock so the send fires with the dictated text.
        scribe.commit.mockImplementation(() => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript?.({ text: 'spoken words' })
        })
        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'explicit initial text', undefined, {
            resolveSessionId,
            onSessionResolved
        }))
        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith('session-A-resumed', 'explicit initial text spoken words', undefined)
        })
        act(() => { saveDraft('session-A', 'follow-up typed while sending') })
        await act(async () => { resolveSend?.() })
        await waitFor(() => expect(onSessionResolved).toHaveBeenCalled())
        expect(resolveSessionId).toHaveBeenCalledWith('session-A')
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
        expect(getDraft('session-A-resumed')).toBe('follow-up typed while sending')
    })

    it('recovers a post-resume send failure under the resumed session id', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        const sendMessage = vi.fn(async () => { throw new Error('network down') })
        const onFinalTranscript = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript,
            sendMessage
        }))

        scribe.commit.mockImplementation(() => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript?.({ text: 'spoken words' })
        })
        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'explicit initial text', undefined, {
            resolveSessionId,
            onSessionResolved
        }))

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith('session-A-resumed', 'explicit initial text spoken words', undefined)
        })
        // The source session is superseded: recovery lives under the resumed id,
        // and the UI is pointed at the resumed session.
        expect(getDraft('session-A-resumed')).toBe('explicit initial text spoken words')
        expect(getDraft('session-A')).toBe('')
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
    })

    it('preserves source and target follow-up drafts when a post-resume send fails after unmount', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        let rejectSend: ((error: Error) => void) | null = null
        const sendMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
        const onFinalTranscript = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript,
            sendMessage
        }))

        scribe.commit.mockImplementation(() => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript?.({ text: 'spoken words' })
        })
        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'explicit initial text', undefined, {
            resolveSessionId,
            onSessionResolved
        }))
        // The send is now in flight against the resumed session; the operator
        // types follow-ups, then leaves the source composer before it rejects.
        await act(async () => {
            await waitFor(() => expect(sendMessage).toHaveBeenCalled())
        })
        act(() => {
            saveDraft('session-A-resumed', 'newer resumed draft')
            saveDraft('session-A', 'source follow-up')
        })
        unmount()
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => {
            await waitFor(() => expect(getDraft('session-A-resumed')).toBe('newer resumed draft source follow-up explicit initial text spoken words'))
        })

        // Both follow-ups and the failed voice message survive under the live id.
        expect(getDraft('session-A')).toBe('')
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
    })

    it('preserves live composer text typed while the send is pending', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        let rejectSend: ((error: Error) => void) | null = null
        const sendMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
        let composerText = ''
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript: (text) => { composerText = text },
            getCurrentText: () => composerText,
            sendMessage
        }))

        scribe.commit.mockImplementation(() => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript?.({ text: 'spoken words' })
        })
        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'explicit initial text', undefined, {
            resolveSessionId,
            onSessionResolved
        }))
        // The send is in flight; the operator types replacement text into the
        // mounted composer (in memory, not yet persisted).
        await act(async () => {
            await waitFor(() => expect(sendMessage).toHaveBeenCalled())
        })
        act(() => { composerText = 'replacement typed by user' })
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => {
            await waitFor(() => expect(composerText).toBe('replacement typed by user explicit initial text spoken words'))
        })

        // Live replacement text AND the failed voice message both survive.
        expect(getDraft('session-A-resumed')).toBe('replacement typed by user explicit initial text spoken words')
        expect(getDraft('session-A')).toBe('')
    })

    it('preserves live composer text typed before a realtime failure', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        let composerText = ''
        clearDraft('session-A')
        // Do not inherit the success-path commit implementation from the
        // previous test: the provider must stay active until onError fires.
        scribe.commit.mockImplementation(() => {})
        const { result } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript: (text) => { composerText = text },
            getCurrentText: () => composerText,
            sendMessage: vi.fn(async () => {})
        }))

        await act(() => result.current.toggle())
        // Fire-and-forget: stop() waits on the scribe commit race; the failure
        // must be driven while the provider session is still active.
        act(() => { void result.current.stopAndSend('session-A', 'explicit initial text') })
        const callbacks = scribe.options as ScribeCallbacks
        act(() => callbacks.onPartialTranscript({ text: 'spoken words' }))
        act(() => { composerText = 'replacement typed by user' })
        act(() => callbacks.onError(new Error('realtime connection died')))
        await act(async () => {
            await waitFor(() => expect(composerText).toBe('replacement typed by user explicit initial text spoken words'))
        })

        // Live replacement text AND the failed voice text both survive.
        expect(getDraft('session-A')).toBe('replacement typed by user explicit initial text spoken words')
    })
})
