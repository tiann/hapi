import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
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
})
