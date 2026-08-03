import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TranscriptionProviderInfo } from '@hapi/protocol/voice'
import { I18nProvider } from '@/lib/i18n-context'
import { useVoiceSettings } from './useVoiceSettings'

const { fetchTranscriptionProviders, fetchVoiceBackend, fetchVoices, pause, play } = vi.hoisted(() => ({
    fetchTranscriptionProviders: vi.fn((): Promise<{ providers: TranscriptionProviderInfo[] }> => Promise.resolve({ providers: [] })),
    fetchVoiceBackend: vi.fn(),
    fetchVoices: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/app-context', () => {
    const api = { fetchTranscriptionProviders }
    return { useAppContext: () => ({ api }) }
})

vi.mock('@/api/voice', () => ({
    fetchVoiceBackend,
    fetchVoices,
}))

function Wrapper(props: { children: React.ReactNode }) {
    return <I18nProvider>{props.children}</I18nProvider>
}

describe('useVoiceSettings', () => {
    afterEach(() => vi.unstubAllGlobals())

    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        fetchVoiceBackend.mockResolvedValue({ backend: 'elevenlabs', backends: ['elevenlabs'] })
        fetchVoices.mockResolvedValue([])
        class MockAudio {
            constructor(_source: string) {}
            play = play
            pause = pause
            addEventListener = vi.fn()
        }
        vi.stubGlobal('Audio', MockAudio)
    })

    it('loads dynamic voices and keeps the existing per-backend storage key', async () => {
        fetchVoices.mockResolvedValue([
            { id: 'dynamic-1', name: 'Dynamic Voice', previewUrl: 'https://example.test/voice.mp3', category: 'premade' },
        ])
        const { result } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })

        await waitFor(() => expect(result.current.voices[0]?.id).toBe('dynamic-1'))
        act(() => result.current.setVoice('dynamic-1'))

        expect(localStorage.getItem('hapi-voice-elevenlabs')).toBe('dynamic-1')
    })

    it('switches configured backends and restores the backend-specific selection', async () => {
        localStorage.setItem('hapi-voice-elevenlabs', 'eleven-1')
        fetchVoiceBackend.mockResolvedValue({
            backend: 'gemini-live',
            backends: ['gemini-live', 'elevenlabs'],
        })
        const { result } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })

        await waitFor(() => expect(result.current.backend).toBe('gemini-live'))
        act(() => result.current.setBackend('elevenlabs'))

        expect(result.current.backend).toBe('elevenlabs')
        expect(result.current.voiceId).toBe('eleven-1')
        expect(localStorage.getItem('hapi-voice-backend')).toBe('elevenlabs')
    })

    it('stops a playing preview when the picker unmounts', async () => {
        fetchVoices.mockResolvedValue([
            { id: 'dynamic-1', name: 'Dynamic Voice', previewUrl: 'https://example.test/voice.mp3', category: 'premade' },
        ])
        const { result, unmount } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })
        await waitFor(() => expect(result.current.voices[0]?.id).toBe('dynamic-1'))

        act(() => result.current.previewVoice(result.current.voices[0]))
        expect(play).toHaveBeenCalledOnce()
        unmount()
        expect(pause).toHaveBeenCalled()
    })

    it('uses realtime for the realtime-only browser provider', async () => {
        class MockSpeechRecognition {
            static available() { return Promise.resolve('available') }
            processLocally = false
        }
        Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false })
        vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
        localStorage.setItem('hapi-transcription-mode', 'standard')

        const { result } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })

        await waitFor(() => expect(result.current.provider).toBe('browser-local'))
        expect(result.current.transcriptionMode).toBe('realtime')
    })

    it('does not expose browser dictation without the selected language pack', async () => {
        fetchTranscriptionProviders.mockResolvedValueOnce({
            providers: [{ id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }]
        })
        class MockSpeechRecognition {
            static available() { return Promise.resolve('unavailable') }
            processLocally = false
        }
        Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false })
        vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)

        const { result } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })

        await waitFor(() => expect(result.current.provider).toBe('openai'))
        expect(result.current.providers).toHaveLength(1)
    })

    it('rechecks the on-device language pack when the language changes', async () => {
        fetchTranscriptionProviders.mockResolvedValue({
            providers: [{ id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }]
        })
        class MockSpeechRecognition {
            static available({ langs }: { langs: string[] }) {
                return Promise.resolve(langs[0] === 'en-US' ? 'available' : 'unavailable')
            }
            processLocally = false
        }
        Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false })
        vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
        localStorage.setItem('hapi-voice-lang', 'en-US')
        localStorage.setItem('hapi-transcription-provider', 'browser-local')
        const { result } = renderHook(() => useVoiceSettings(), { wrapper: Wrapper })
        await waitFor(() => expect(result.current.provider).toBe('browser-local'))

        act(() => result.current.setVoiceLanguage({ code: 'zh-CN', name: 'Chinese', nativeName: '中文' }))
        await waitFor(() => expect(result.current.provider).toBe('openai'))

        act(() => result.current.setVoiceLanguage({ code: 'en-US', name: 'English', nativeName: 'English' }))
        await waitFor(() => expect(result.current.provider).toBe('browser-local'))
    })
})
