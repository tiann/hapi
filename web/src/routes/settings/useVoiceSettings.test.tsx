import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { useVoiceSettings } from './useVoiceSettings'

const { fetchVoiceBackend, fetchVoices, pause, play } = vi.hoisted(() => ({
    fetchVoiceBackend: vi.fn(),
    fetchVoices: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/api/voice', () => ({
    fetchVoiceBackend,
    fetchVoices,
}))

function Wrapper(props: { children: React.ReactNode }) {
    return <I18nProvider>{props.children}</I18nProvider>
}

describe('useVoiceSettings', () => {
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
})
