import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { RealtimeVoiceSessionProps } from './RealtimeVoiceSession'
import { fetchVoiceBackend } from '@/api/voice'
import { resolveSelectedVoiceBackend } from '@/lib/voicePickerPreferences'
import type { ApiClient } from '@/api/client'
import type { VoiceBackendType } from '@hapi/protocol/voice'

// Lazy-load voice backends so users who never start a voice session do not
// download or parse the ElevenLabs/LiveKit, Gemini, or Qwen SDK chunks upfront.
const RealtimeVoiceSession = lazy(() =>
    import('./RealtimeVoiceSession').then((m) => ({ default: m.RealtimeVoiceSession }))
)
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
 * Selects voice session from user preference (when multiple backends configured) or hub default.
 * Re-resolves on mount and whenever Settings changes the backend preference
 * (`hapi-voice-backends-refresh`), so preview selection cannot disagree with the registered
 * realtime session.
 * Only signals readiness after the selected backend has mounted and registered its session.
 */
export function VoiceBackendSession(props: VoiceBackendSessionProps) {
    const [backend, setBackend] = useState<VoiceBackendType | null>(null)
    const [resolveEpoch, setResolveEpoch] = useState(0)

    useEffect(() => {
        const onRefresh = () => setResolveEpoch((n) => n + 1)
        window.addEventListener('hapi-voice-backends-refresh', onRefresh)
        return () => window.removeEventListener('hapi-voice-backends-refresh', onRefresh)
    }, [])

    useEffect(() => {
        let cancelled = false
        setBackend(null)
        fetchVoiceBackend(props.api).then((resp) => {
            if (!cancelled) {
                setBackend(resolveSelectedVoiceBackend(resp.backends, resp.backend))
            }
        }).catch((err: unknown) => {
            if (!cancelled) {
                // Detection runs on mount for every session, not in response to a user action,
                // so it must not raise the global voice error banner. Leaving `backend` null
                // keeps `onReadyChange` false, which disables the voice button.
                console.error('Could not detect voice backend:', err)
            }
        })
        return () => {
            cancelled = true
            props.onReadyChange?.(false)
        }
    }, [props.api, resolveEpoch]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleRegistered = useCallback(() => {
        props.onReadyChange?.(true)
    }, [props.onReadyChange])

    if (!backend) return null

    if (backend === 'gemini-live') {
        return (
            <Suspense fallback={null}>
                <GeminiLiveVoiceSession {...props} onRegistered={handleRegistered} />
            </Suspense>
        )
    }

    if (backend === 'qwen-realtime') {
        return (
            <Suspense fallback={null}>
                <QwenVoiceSession {...props} onRegistered={handleRegistered} />
            </Suspense>
        )
    }

    return (
        <Suspense fallback={null}>
            <RealtimeVoiceSession {...props} onRegistered={handleRegistered} />
        </Suspense>
    )
}
