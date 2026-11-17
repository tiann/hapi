import { useEffect } from 'react'
import { useConversation } from '@elevenlabs/react'
import { realtimeClientTools } from './realtimeClientTools'

type ConversationInstance = ReturnType<typeof useConversation>

export interface ElevenLabsConversationBridgeProps {
    micMuted: boolean
    onConnect: () => void
    onDisconnect: () => void
    onMessage: (data: unknown) => void
    onError: (error: unknown) => void
    onStatusChange: (data: unknown) => void
    onModeChange: (data: unknown) => void
    onDebug: (message: unknown) => void
    onConversationChange: (conversation: ConversationInstance | null) => void
}

export function ElevenLabsConversationBridge({
    micMuted,
    onConnect,
    onDisconnect,
    onMessage,
    onError,
    onStatusChange,
    onModeChange,
    onDebug,
    onConversationChange,
}: ElevenLabsConversationBridgeProps) {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        micMuted,
        onConnect,
        onDisconnect,
        onMessage,
        onError,
        onStatusChange,
        onModeChange,
        onDebug,
    })

    useEffect(() => {
        onConversationChange(conversation)
        return () => {
            onConversationChange(null)
        }
    }, [conversation, onConversationChange])

    return null
}
