import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { ConversationStatus, StatusCallback } from '@/realtime/types'
// Deep imports instead of the '@/realtime' barrel: the barrel re-exports the
// voice backend components, which drag the ElevenLabs SDK vendor chunk into
// the eager graph (App renders VoiceProvider unconditionally).
import { getVoiceSession, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession'
import { voiceHooks } from '@/realtime/hooks/voiceHooks'
import {
    VOICE_BACKEND_MOUNT_REQUEST_EVENT,
    VOICE_BACKEND_READY_EVENT,
    voiceBackendEpochs
} from '@/realtime/voiceBackendEvents'
import { storeVoiceContextNotice } from '@/lib/voiceContextStream'
import { getElevenLabsCodeFromPreference } from '@/lib/languages'
import { readStoredVoiceSelection } from '@/lib/voicePickerPreferences'

interface VoiceContextValue {
    status: ConversationStatus
    errorMessage: string | null
    micMuted: boolean
    currentSessionId: string | null
    setStatus: (status: ConversationStatus, errorMessage?: string) => void
    setMicMuted: (muted: boolean) => void
    toggleMic: () => void
    startVoice: (sessionId: string) => Promise<void>
    stopVoice: () => Promise<void>
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

/**
 * Ask the mounted VoiceBackendSession to load + register the selected backend
 * chunk and wait until it is registered. Resolves early when a session is
 * already registered, and gives up after `timeoutMs` so a missing/slow
 * backend degrades to the old "No voice session registered" warning instead
 * of hanging the mic button forever.
 */
async function ensureVoiceBackendMounted(timeoutMs = 5_000): Promise<void> {
    // A registered session is only trustworthy when its registration is
    // newer than the last backend-selection change (ready > stale). After a
    // preference refresh the old provider's session may still be registered,
    // so a fresh registration must be awaited before starting.
    const before = voiceBackendEpochs()
    if (getVoiceSession() !== null && before.ready > before.stale) return
    window.dispatchEvent(new Event(VOICE_BACKEND_MOUNT_REQUEST_EVENT))
    {
        const now = voiceBackendEpochs()
        if (getVoiceSession() !== null && now.ready > now.stale && now.ready > before.ready) return
    }
    await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
            const now = voiceBackendEpochs()
            // A READY dispatched by the *previous* provider (racing the
            // refresh) must not satisfy this wait: require a registration
            // newer than the one we observed on entry.
            if (now.ready <= before.ready && now.ready <= before.stale) return
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            window.removeEventListener(VOICE_BACKEND_READY_EVENT, finish)
            resolve()
        }
        const timer = window.setTimeout(() => {
            if (settled) return
            settled = true
            window.removeEventListener(VOICE_BACKEND_READY_EVENT, finish)
            resolve()
        }, timeoutMs)
        window.addEventListener(VOICE_BACKEND_READY_EVENT, finish)
    })
}

export function VoiceProvider({ children }: { children: ReactNode }) {
    const [status, setStatusInternal] = useState<ConversationStatus>('disconnected')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [micMuted, setMicMuted] = useState(false)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

    const setStatus: StatusCallback = useCallback((newStatus, error) => {
        setStatusInternal(newStatus)
        if (newStatus === 'error') {
            setErrorMessage(error ?? null)
        } else if (newStatus === 'connected') {
            setErrorMessage(null)
        }
    }, [])

    const toggleMic = useCallback(() => {
        setMicMuted((prev) => !prev)
    }, [])

    const startInFlightRef = useRef(false)
    const startVoice = useCallback(async (sessionId: string) => {
        // Repeated taps must not stack concurrent realtime connections: the
        // first in-flight start owns the transition and later taps no-op.
        if (startInFlightRef.current) return
        startInFlightRef.current = true
        try {
        await startVoiceInner(sessionId)
        } finally {
            startInFlightRef.current = false
        }
    }, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const startVoiceInner = useCallback(async (sessionId: string) => {
        setCurrentSessionId(sessionId)
        // The backend component mounts lazily (chunk split); make sure it has
        // registered its session before asking it to start.
        await ensureVoiceBackendMounted()
        const contextPlan = voiceHooks.prepareVoiceSession(sessionId)
        storeVoiceContextNotice(contextPlan.notice)

        const voiceLang = localStorage.getItem('hapi-voice-lang')
        const elevenLabsLang = getElevenLabsCodeFromPreference(voiceLang)
        const voiceId = readStoredVoiceSelection('elevenlabs') ?? undefined

        await startRealtimeSession(sessionId, {
            bootstrap: contextPlan.bootstrap,
            streamChunks: contextPlan.streamChunks,
            notice: contextPlan.notice
        }, elevenLabsLang, voiceId)
    }, [])

    const stopVoice = useCallback(async () => {
        voiceHooks.onVoiceStopped()
        await stopRealtimeSession()
        setCurrentSessionId(null)
        setStatusInternal('disconnected')
        setErrorMessage(null)
    }, [])

    return (
        <VoiceContext.Provider
            value={{
                status,
                errorMessage,
                micMuted,
                currentSessionId,
                setStatus,
                setMicMuted,
                toggleMic,
                startVoice,
                stopVoice
            }}
        >
            {children}
        </VoiceContext.Provider>
    )
}

export function useVoice(): VoiceContextValue {
    const context = useContext(VoiceContext)
    if (!context) {
        throw new Error('useVoice must be used within a VoiceProvider')
    }
    return context
}

export function useVoiceOptional(): VoiceContextValue | null {
    return useContext(VoiceContext)
}
