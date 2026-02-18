import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import type { ConversationStatus, StatusCallback } from '@/realtime/types'
import { startRealtimeSession, stopRealtimeSession, voiceHooks } from '@/realtime'

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

export function VoiceProvider({ children }: { children: ReactNode }) {
    const [status, setStatusInternal] = useState<ConversationStatus>('disconnected')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [micMuted, setMicMuted] = useState(false)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

    const setStatus: StatusCallback = useCallback((newStatus, error) => {
        setStatusInternal(newStatus)
        if (newStatus === 'error') {
            setErrorMessage(error ?? null)
        } else if (newStatus === 'connected' || newStatus === 'processing') {
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

        await startRealtimeSession(sessionId, initialContext, voiceLang ?? undefined)
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
