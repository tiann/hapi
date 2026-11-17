import { lazy, Suspense, useEffect, useRef, useCallback, useState } from 'react'
import type { useConversation } from '@elevenlabs/react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchVoiceToken } from '@/api/voice'
import { buildElevenLabsSessionOverrides, capElevenLabsInitialContext } from '@/lib/voicePersonalitySession'
import { deliverVoiceSessionContextAfterConnect, isVoiceProactiveSummaryEnabled } from '@/lib/voiceContextStream'
import { readStoredVoiceSelection } from '@/lib/voicePickerPreferences'
import type { VoiceSession, VoiceSessionConfig, ConversationStatus, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const ElevenLabsConversationBridge = lazy(() =>
    import('./ElevenLabsConversationBridge').then((m) => ({ default: m.ElevenLabsConversationBridge }))
)

// Debug logging
const DEBUG = import.meta.env.DEV

// Static reference to the conversation hook instance, lazy bridge trigger, and lifecycle generation
let conversationInstance: ReturnType<typeof useConversation> | null = null
let ensureConversationInstance: (() => Promise<ReturnType<typeof useConversation>>) | null = null
let voiceSessionGeneration = 0

// Store reference for status updates
let statusCallback: StatusCallback | null = null

function assertActiveGeneration(generation: number): void {
    if (generation !== voiceSessionGeneration) {
        throw new Error('Realtime voice session cancelled')
    }
}

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    private api: ApiClient

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!conversationInstance && !ensureConversationInstance) {
            const error = new Error('Realtime voice session not initialized')
            console.warn('[Voice] Realtime voice session not initialized')
            statusCallback?.('error', 'Voice session not initialized')
            throw error
        }

        const generation = ++voiceSessionGeneration
        statusCallback?.('connecting')

        // Load and mount the @elevenlabs/react bridge in parallel with mic
        // permission + token fetch so idle chat opens pay zero bundle cost.
        const conversationPromise = conversationInstance
            ? Promise.resolve(conversationInstance)
            : ensureConversationInstance!()

        // Request microphone permission first
        let permissionStream: MediaStream | null = null
        try {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
            void conversationPromise.catch(() => {})
            assertActiveGeneration(generation)
            console.error('[Voice] Failed to get microphone permission:', error)
            statusCallback?.('error', 'Microphone permission denied')
            throw error
        } finally {
            permissionStream?.getTracks().forEach((track) => track.stop())
        }

        try {
            assertActiveGeneration(generation)
        } catch (error) {
            void conversationPromise.catch(() => {})
            throw error
        }

        // Fetch conversation token from server
        let tokenResponse: Awaited<ReturnType<typeof fetchVoiceToken>>
        try {
            tokenResponse = await fetchVoiceToken(this.api, {
                voiceId: config.voiceId ?? readStoredVoiceSelection('elevenlabs') ?? undefined
            })
        } catch (error) {
            void conversationPromise.catch(() => {})
            assertActiveGeneration(generation)
            console.error('[Voice] Failed to fetch voice token:', error)
            statusCallback?.('error', 'Network error')
            throw error
        }
        try {
            assertActiveGeneration(generation)
        } catch (error) {
            void conversationPromise.catch(() => {})
            throw error
        }
        if (!tokenResponse.allowed || !tokenResponse.token) {
            const error = new Error(tokenResponse.error ?? 'Voice not allowed or no token')
            console.error('[Voice] Voice not allowed or no token:', tokenResponse.error)
            statusCallback?.('error', tokenResponse.error ?? 'Voice not allowed')
            void conversationPromise.catch(() => {})
            throw error
        }

        const initialConversationContext = capElevenLabsInitialContext(config.initialContext)
        if (
            import.meta.env.DEV
            && config.initialContext
            && initialConversationContext.length < config.initialContext.length
        ) {
            console.warn(
                '[Voice] Session context truncated for ElevenLabs WebRTC limit (65KB/message)'
            )
        }

        const personalityOverrides = buildElevenLabsSessionOverrides({
            language: config.language,
            voiceId: config.voiceId ?? readStoredVoiceSelection('elevenlabs') ?? undefined
        })

        const baseSessionConfig = {
            conversationToken: tokenResponse.token,
            connectionType: 'webrtc' as const,
            dynamicVariables: {
                sessionId: config.sessionId,
                initialConversationContext
            },
            overrides: personalityOverrides
        }

        // Use conversation token from server (private agent flow)
        try {
            const conversation = await conversationPromise
            assertActiveGeneration(generation)
            if (!conversationInstance) {
                throw new Error('Realtime voice session cancelled')
            }
            const conversationId = await conversation.startSession(baseSessionConfig)
            if (generation !== voiceSessionGeneration) {
                await conversation.endSession().catch(() => {})
                assertActiveGeneration(generation)
            }

            if (DEBUG) {
                console.log('[Voice] Started conversation with ID:', conversationId)
            }

            await deliverVoiceSessionContextAfterConnect({
                streamContextChunks: config.streamContextChunks,
                initialContext: config.initialContext,
                sendChunk: (chunk) => {
                    assertActiveGeneration(generation)
                    return (conversationInstance ?? conversation).sendContextualUpdate(chunk)
                }
            })
            assertActiveGeneration(generation)

            if (isVoiceProactiveSummaryEnabled()) {
                this.sendTextMessage(
                    'Based on the session context you received, give me a brief spoken summary, then wait for my next request.'
                )
            }
        } catch (error) {
            assertActiveGeneration(generation)
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.error('[Voice] Failed to start realtime session:', {
                error: errorMessage,
                sessionId: config.sessionId,
                language: config.language,
                voiceId: config.voiceId
            })
            statusCallback?.('error', `Failed to start voice session: ${errorMessage}`)
            throw error
        }
    }

    async endSession(): Promise<void> {
        voiceSessionGeneration += 1
        if (!conversationInstance) {
            statusCallback?.('disconnected')
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

    const [bridgeMounted, setBridgeMounted] = useState(false)
    const onRegisteredRef = useRef(onRegistered)
    onRegisteredRef.current = onRegistered
    const conversationWaitersRef = useRef<Array<{
        resolve: (conversation: ReturnType<typeof useConversation>) => void
        reject: (error: Error) => void
    }>>([])

    const handleConversationChange = useCallback((conversation: ReturnType<typeof useConversation> | null) => {
        conversationInstance = conversation
        if (!conversation) return
        const waiters = conversationWaitersRef.current.splice(0)
        for (const waiter of waiters) {
            waiter.resolve(conversation)
        }
    }, [])

    useEffect(() => {
        ensureConversationInstance = () => {
            if (conversationInstance) {
                return Promise.resolve(conversationInstance)
            }
            setBridgeMounted(true)
            return new Promise<ReturnType<typeof useConversation>>((resolve, reject) => {
                conversationWaitersRef.current.push({ resolve, reject })
            })
        }

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl(api))
                hasRegistered.current = true
                onRegisteredRef.current?.()
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error)
            }
        }

        return () => {
            // Clean up on unmount
            voiceSessionGeneration += 1
            conversationInstance = null
            ensureConversationInstance = null
            const waiters = conversationWaitersRef.current.splice(0)
            for (const waiter of waiters) {
                waiter.reject(new Error('Realtime voice session unmounted'))
            }
        }
    }, [api])

    if (!bridgeMounted) {
        return null
    }

    return (
        <Suspense fallback={null}>
            <ElevenLabsConversationBridge
                micMuted={micMuted}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onMessage={handleMessage}
                onError={handleError}
                onStatusChange={handleStatusChange}
                onModeChange={handleModeChange}
                onDebug={handleDebug}
                onConversationChange={handleConversationChange}
            />
        </Suspense>
    )
}
