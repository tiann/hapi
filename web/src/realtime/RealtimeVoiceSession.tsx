import { useEffect, useRef, useCallback, useState } from 'react'
import { useConversation } from '@elevenlabs/react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { realtimeClientTools, registerSessionStore } from './realtimeClientTools'
import { fetchVoiceToken } from '@/api/voice'
import type { VoiceSession, VoiceSessionConfig, ConversationStatus, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

// Debug logging
const DEBUG = import.meta.env.DEV

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null

// Store reference for status updates
let statusCallback: StatusCallback | null = null

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    private api: ApiClient

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!conversationInstance) {
            const error = new Error('Realtime voice session not initialized')
            console.warn('[Voice] Realtime voice session not initialized')
            statusCallback?.('error', 'Voice session not initialized')
            throw error
        }

        statusCallback?.('connecting')

        // Request microphone permission first
        let permissionStream: MediaStream | null = null
        try {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
            console.error('[Voice] Failed to get microphone permission:', error)
            statusCallback?.('error', 'Microphone permission denied')
            throw error
        } finally {
            permissionStream?.getTracks().forEach((track) => track.stop())
        }

        // Fetch conversation token from server
        let tokenResponse: Awaited<ReturnType<typeof fetchVoiceToken>>
        try {
            tokenResponse = await fetchVoiceToken(this.api)
        } catch (error) {
            console.error('[Voice] Failed to fetch voice token:', error)
            statusCallback?.('error', 'Network error')
            throw error
        }
        if (!tokenResponse.allowed || !tokenResponse.token) {
            const error = new Error(tokenResponse.error ?? 'Voice not allowed or no token')
            console.error('[Voice] Voice not allowed or no token:', tokenResponse.error)
            statusCallback?.('error', tokenResponse.error ?? 'Voice not allowed')
            throw error
        }

        // Use conversation token from server (private agent flow)
        try {
            const conversationId = await conversationInstance.startSession({
                conversationToken: tokenResponse.token,
                connectionType: 'webrtc',
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                // Language override - requires agent to have platform_settings.overrides enabled
                // See: https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides
                overrides: {
                    agent: {
                        language: config.language
                    }
                }
            })

            if (DEBUG) {
                console.log('[Voice] Started conversation with ID:', conversationId)
            }
        } catch (error) {
            console.error('[Voice] Failed to start realtime session:', error)
            statusCallback?.('error', 'Failed to start voice session')
            throw error
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            return
        }

        try {
            await conversationInstance.endSession()
            statusCallback?.('disconnected')
        } catch (error) {
            console.error('[Voice] Failed to end realtime session:', error)
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('[Voice] Realtime voice session not initialized')
            return
        }

        conversationInstance.sendUserMessage(message)
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('[Voice] Realtime voice session not initialized')
            return
        }

        conversationInstance.sendContextualUpdate(update)
    }
}

export interface RealtimeVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    onRegistered?: () => void
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function RealtimeVoiceSession({
    api,
    micMuted: micMutedProp = false,
    onStatusChange,
    onRegistered,
    getSession,
    sendMessage,
    approvePermission,
    denyPermission
}: RealtimeVoiceSessionProps) {
    const hasRegistered = useRef(false)

    // Use local state for micMuted that syncs with prop
    // This is recommended by ElevenLabs SDK docs
    const [micMuted, setMicMuted] = useState(micMutedProp)

    // Sync local state with prop changes
    useEffect(() => {
        setMicMuted(micMutedProp)
    }, [micMutedProp])

    // Store status callback
    useEffect(() => {
        statusCallback = onStatusChange || null
        return () => {
            statusCallback = null
        }
    }, [onStatusChange])

    // Register session store for client tools
    useEffect(() => {
        if (getSession && sendMessage && approvePermission && denyPermission) {
            registerSessionStore({
                getSession: (sessionId: string) => getSession(sessionId) as { agentState?: { requests?: Record<string, unknown> } } | null,
                sendMessage,
                approvePermission,
                denyPermission
            })
        }
    }, [getSession, sendMessage, approvePermission, denyPermission])

    const handleConnect = useCallback(() => {
        if (DEBUG) console.log('[Voice] Realtime session connected')
        onStatusChange?.('connected')
    }, [onStatusChange])

    const handleDisconnect = useCallback(() => {
        if (DEBUG) console.log('[Voice] Realtime session disconnected')
        resetRealtimeSessionState()
        onStatusChange?.('disconnected')
    }, [onStatusChange])

    const handleError = useCallback((error: unknown) => {
        if (DEBUG) console.error('[Voice] Realtime error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Connection error'
        onStatusChange?.('error', errorMessage)
    }, [onStatusChange])

    const handleMessage = useCallback((data: unknown) => {
        if (DEBUG) console.log('[Voice] Realtime message:', data)
    }, [])

    const handleStatusChange = useCallback((data: unknown) => {
        if (DEBUG) console.log('[Voice] Realtime status change:', data)
    }, [])

    const handleModeChange = useCallback((data: unknown) => {
        if (DEBUG) console.log('[Voice] Realtime mode change:', data)
    }, [])

    const handleDebug = useCallback((message: unknown) => {
        if (DEBUG) console.debug('[Voice] Realtime debug:', message)
    }, [])

    // Debug: log when micMuted changes
    useEffect(() => {
        if (DEBUG) console.log('[Voice] micMuted changed to:', micMuted)
    }, [micMuted])

    const conversation = useConversation({
        clientTools: realtimeClientTools,
        micMuted,
        onConnect: handleConnect,
        onDisconnect: handleDisconnect,
        onMessage: handleMessage,
        onError: handleError,
        onStatusChange: handleStatusChange,
        onModeChange: handleModeChange,
        onDebug: handleDebug
    })

    useEffect(() => {
        // Store the conversation instance globally
        conversationInstance = conversation

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl(api))
                hasRegistered.current = true
                onRegistered?.()
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error)
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null
        }
    }, [conversation, api])

    // This component doesn't render anything visible
    return null
}
