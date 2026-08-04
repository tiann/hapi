import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useVoiceInputPreferences } from './useVoiceInputPreferences'

function installPartialSpeechRecognition(available = vi.fn(() => Promise.resolve('available'))) {
    class MockSpeechRecognition {
        static available = available
        processLocally = false
    }
    Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false })
    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
    return available
}

describe('useVoiceInputPreferences', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('discovers browser-local support from its shape without probing available on mount', async () => {
        const available = installPartialSpeechRecognition()
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
            userAgentData: { platform: 'macOS', mobile: false },
            language: 'en-US'
        })
        const api = {
            fetchTranscriptionProviders: vi.fn(async () => ({ providers: [] }))
        }

        const { result } = renderHook(() => useVoiceInputPreferences(api as unknown as ApiClient))

        await waitFor(() => expect(result.current.provider).toBe('browser-local'))
        expect(available).not.toHaveBeenCalled()
    })

    it('does not expose or probe partial browser-local speech APIs on Android', async () => {
        const available = installPartialSpeechRecognition()
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15; WebView)', language: 'en-US' })
        const api = {
            fetchTranscriptionProviders: vi.fn(async () => ({
                providers: [{ id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }]
            }))
        }

        const { result } = renderHook(() => useVoiceInputPreferences(api as unknown as ApiClient))

        await waitFor(() => expect(result.current.provider).toBe('openai'))
        expect(result.current.providers).toHaveLength(1)
        expect(available).not.toHaveBeenCalled()
    })
})
