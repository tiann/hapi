export interface VoiceSessionConfig {
    sessionId: string
    initialContext?: string
    language?: string
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>
    endSession(): Promise<void>
    sendTextMessage(message: string): void
    sendContextualUpdate(update: string): void
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'processing' | 'error'
export type ConversationMode = 'speaking' | 'listening'

export type StatusCallback = (status: ConversationStatus, errorMessage?: string) => void
