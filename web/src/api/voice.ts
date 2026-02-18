import type { ApiClient } from './client'

export interface VoiceTranscriptionResponse {
    ok: boolean
    text?: string
    error?: string
}

export async function transcribeVoiceAudio(
    api: ApiClient,
    audio: Blob,
    language?: string
): Promise<VoiceTranscriptionResponse> {
    try {
        return await api.transcribeVoiceAudio(audio, language)
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Network error'
        }
    }
}

export function buildVoiceWebSocketUrl(api: ApiClient): string {
    const base = api.getBaseUrl() || window.location.origin
    const token = api.getAuthToken()
    const wsBase = base.replace(/^http/, 'ws')
    return `${wsBase}/api/voice/ws?token=${encodeURIComponent(token || '')}`
}
