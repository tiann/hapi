import type { ElevenLabsLanguage } from '@/lib/languages'

export interface VoiceSessionConfig {
    sessionId: string
    initialContext?: string
    language?: ElevenLabsLanguage
    voiceId?: string
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
