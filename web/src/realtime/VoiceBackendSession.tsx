import { lazy, Suspense, useEffect, useState } from 'react'
import { RealtimeVoiceSession } from './RealtimeVoiceSession'
import type { RealtimeVoiceSessionProps } from './RealtimeVoiceSession'
import { fetchVoiceBackend } from '@/api/voice'
import type { ApiClient } from '@/api/client'
import type { VoiceBackendType } from '@hapi/protocol/voice'

// Lazy-load alternative backends to avoid bundling when using ElevenLabs
const GeminiLiveVoiceSession = lazy(() =>
    import('./GeminiLiveVoiceSession').then((m) => ({ default: m.GeminiLiveVoiceSession }))
)
const QwenVoiceSession = lazy(() =>
    import('./QwenVoiceSession').then((m) => ({ default: m.QwenVoiceSession }))
)

export type VoiceBackendSessionProps = RealtimeVoiceSessionProps & {
    api: ApiClient
    onReadyChange?: (ready: boolean) => void
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
            if (!cancelled) {
                setBackend(resp.backend)
                props.onReadyChange?.(true)
            }
        })
        return () => {
            cancelled = true
            props.onReadyChange?.(false)
        }
    }, [props.api]) // eslint-disable-line react-hooks/exhaustive-deps

    if (!backend) return null

    if (backend === 'gemini-live') {
        return (
            <Suspense fallback={null}>
                <GeminiLiveVoiceSession {...props} />
            </Suspense>
        )
    }

    if (backend === 'qwen-realtime') {
        return (
            <Suspense fallback={null}>
                <QwenVoiceSession {...props} />
            </Suspense>
        )
    }

    return <RealtimeVoiceSession {...props} />
}
