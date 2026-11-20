import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import type { ConversationStatus, StatusCallback } from '@/realtime/types'
// Deep imports instead of the '@/realtime' barrel: the barrel re-exports the
// voice backend components, which drag the ElevenLabs SDK vendor chunk into
// the eager graph (App renders VoiceProvider unconditionally).
import { getVoiceSession, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession'
import { voiceHooks } from '@/realtime/hooks/voiceHooks'
import { VOICE_BACKEND_MOUNT_REQUEST_EVENT, VOICE_BACKEND_READY_EVENT } from '@/realtime/voiceBackendEvents'
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
    if (getVoiceSession() !== null) return
    window.dispatchEvent(new Event(VOICE_BACKEND_MOUNT_REQUEST_EVENT))
    if (getVoiceSession() !== null) return
    await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            window.removeEventListener(VOICE_BACKEND_READY_EVENT, finish)
            resolve()
        }
        const timer = window.setTimeout(finish, timeoutMs)
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

    const startVoice = useCallback(async (sessionId: string) => {
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
