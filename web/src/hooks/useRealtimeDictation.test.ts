import { useState } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerDraft } from './useComposerDraft'
import type { ApiClient } from '@/api/client'
import { resolveVoiceSession } from '@/lib/dictationSend'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import { getDraftAttachments, saveDraftAttachments } from '@/lib/composer-attachment-drafts'
import { useRealtimeDictation } from './useRealtimeDictation'
import { useDictation } from './useDictation'

const scribe = vi.hoisted(() => ({
    options: {} as Record<string, (value?: unknown) => void>,
    closed: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    commit: vi.fn()
}))

vi.mock('@elevenlabs/client', () => ({
    CommitStrategy: { MANUAL: 'manual' },
    RealtimeEvents: {
        SESSION_STARTED: 'session_started', PARTIAL_TRANSCRIPT: 'partial_transcript',
        COMMITTED_TRANSCRIPT: 'committed_transcript', ERROR: 'error', CLOSE: 'close'
    },
    Scribe: {
        connect: scribe.connect.mockImplementation(() => {
            scribe.options = {}
            scribe.closed = false
            return {
                on: (event: string, callback: (value?: unknown) => void) => {
                    const key = {
                        session_started: 'onSessionStarted', partial_transcript: 'onPartialTranscript',
                        committed_transcript: 'onCommittedTranscript', error: 'onError', close: 'onDisconnect'
                    }[event]
                    if (key) scribe.options[key] = (value) => {
                        if (event !== 'close' && scribe.closed) return
                        callback(event === 'error' && value instanceof Error ? { error: value.message } : value)
                    }
                },
                close: () => {
                    scribe.closed = true
                    scribe.disconnect()
                    scribe.options.onDisconnect?.()
                },
                commit: scribe.commit
            }
        })
    }
}))

// The React SDK closes its Scribe connection on unmount, independently of our cleanup.
vi.mock('@elevenlabs/react', async () => {
    const { useEffect } = await import('react')
    return {
        CommitStrategy: { MANUAL: 'manual' },
        useScribe: (callbacks: Record<string, (value?: unknown) => void>) => {
            useEffect(() => () => { scribe.disconnect() }, [])
            scribe.options = callbacks
            return { connect: async () => {}, disconnect: scribe.disconnect, commit: scribe.commit }
        }
    }
})

type ScribeCallbacks = {
    onPartialTranscript: (event: { text: string }) => void
    onDisconnect: () => void
    onCommittedTranscript: (event: { text: string }) => void
    onError: (error: unknown) => void
}

describe('useRealtimeDictation', () => {
    afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

    it.each(['committed', 'timeout'])('keeps ElevenLabs connected after unmount until %s finalization', async (completion) => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        scribe.commit.mockImplementation(() => {})
        clearDraft('session-A')
        const sendMessage = vi.fn(async () => {})
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api, provider: 'elevenlabs', mode: 'realtime',
            onFinalTranscript: vi.fn(), onTextChange: vi.fn(), sendMessage
        }))
        await act(() => result.current.toggle())
        act(() => (scribe.options as ScribeCallbacks).onPartialTranscript({ text: 'partial words' }))
        if (completion === 'timeout') vi.useFakeTimers()
        let pending: Promise<void>
        act(() => { pending = result.current.stopAndSend('session-A', 'initial text') })
        unmount()
        expect(scribe.disconnect).not.toHaveBeenCalled()
        await act(async () => {
            if (completion === 'committed') {
                (scribe.options as ScribeCallbacks).onCommittedTranscript({ text: 'final committed words' })
            } else {
                await vi.advanceTimersByTimeAsync(2_500)
            }
            await pending!
        })
        vi.useRealTimers()
        expect(sendMessage).toHaveBeenCalledExactlyOnceWith('session-A', completion === 'committed'
            ? 'initial text final committed words' : 'initial text partial words', undefined)
        expect(scribe.disconnect).toHaveBeenCalledTimes(1)
    })

    it('resumes a session that goes offline before background finalization using the live resolver', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() },
        })
        scribe.commit.mockImplementation(() => {})
        let active = true
        const getSession = vi.fn(async () => ({ session: { id: 'voice-live', active, permissionMode: 'default' } }))
        const resumeSession = vi.fn(async () => 'voice-resumed')
        const sendMessage = vi.fn(async () => {})
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' })),
            getSession, resumeSession,
        } as unknown as ApiClient
        clearDraft('voice-live')
        clearDraft('voice-resumed')
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api, provider: 'elevenlabs', mode: 'realtime',
            onFinalTranscript: vi.fn(), onTextChange: vi.fn(), sendMessage,
        }))
        await act(() => result.current.toggle())
        let pending: Promise<void>
        act(() => { pending = result.current.stopAndSend('voice-live', 'initial text', undefined, {
            resolveSessionId: sessionId => resolveVoiceSession(api, sessionId),
        }) })
        expect(getSession).not.toHaveBeenCalled()
        unmount()
        active = false
        await act(async () => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript({ text: 'complete words' })
            await pending!
        })
        expect(getSession).toHaveBeenCalledWith('voice-live')
        expect(resumeSession).toHaveBeenCalledWith('voice-live', { permissionMode: 'default' })
        expect(sendMessage).toHaveBeenCalledExactlyOnceWith('voice-resumed', 'initial text complete words', undefined)
        expect(scribe.disconnect).toHaveBeenCalledTimes(1)
        clearDraft('voice-live')
        clearDraft('voice-resumed')
    })

    it('closes an ordinary recording on unmount without sending it', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn() }
        })
        const sendMessage = vi.fn()
        const api = {
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' }))
        } as unknown as ApiClient
        const { result, unmount } = renderHook(() => useRealtimeDictation({
            api, provider: 'elevenlabs', mode: 'realtime',
            onFinalTranscript: vi.fn(), onTextChange: vi.fn(), sendMessage
        }))
        await act(() => result.current.toggle())
        unmount()
        expect(scribe.disconnect).toHaveBeenCalledTimes(1)
        expect(sendMessage).not.toHaveBeenCalled()
    })

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

    it.each([[false, false, false], [true, false, false], [false, true, false], [false, false, true]])('preserves follow-ups after resume/send failure, sameId=%s, targetBefore=%s, beforeHydration=%s', async (sameId, targetBefore, beforeHydration) => {
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
        const frames: FrameRequestCallback[] = []
        const frameSpy = beforeHydration ? vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
            frames.push(callback)
            return frames.length
        }) : undefined
        const replacement = renderHook(() => {
            const [text, setText] = useState('')
            useComposerDraft('session-A-resumed', text, [], false, setText, async () => {})
            return text
        })
        frameSpy?.mockRestore()
        if (!beforeHydration) await waitFor(() => expect(replacement.result.current).toBe('newer resumed draft'))
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => { frames.forEach(callback => callback(performance.now())) })
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

