import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceBackendSession } from '@/realtime/VoiceBackendSession'
import type { ApiClient } from '@/api/client'

const fetchVoiceBackendMock = vi.fn()

vi.mock('@/api/voice', () => ({
    fetchVoiceBackend: (api: ApiClient) => fetchVoiceBackendMock(api),
}))

vi.mock('@/realtime/RealtimeVoiceSession', () => ({
    RealtimeVoiceSession: () => <div data-testid="elevenlabs-session" />,
}))

vi.mock('@/realtime/GeminiLiveVoiceSession', () => ({
    GeminiLiveVoiceSession: () => <div data-testid="gemini-session" />,
}))

vi.mock('@/realtime/QwenVoiceSession', () => ({
    QwenVoiceSession: () => <div data-testid="qwen-session" />,
}))

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

    it('reports the detected backend as ready', async () => {
        fetchVoiceBackendMock.mockResolvedValue({ backend: 'elevenlabs', backends: ['elevenlabs'] })
        const onStatusChange = vi.fn()

        render(<VoiceBackendSession api={api} micMuted={false} onStatusChange={onStatusChange} />)

        await waitFor(() => {
            expect(fetchVoiceBackendMock).toHaveBeenCalledWith(api)
        })
        expect(onStatusChange).not.toHaveBeenCalled()
    })
})
