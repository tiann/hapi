import type { ElevenLabsLanguage } from '@/lib/languages'

export interface VoiceSessionConfig {
    sessionId: string
    /** Small handshake context (bootstrap); not the full session dump. */
    initialContext?: string
    /** Remaining history streamed via sendContextualUpdate after connect. */
    streamContextChunks?: string[]
    contextNotice?: string | null
    language?: ElevenLabsLanguage
    /** ElevenLabs voice id */
    voiceId?: string
    /** Gemini Live / Qwen Realtime prebuilt voice name */
    voiceName?: string
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>
    endSession(): Promise<void>
    sendTextMessage(message: string): void
    sendContextualUpdate(update: string): void
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type ConversationMode = 'speaking' | 'listening'

export type StatusCallback = (status: ConversationStatus, errorMessage?: string) => void
