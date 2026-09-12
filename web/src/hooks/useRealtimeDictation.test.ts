import { useState } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerDraft } from './useComposerDraft'
import type { ApiClient } from '@/api/client'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import { getDraftAttachments, saveDraftAttachments } from '@/lib/composer-attachment-drafts'
import { useRealtimeDictation } from './useRealtimeDictation'
import { useDictation } from './useDictation'

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
            onFinalTranscript,
            onTextChange: onFinalTranscript
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

    it.each(['', 'follow-up typed while sending'])('preserves destination and source drafts after background success: %s', async (sourceDraft) => {
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
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript,
            onTextChange: onFinalTranscript,
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
        unmount()
        act(() => {
            saveDraft('session-A', sourceDraft)
            saveDraft('session-A-resumed', 'destination draft')
        })
        const attachment = new File(['follow-up'], 'follow-up.txt')
        saveDraftAttachments('session-A-resumed', [{ id: 'target-file', file: attachment }])
        const replacement = renderHook(() => {
            const [text, setText] = useState('')
            useComposerDraft('session-A-resumed', text, [], false, setText, async () => {})
            return { text, setText }
        })
        await waitFor(() => expect(replacement.result.current.text).toBe('destination draft'))
        act(() => replacement.result.current.setText('live destination'))
        await act(async () => { resolveSend?.() })
        await waitFor(() => expect(onSessionResolved).toHaveBeenCalled())
        expect(resolveSessionId).toHaveBeenCalledWith('session-A')
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
        const expected = ['live destination', sourceDraft].filter(Boolean).join(' ')
        await waitFor(() => expect(replacement.result.current.text).toBe(expected))
        replacement.unmount()
        expect(getDraft('session-A-resumed')).toBe(expected)
        expect((await getDraftAttachments('session-A-resumed')).map(file => file.name)).toEqual(['follow-up.txt'])
        const addAttachment = vi.fn(async () => {})
        const reopened = renderHook(() => useComposerDraft('session-A-resumed', '', [], true, vi.fn(), addAttachment))
        await waitFor(() => expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'follow-up.txt' })))
        reopened.unmount()
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
            onTextChange: onFinalTranscript,
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

    it.each([[false, false], [true, false], [false, true]])('preserves follow-ups after resume/send failure, sameId=%s, targetBefore=%s', async (sameId, targetBefore) => {
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
        const resolveSessionId = vi.fn(async () => {
            if (targetBefore) {
                saveDraft('session-A-resumed', 'existing destination')
                unmount()
                await Promise.resolve()
            }
            if (sameId) {
                saveDraft('session-A', 'source follow-up')
                unmount()
                await Promise.resolve()
            }
            return { sessionId: sameId ? 'session-A' : 'session-A-resumed', resumed: true }
        })
        const onSessionResolved = vi.fn()
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onFinalTranscript,
            onTextChange: onFinalTranscript,
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
        if (sameId) {
            await act(async () => { rejectSend?.(new Error('network down')) })
            await waitFor(() => expect(getDraft('session-A')).toBe('source follow-up explicit initial text spoken words'))
            expect(onSessionResolved).toHaveBeenCalledWith('session-A')
            return
        }
        if (targetBefore) {
            await act(async () => { rejectSend?.(new Error('network down')) })
            await waitFor(() => expect(getDraft('session-A-resumed')).toBe('existing destination explicit initial text spoken words'))
            return
        }
        act(() => {
            saveDraft('session-A-resumed', 'newer resumed draft')
            saveDraft('session-A', 'source follow-up')
        })
        unmount()
        const replacement = renderHook(() => {
            const [text, setText] = useState('')
            useComposerDraft('session-A-resumed', text, [], false, setText, async () => {})
            return text
        })
        await waitFor(() => expect(replacement.result.current).toBe('newer resumed draft'))
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => {
            await waitFor(() => expect(getDraft('session-A-resumed')).toBe('newer resumed draft source follow-up explicit initial text spoken words'))
        })

        await waitFor(() => expect(replacement.result.current).toBe('newer resumed draft source follow-up explicit initial text spoken words'))
        replacement.unmount()
        expect(getDraft('session-A-resumed')).toBe('newer resumed draft source follow-up explicit initial text spoken words')

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
        const { result } = renderHook(() => useDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onTextChange: (text) => { composerText = text },
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
        const { result } = renderHook(() => useDictation({
            api,
            provider: 'elevenlabs',
            mode: 'realtime',
            onTextChange: (text) => { composerText = text },
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
