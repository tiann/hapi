import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import { appendTranscript, useDictation } from './useDictation'

describe('appendTranscript', () => {
    it('preserves the draft and adds one separator', () => {
        expect(appendTranscript('existing draft  ', '  dictated words  ')).toBe('existing draft  dictated words')
        expect(appendTranscript('existing draft\n', 'dictated words')).toBe('existing draft\ndictated words')
        expect(appendTranscript('', ' dictated words ')).toBe('dictated words')
        expect(appendTranscript('existing draft', '   ')).toBe('existing draft')
        expect(appendTranscript('請更新 API', 'and run tests')).toBe('請更新 API and run tests')
    })
})

describe('useDictation', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('records and inserts a final transcript under React StrictMode', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'dictated words' }))
        }
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'existing draft',
            onTextChange
        }), { wrapper: StrictMode })

        await act(() => result.current.toggle())
        expect(result.current.status).toBe('connected')
        await act(() => result.current.toggle())

        await waitFor(() => expect(onTextChange).toHaveBeenCalledWith('existing draft dictated words'))
        expect(api.transcribeVoice).toHaveBeenCalledOnce()
        expect(stopTrack).toHaveBeenCalled()
    })

    it('shows on-device partial text and inserts only the final transcript', async () => {
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
            userAgentData: { platform: 'macOS', mobile: false },
            language: 'en-US'
        })
        let recognition: MockSpeechRecognition | null = null
        class MockSpeechRecognition {
            static async available() { return 'available' }
            continuous = false
            interimResults = false
            lang = ''
            processLocally = false
            onresult: ((event: Event & { results: unknown }) => void) | null = null
            onerror: ((event: Event) => void) | null = null
            onend: (() => void) | null = null
            constructor() { recognition = this }
            start() {}
            stop() { this.onend?.() }
            abort() {}
            emit(text: string, isFinal: boolean) {
                const result = Object.assign([{ transcript: text }], { isFinal })
                this.onresult?.({ results: [result] } as unknown as Event & { results: unknown })
            }
        }
        Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', {
            configurable: true,
            writable: true,
            value: false
        })
        vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)

        const onTextChange = vi.fn()
        const { result } = renderHook(() => useDictation({
            api: {} as ApiClient,
            provider: 'browser-local',
            mode: 'realtime',
            getCurrentText: () => 'existing draft',
            onTextChange
        }))

        await act(() => result.current.toggle())
        act(() => recognition?.emit('live words', false))
        expect(result.current.partialTranscript).toBe('live words')
        expect(onTextChange).not.toHaveBeenCalled()
        act(() => recognition?.emit('final words', true))
        await act(() => result.current.toggle())

        await waitFor(() => expect(onTextChange).toHaveBeenCalledWith('existing draft final words'))
        expect(result.current.partialTranscript).toBe('')
    })

    it('sends message to target session when unmounted after stopAndSend', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        let resolveTranscribe: ((res: { text: string }) => void) | null = null
        const api = {
            transcribeVoice: vi.fn(() => new Promise<{ text: string }>((resolve) => { resolveTranscribe = resolve })),
            sendMessage: vi.fn(async () => {})
        }

        const { result, unmount } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange
        }))

        await act(() => result.current.toggle())
        expect(result.current.status).toBe('connected')

        act(() => {
            result.current.stopAndSend('session-A', 'explicit initial text')
        })

        unmount()

        await act(async () => {
            resolveTranscribe?.({ text: 'voice payload' })
        })

        await waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledWith('session-A', 'explicit initial text voice payload', null, undefined, undefined, undefined)
        })
    })

    it('restores draft via onTextChange if sendMessage fails while still mounted', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        let currentText = 'draft text'
        const onTextChange = vi.fn((val) => { currentText = val })
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'voice text' })),
            sendMessage: vi.fn(async () => { throw new Error('Send failed') })
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => currentText,
            onTextChange
        }))

        await act(() => result.current.toggle())
        await act(() => {
            currentText = ''
            return result.current.stopAndSend('session-A', 'draft text')
        })

        await waitFor(() => {
            expect(onTextChange).toHaveBeenCalledWith('draft text voice text')
            expect(result.current.status).toBe('error')
        })
    })

    it('does not clobber non-empty replacement draft if sendMessage fails while mounted', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        let currentText = 'initial'
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'voice text' })),
            sendMessage: vi.fn(async () => { throw new Error('Send failed') })
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => currentText,
            onTextChange
        }))

        await act(() => result.current.toggle())
        act(() => {
            result.current.stopAndSend('session-A', 'initial')
            currentText = 'user typed new text'
        })

        await waitFor(() => {
            expect(result.current.status).toBe('error')
        })
        expect(onTextChange).not.toHaveBeenCalledWith('initial voice text')
    })

    it('does not clobber replacement draft when zero-byte recording completes', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockZeroByteMediaRecorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onerror: (() => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockZeroByteMediaRecorder)

        const onTextChange = vi.fn()
        let currentText = 'initial'
        const api = {
            transcribeVoice: vi.fn(),
            sendMessage: vi.fn()
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => currentText,
            onTextChange
        }))

        await act(() => result.current.toggle())
        act(() => {
            result.current.stopAndSend('session-A', 'initial')
            currentText = 'user typed replacement text'
        })

        await waitFor(() => {
            expect(result.current.status).toBe('error')
            expect(result.current.error).toBe('No audio was recorded')
        })
        // Recovery reseats the failed voice text into the composer and persists
        // it as the draft; text typed afterwards is the live composer source
        // and is never touched by recovery.
        expect(onTextChange).toHaveBeenCalledWith('initial')
        expect(getDraft('session-A')).toBe('initial')
        expect(currentText).toBe('user typed replacement text')
    })

    it('does not transcribe or send when MediaRecorder fails after partial data', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockFailingRecorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onerror: (() => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                // MediaRecorder lifecycle: an error can still be followed by
                // dataavailable (partial bytes) and stop.
                this.onerror?.()
                this.ondataavailable?.({ data: new Blob(['partial'], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockFailingRecorder)

        const onTextChange = vi.fn()
        let currentText = ''
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'should not be transcribed' })),
            sendMessage: vi.fn(async () => {})
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => currentText,
            onTextChange: (value) => { currentText = value; onTextChange(value) }
        }))

        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'draft text'))

        await waitFor(() => {
            expect(result.current.status).toBe('error')
            expect(result.current.error).toBe('Audio recording failed')
        })
        expect(api.transcribeVoice).not.toHaveBeenCalled()
        expect(api.sendMessage).not.toHaveBeenCalled()
        // Draft restored for the failed recording instead of being sent.
        expect(onTextChange).toHaveBeenCalledWith('draft text')
    })

    it('does not transcribe when unmounted without stopAndSend', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'voice text' })),
            sendMessage: vi.fn()
        }

        const { result, unmount } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn()
        }))

        await act(() => result.current.toggle())
        unmount()

        await new Promise((r) => setTimeout(r, 50))
        expect(api.transcribeVoice).not.toHaveBeenCalled()
    })

    it('clears persisted draft when sendMessage succeeds', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        saveDraft('session-A', 'old draft')

        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'voice text' })),
            sendMessage: vi.fn(async () => {})
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn()
        }))

        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'initial draft'))

        await waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledWith('session-A', 'initial draft voice text', null, undefined, undefined, undefined)
        })
        expect(getDraft('session-A')).toBe('')
    })

    it('forwards saved language from localStorage to transcribeVoice', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)
        localStorage.setItem('hapi-voice-lang', 'zh-TW')

        const api = {
            transcribeVoice: vi.fn(async () => ({ text: '轉錄內容' }))
        }
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn()
        }))

        await act(() => result.current.toggle())
        await act(() => result.current.toggle())

        await waitFor(() => {
            expect(api.transcribeVoice).toHaveBeenCalledWith(expect.objectContaining({
                language: 'zh-TW'
            }))
        })
    })

    it('forwards deliveryMode to sendMessage when stopAndSend specifies it', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const sendMessage = vi.fn(async () => {})
        const api = {
            transcribeVoice: vi.fn(async () => ({ text: 'steer me' })),
            sendMessage
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn(),
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'initial', 'steer'))

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith('session-A', 'initial steer me', 'steer')
        })
    })

    it('does not clear newer draft saved after stopAndSend started', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
            static isTypeSupported() { return true }
            state: RecordingState = 'inactive'
            mimeType = 'audio/webm'
            ondataavailable: ((event: BlobEvent) => void) | null = null
            onstop: (() => void) | null = null
            start() { this.state = 'recording' }
            stop() {
                this.state = 'inactive'
                this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent)
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        saveDraft('session-A', 'draft at start')

        const sendMessage = vi.fn(async () => {})
        const api = {
            transcribeVoice: vi.fn(async () => {
                // Simulate user editing draft during transcription
                saveDraft('session-A', 'newer draft typed by user')
                return { text: 'transcribed' }
            }),
            sendMessage
        }

        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn(),
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(() => result.current.stopAndSend('session-A', 'initial draft'))

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith('session-A', 'initial draft transcribed', undefined)
        })
        expect(getDraft('session-A')).toBe('newer draft typed by user')
    })

    it('reports supported as false when browser recording APIs are unavailable', () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: undefined
        })
        const { result } = renderHook(() => useDictation({
            api: {} as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => '',
            onTextChange: vi.fn()
        }))

        expect(result.current.supported).toBe(false)
    })

    it('resumes an inactive session before sending and notifies the resolved session', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        const sendMessage = vi.fn(async () => {})
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange,
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'explicit initial text', undefined, {
                resolveSessionId,
                onSessionResolved
            })
        })

        expect(resolveSessionId).toHaveBeenCalledWith('session-A')
        // Message goes to the resumed session id, not the inactive original.
        expect(sendMessage).toHaveBeenCalledWith('session-A-resumed', 'explicit initial text voice payload', undefined)
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
    })

    it('does not notify when the resolver did not resume the session', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A', resumed: false }))
        const onSessionResolved = vi.fn()
        const sendMessage = vi.fn(async () => {})
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange,
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text', undefined, {
                resolveSessionId,
                onSessionResolved
            })
        })

        expect(sendMessage).toHaveBeenCalledWith('session-A', 'initial text voice payload', undefined)
        expect(onSessionResolved).not.toHaveBeenCalled()
    })

    it('fails the send without sending when the session cannot be resumed', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const resolveSessionId = vi.fn(async () => {
            throw new Error('Session is archived. Reopen it to send your message.')
        })
        const sendMessage = vi.fn(async () => {})
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange,
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text', undefined, { resolveSessionId })
        })

        expect(sendMessage).not.toHaveBeenCalled()
        expect(result.current.error).toBe('Session is archived. Reopen it to send your message.')
        // The failed send text is preserved in the draft store for the composer.
        expect(getDraft('session-A')).toBe('initial text voice payload')
    })

    it('recovers a post-resume send failure under the resumed session id', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        const sendMessage = vi.fn(async () => { throw new Error('network down') })
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange,
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text', undefined, {
                resolveSessionId,
                onSessionResolved
            })
        })

        expect(sendMessage).toHaveBeenCalledWith('session-A-resumed', 'initial text voice payload', undefined)
        // The source session is superseded: recovery lives under the resumed id,
        // and the UI is pointed at the resumed session.
        expect(getDraft('session-A-resumed')).toBe('initial text voice payload')
        expect(getDraft('session-A')).toBe('')
        expect(onSessionResolved).toHaveBeenCalledWith('session-A-resumed')
        expect(result.current.error).toBe('network down')
    })

    it('does not overwrite a newer resumed-session draft when a post-resume send fails', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const onTextChange = vi.fn()
        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        let rejectSend: ((error: Error) => void) | null = null
        const sendMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => 'initial text',
            onTextChange,
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text', undefined, {
                resolveSessionId,
                onSessionResolved
            })
        })
        // The send is now in flight against the resumed session; the operator
        // types a newer draft there before it rejects.
        await act(async () => {
            await waitFor(() => expect(sendMessage).toHaveBeenCalled())
        })
        act(() => { saveDraft('session-A-resumed', 'newer draft typed by user') })
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => {
            await waitFor(() => expect(result.current.error).toBe('network down'))
        })

        // Both the newer draft and the failed voice message survive.
        expect(getDraft('session-A-resumed')).toBe('newer draft typed by user initial text voice payload')
        expect(getDraft('session-A')).toBe('')
    })

    it('preserves live composer text typed while the send is pending', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        const resolveSessionId = vi.fn(async () => ({ sessionId: 'session-A-resumed', resumed: true }))
        const onSessionResolved = vi.fn()
        let rejectSend: ((error: Error) => void) | null = null
        const sendMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
        const api = { transcribeVoice: vi.fn(async () => ({ text: 'voice payload' })) }
        let composerText = ''
        clearDraft('session-A')
        clearDraft('session-A-resumed')
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => composerText,
            onTextChange: (text) => { composerText = text },
            sendMessage
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text', undefined, {
                resolveSessionId,
                onSessionResolved
            })
        })
        // The send is in flight; the operator types replacement text into the
        // mounted composer (in memory, not yet persisted).
        await act(async () => {
            await waitFor(() => expect(sendMessage).toHaveBeenCalled())
        })
        act(() => { composerText = 'replacement typed by user' })
        await act(async () => { rejectSend?.(new Error('network down')) })
        await act(async () => {
            await waitFor(() => expect(result.current.error).toBe('network down'))
        })

        // Live replacement text AND the failed voice message both survive.
        expect(composerText).toBe('replacement typed by user initial text voice payload')
        expect(getDraft('session-A-resumed')).toBe('replacement typed by user initial text voice payload')
    })

    it('preserves live composer text typed while transcription is pending', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
        })

        class MockMediaRecorder {
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
        vi.stubGlobal('MediaRecorder', MockMediaRecorder)

        let rejectTranscribe: ((error: Error) => void) | null = null
        const api = { transcribeVoice: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectTranscribe = reject })) }
        let composerText = ''
        clearDraft('session-A')
        const { result } = renderHook(() => useDictation({
            api: api as unknown as ApiClient,
            provider: 'openai',
            mode: 'standard',
            getCurrentText: () => composerText,
            onTextChange: (text) => { composerText = text },
            sendMessage: vi.fn(async () => {})
        }))

        await act(() => result.current.toggle())
        await act(async () => {
            await result.current.stopAndSend('session-A', 'initial text')
        })
        await act(async () => {
            await waitFor(() => expect(api.transcribeVoice).toHaveBeenCalled())
        })
        act(() => { composerText = 'replacement typed by user' })
        await act(async () => { rejectTranscribe?.(new Error('transcription blew up')) })
        await act(async () => {
            await waitFor(() => expect(result.current.error).toBe('transcription blew up'))
        })

        // Live replacement text AND the failed voice text both survive.
        expect(composerText).toBe('replacement typed by user initial text')
        expect(getDraft('session-A')).toBe('replacement typed by user initial text')
    })
})
