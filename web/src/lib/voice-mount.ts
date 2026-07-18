import type { ConversationStatus } from '@/realtime/types'

export function shouldMountRealtimeVoiceSession(
    status: ConversationStatus | null | undefined,
    requested: boolean
): boolean {
    return requested || status === 'connecting' || status === 'connected'
}
