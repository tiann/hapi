import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { RealtimeVoiceSessionProps } from './RealtimeVoiceSession'
import { getVoiceSession } from './RealtimeSession'
import { fetchVoiceBackend } from '@/api/voice'
import { resolveSelectedVoiceBackend } from '@/lib/voicePickerPreferences'
import {
    VOICE_BACKEND_MOUNT_REQUEST_EVENT,
    VOICE_BACKEND_READY_EVENT,
    bumpVoiceBackendReadyEpoch,
    markVoiceBackendStale
} from './voiceBackendEvents'
import type { ApiClient } from '@/api/client'
import type { VoiceBackendType } from '@hapi/protocol/voice'

// Lazy-load every backend so its SDK chunk only downloads when voice is
// actually used; ElevenLabs used to be a static import (and an eager ~128KB
// gzip vendor chunk on every session open).
const GeminiLiveVoiceSession = lazy(() =>
    import('./GeminiLiveVoiceSession').then((m) => ({ default: m.GeminiLiveVoiceSession }))
)
const QwenVoiceSession = lazy(() =>
    import('./QwenVoiceSession').then((m) => ({ default: m.QwenVoiceSession }))
)
const RealtimeVoiceSession = lazy(() =>
    import('./RealtimeVoiceSession').then((m) => ({ default: m.RealtimeVoiceSession }))
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
 * Signals readiness as soon as a backend is detected (the voice affordance must not wait for a
 * chunk download); the backend component itself mounts lazily on the first voice request and
 * announces registration via VOICE_BACKEND_READY_EVENT, which startVoice awaits.
 */
export function VoiceBackendSession(props: VoiceBackendSessionProps) {
    const [backend, setBackend] = useState<VoiceBackendType | null>(null)
    const [resolveEpoch, setResolveEpoch] = useState(0)
    // The backend component only mounts once voice has been requested (or a
    // session is already registered — e.g. this remount is a session switch
    // while voice is live). Detection stays eager because it is one cheap
    // REST call whose result decides whether the voice affordance shows.
    const [mountRequested, setMountRequested] = useState(() => getVoiceSession() !== null)

    useEffect(() => {
        const onRequestMount = () => setMountRequested(true)
        window.addEventListener(VOICE_BACKEND_MOUNT_REQUEST_EVENT, onRequestMount)
        return () => window.removeEventListener(VOICE_BACKEND_MOUNT_REQUEST_EVENT, onRequestMount)
    }, [])

    useEffect(() => {
        const onRefresh = () => {
            // Any already-registered session may belong to the previous
            // provider until the re-resolved backend re-registers.
            markVoiceBackendStale()
            setResolveEpoch((n) => n + 1)
        }
        window.addEventListener('hapi-voice-backends-refresh', onRefresh)
        return () => window.removeEventListener('hapi-voice-backends-refresh', onRefresh)
    }, [])

    useEffect(() => {
        let cancelled = false
        setBackend(null)
        fetchVoiceBackend(props.api).then((resp) => {
            if (!cancelled) {
                const resolved = resolveSelectedVoiceBackend(resp.backends, resp.backend)
                setBackend(resolved)
                // Readiness now means "a backend is configured": the mic button
                // must be pressable before any backend chunk has downloaded.
                // The chunk itself mounts on the first press via
                // VOICE_BACKEND_MOUNT_REQUEST_EVENT.
                if (resolved) props.onReadyChange?.(true)
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
        // Wake the startVoice caller that requested this mount, and stamp
        // the registration epoch so ensureVoiceBackendMounted can trust it.
        bumpVoiceBackendReadyEpoch()
        window.dispatchEvent(new Event(VOICE_BACKEND_READY_EVENT))
    }, [props.onReadyChange])

    useEffect(() => {
        // Warm the backend chunk once a provider is resolved: list first
        // paint stays lazy (this fires on idle, after paint), and the
        // session is registered before the first mic tap so startVoice's
        // ensure is synchronous — the user-gesture activation chain for
        // audio playback is never broken by a chunk download.
        if (!backend) return
        let cancelled = false
        const warm = () => {
            if (!cancelled) setMountRequested(true)
        }
        const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
        if (typeof idle === 'function') {
            idle(warm, { timeout: 3_000 })
        } else {
            window.setTimeout(warm, 1_500)
        }
        return () => {
            cancelled = true
        }
    }, [backend])

    if (!backend || !mountRequested) return null

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
