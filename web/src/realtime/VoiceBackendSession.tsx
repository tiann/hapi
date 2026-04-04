import { lazy, Suspense, useEffect, useState } from 'react'
import { RealtimeVoiceSession } from './RealtimeVoiceSession'
import type { RealtimeVoiceSessionProps } from './RealtimeVoiceSession'
import type { GeminiLiveVoiceSessionProps } from './GeminiLiveVoiceSession'
import { fetchVoiceBackend } from '@/api/voice'
import type { ApiClient } from '@/api/client'
import type { VoiceBackendType } from '@hapi/protocol/voice'

// Lazy-load Gemini session to avoid bundling @google/genai when using ElevenLabs
const GeminiLiveVoiceSession = lazy(() =>
    import('./GeminiLiveVoiceSession').then((m) => ({ default: m.GeminiLiveVoiceSession }))
)

export type VoiceBackendSessionProps = RealtimeVoiceSessionProps & {
    api: ApiClient
}

/**
 * Dynamically selects the voice session component based on the hub's configured backend.
 * Queries GET /voice/backend once on mount and renders the appropriate component.
 */
export function VoiceBackendSession(props: VoiceBackendSessionProps) {
    const [backend, setBackend] = useState<VoiceBackendType | null>(null)

    useEffect(() => {
        let cancelled = false
        fetchVoiceBackend(props.api).then((resp) => {
            if (!cancelled) setBackend(resp.backend)
        })
        return () => { cancelled = true }
    }, [props.api])

    if (!backend) return null

    if (backend === 'gemini-live') {
        return (
            <Suspense fallback={null}>
                <GeminiLiveVoiceSession {...props} />
            </Suspense>
        )
    }

    return <RealtimeVoiceSession {...props} />
}
