import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceBackendSession } from '@/realtime/VoiceBackendSession'
import {
    VOICE_BACKEND_MOUNT_REQUEST_EVENT,
    VOICE_BACKEND_READY_EVENT
} from '@/realtime/voiceBackendEvents'
import type { ApiClient } from '@/api/client'

function requestBackendMount() {
    act(() => {
        window.dispatchEvent(new Event(VOICE_BACKEND_MOUNT_REQUEST_EVENT))
    })
}

const fetchVoiceBackendMock = vi.fn()

vi.mock('@/api/voice', () => ({
    fetchVoiceBackend: (api: ApiClient) => fetchVoiceBackendMock(api),
}))

vi.mock('@/realtime/RealtimeVoiceSession', async () => {
    const { useEffect } = await import('react')
    return {
        // Mirrors the real backend: registration happens in a mount effect.
        RealtimeVoiceSession: ({ onRegistered }: { onRegistered?: () => void }) => {
            useEffect(() => { onRegistered?.() }, [onRegistered])
            return <div data-testid="elevenlabs-session" />
        },
    }
})

vi.mock('@/realtime/GeminiLiveVoiceSession', () => ({
    GeminiLiveVoiceSession: () => <div data-testid="gemini-session" />,
}))

vi.mock('@/realtime/QwenVoiceSession', async () => {
    const { useEffect } = await import('react')
    return {
        QwenVoiceSession: ({ onRegistered }: { onRegistered?: () => void }) => {
            useEffect(() => { onRegistered?.() }, [onRegistered])
            return <div data-testid="qwen-session" />
        },
    }
})

const api = {} as ApiClient

describe('VoiceBackendSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('does not report a voice error when backend detection fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const detectionError = new Error('HTTP 404 : 404 Not Found')
        fetchVoiceBackendMock.mockRejectedValue(detectionError)
        const onStatusChange = vi.fn()

        render(<VoiceBackendSession api={api} micMuted={false} onStatusChange={onStatusChange} />)

        await waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(expect.any(String), detectionError)
        })
        expect(onStatusChange).not.toHaveBeenCalled()

        consoleError.mockRestore()
    })

    it('does not mount a voice session when no backend is configured', async () => {
        fetchVoiceBackendMock.mockResolvedValue({ backend: null, backends: [] })
        const onReadyChange = vi.fn()

        const view = render(
            <VoiceBackendSession
                api={api}
                micMuted={false}
                onStatusChange={vi.fn()}
                onReadyChange={onReadyChange}
            />
        )
        await act(async () => {
            await Promise.resolve()
        })

        expect(fetchVoiceBackendMock).toHaveBeenCalledWith(api)
        expect(view.queryByTestId('elevenlabs-session')).toBeNull()
        expect(view.queryByTestId('gemini-session')).toBeNull()
        expect(view.queryByTestId('qwen-session')).toBeNull()
        expect(onReadyChange).not.toHaveBeenCalled()
    })

    it('reports the detected backend as ready without mounting it', async () => {
        fetchVoiceBackendMock.mockResolvedValue({ backend: 'elevenlabs', backends: ['elevenlabs'] })
        const onStatusChange = vi.fn()
        const onReadyChange = vi.fn()

        const view = render(
            <VoiceBackendSession
                api={api}
                micMuted={false}
                onStatusChange={onStatusChange}
                onReadyChange={onReadyChange}
            />
        )

        await waitFor(() => {
            expect(fetchVoiceBackendMock).toHaveBeenCalledWith(api)
        })
        // Readiness (mic button enabled) must not wait for the backend chunk.
        await waitFor(() => {
            expect(onReadyChange).toHaveBeenCalledWith(true)
        })
        // But nothing mounted until voice is actually requested.
        expect(view.queryByTestId('elevenlabs-session')).toBeNull()
        expect(onStatusChange).not.toHaveBeenCalled()
    })

    it('does not mount any backend chunk before a mount request arrives', async () => {
        fetchVoiceBackendMock.mockResolvedValue({ backend: 'elevenlabs', backends: ['elevenlabs'] })

        const view = render(
            <VoiceBackendSession api={api} micMuted={false} onStatusChange={vi.fn()} />
        )

        await waitFor(() => {
            expect(fetchVoiceBackendMock).toHaveBeenCalledWith(api)
        })
        await act(async () => {
            await Promise.resolve()
        })
        expect(view.queryByTestId('elevenlabs-session')).toBeNull()
    })

    it('dispatches the ready event once the requested backend registers', async () => {
        fetchVoiceBackendMock.mockResolvedValue({ backend: 'qwen-realtime', backends: ['qwen-realtime'] })
        const readyListener = vi.fn()
        window.addEventListener(VOICE_BACKEND_READY_EVENT, readyListener)
        try {
            render(<VoiceBackendSession api={api} micMuted={false} onStatusChange={vi.fn()} />)
            await waitFor(() => {
                expect(fetchVoiceBackendMock).toHaveBeenCalledWith(api)
            })

            requestBackendMount()

            // The mocked backend components call onRegistered on mount; wait
            // for the event startVoice relies on.
            await waitFor(() => {
                expect(readyListener).toHaveBeenCalled()
            })
        } finally {
            window.removeEventListener(VOICE_BACKEND_READY_EVENT, readyListener)
        }
    })

    it('remounts the selected backend when settings preference changes', async () => {
        localStorage.clear()
        fetchVoiceBackendMock.mockResolvedValue({
            backend: 'qwen-realtime',
            backends: ['qwen-realtime', 'elevenlabs'],
        })

        const view = render(
            <VoiceBackendSession api={api} micMuted={false} onStatusChange={vi.fn()} />
        )

        // Backends mount only after voice is requested (chunk splitting).
        requestBackendMount()

        await waitFor(() => {
            expect(view.getByTestId('qwen-session')).toBeTruthy()
        })

        localStorage.setItem('hapi-voice-backend', 'elevenlabs')
        act(() => {
            window.dispatchEvent(new Event('hapi-voice-backends-refresh'))
        })

        await waitFor(() => {
            expect(view.getByTestId('elevenlabs-session')).toBeTruthy()
        })
        expect(view.queryByTestId('qwen-session')).toBeNull()
    })
})
