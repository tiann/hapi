import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ConversationStatus, StatusCallback } from '@/realtime/types'
import { startRealtimeSession, stopRealtimeSession, voiceHooks } from '@/realtime'
import { getElevenLabsCodeFromPreference } from '@/lib/languages'
import { fetchVoiceToken } from '@/api/voice'
import type { ApiClient } from '@/api/client'

interface VoiceContextValue {
    status: ConversationStatus
    errorMessage: string | null
    micMuted: boolean
    currentSessionId: string | null
    isVoiceAllowed: boolean
    isCheckingVoice: boolean
    setStatus: (status: ConversationStatus, errorMessage?: string) => void
    setMicMuted: (muted: boolean) => void
    toggleMic: () => void
    startVoice: (sessionId: string) => Promise<void>
    stopVoice: () => Promise<void>
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

export function VoiceProvider({ children, api }: { children: ReactNode; api: ApiClient | null }) {
    const [status, setStatusInternal] = useState<ConversationStatus>('disconnected')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [micMuted, setMicMuted] = useState(false)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
    const [isVoiceAllowed, setIsVoiceAllowed] = useState(false)
    const [isCheckingVoice, setIsCheckingVoice] = useState(true)

    // Check if voice is allowed on the server
    useEffect(() => {
        if (!api) {
            setIsVoiceAllowed(false)
            setIsCheckingVoice(false)
            return
        }

        let cancelled = false
        setIsCheckingVoice(true)

        fetchVoiceToken(api)
            .then((response) => {
                if (!cancelled) {
                    setIsVoiceAllowed(response.allowed)
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setIsVoiceAllowed(false)
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsCheckingVoice(false)
                }
            })

        return () => {
            cancelled = true
        }
    }, [api])

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
        const initialContext = voiceHooks.onVoiceStarted(sessionId)

        // Read voice language preference from localStorage
        const voiceLang = localStorage.getItem('hapi-voice-lang')
        const elevenLabsLang = getElevenLabsCodeFromPreference(voiceLang)

        await startRealtimeSession(sessionId, initialContext, elevenLabsLang)
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
                isVoiceAllowed,
                isCheckingVoice,
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
