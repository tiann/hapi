import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceBackendSession } from '@/realtime/VoiceBackendSession'
import type { ApiClient } from '@/api/client'

const fetchVoiceBackendMock = vi.fn()

vi.mock('@/api/voice', () => ({
    fetchVoiceBackend: (api: ApiClient) => fetchVoiceBackendMock(api),
}))

vi.mock('@/realtime/RealtimeVoiceSession', () => ({
    RealtimeVoiceSession: () => null,
}))

vi.mock('@/realtime/GeminiLiveVoiceSession', () => ({
    GeminiLiveVoiceSession: () => null,
}))

vi.mock('@/realtime/QwenVoiceSession', () => ({
    QwenVoiceSession: () => null,
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