describe('voice sends preserve a repeated follow-up draft', () => {
    afterEach(() => vi.unstubAllGlobals())

    it.each([
        ['standard', false, true, false], ['standard', true, false, false], ['standard', true, true, false],
        ['realtime', false, true, false], ['realtime', true, false, false], ['realtime', true, true, false],
        ['standard', false, true, true], ['standard', true, true, true],
        ['realtime', false, true, true], ['realtime', true, true, true],
    ] as const)('%s send, resumed=%s, unmounted=%s, failed=%s', async (mode, resumed, unmounted, failed) => {
        const source = `repeat-${mode}-${resumed}-${unmounted}-${failed}`
        const target = resumed ? `${source}-resumed` : source
        saveDraft(source, 'continue')
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
        })
        class Recorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onerror: (() => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', Recorder)
        scribe.commit.mockImplementation(() => {
            (scribe.options as ScribeCallbacks).onCommittedTranscript?.({ text: 'spoken words' })
        })
        let complete: (() => void) | undefined
        const sendMessage = vi.fn(() => new Promise<void>((resolve, reject) => {
            complete = failed ? () => reject(new Error('delivery failed')) : resolve
        }))
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'spoken words' })),
            fetchRealtimeTranscriptionToken: vi.fn(async () => ({ token: 'single-use-token' })),
        } as unknown as ApiClient
        const onResolved = vi.fn()
        const view = renderHook(() => {
            const [text, setText] = useState('')
            const hydration = useComposerDraft(source, text, [], false, setText, async () => {})
            const voice = useDictation({
                api, provider: mode === 'standard' ? 'openai' : 'elevenlabs', mode,
                getCurrentText: () => text, onTextChange: setText, sendMessage,
            })
            return { text, setText, hydration, voice }
        })
        await waitFor(() => expect(view.result.current.hydration.complete).toBe(true))
        expect(view.result.current.text).toBe('continue')
        await act(() => view.result.current.voice.toggle())
        await act(async () => {
            view.result.current.setText('')
            await view.result.current.voice.stopAndSend(source, 'continue', undefined, {
                resolveSessionId: async () => ({ sessionId: target, resumed }),
                onSessionResolved: onResolved,
            })
        })
        await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(target, 'continue spoken words', undefined))
        act(() => view.result.current.setText('continue'))
        if (unmounted) view.unmount()
        await act(async () => { complete?.() })
        const expected = failed ? 'continue continue spoken words' : 'continue'
        await waitFor(() => expect(getDraft(target)).toBe(expected))
        if (resumed) {
            await waitFor(() => expect(onResolved).toHaveBeenCalledWith(target))
            // IndexedDB is unavailable here: fallback copies text without retiring the source.
            expect(getDraft(source)).toBe(failed ? '' : 'continue')
        }
        if (!unmounted) view.unmount()
        expect(getDraft(target)).toBe(expected)
        clearDraft(source)
        clearDraft(target)
    })
})
