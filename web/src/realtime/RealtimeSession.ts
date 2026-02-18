import type { VoiceSession } from './types'

let voiceSession: VoiceSession | null = null
let voiceSessionStarted = false
let currentSessionId: string | null = null

export async function startRealtimeSession(
    sessionId: string,
    initialContext?: string,
    language?: string
) {
    if (!voiceSession) {
        console.warn('[Voice] No voice session registered')
        return
    }

    try {
        currentSessionId = sessionId
        await voiceSession.startSession({
            sessionId,
            initialContext,
            language
        })
        voiceSessionStarted = true
    } catch (error) {
        console.error('[Voice] Failed to start realtime session:', error)
        currentSessionId = null
        voiceSessionStarted = false
    }
}

export async function stopRealtimeSession() {
    if (!voiceSession) {
        return
    }

    try {
        await voiceSession.endSession()
        currentSessionId = null
        voiceSessionStarted = false
    } catch (error) {
        console.error('[Voice] Failed to stop realtime session:', error)
    }
}

export function resetRealtimeSessionState() {
    currentSessionId = null
    voiceSessionStarted = false
}

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession) {
        console.warn('[Voice] Voice session already registered, replacing with new one')
    }
    voiceSession = session
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId
}

export function updateCurrentSessionId(sessionId: string | null) {
    console.log(`[Voice] Realtime session ID updated: ${sessionId}`)
    currentSessionId = sessionId
}
