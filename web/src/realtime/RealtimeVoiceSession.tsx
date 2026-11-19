import { lazy, Suspense, useEffect, useRef, useCallback, useState } from 'react'
import type { useConversation } from '@elevenlabs/react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchVoiceToken } from '@/api/voice'
import { buildElevenLabsSessionOverrides, capElevenLabsInitialContext } from '@/lib/voicePersonalitySession'
import { deliverVoiceSessionContextAfterConnect, isVoiceProactiveSummaryEnabled } from '@/lib/voiceContextStream'
import { readStoredVoiceSelection } from '@/lib/voicePickerPreferences'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
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

function assertActiveGeneration(generation: number): void {
    if (generation !== voiceSessionGeneration) {
        throw new Error('Realtime voice session cancelled')
    }
}

const START_TIMEOUT_MS = 15_000
const END_TIMEOUT_MS = 5_000
type Conversation = ReturnType<typeof useConversation>

async function withTimeout<T>(operation: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Voice operation timed out after ${ms} ms`))
            onTimeout?.()
        }, ms)
    })
    try {
        return await Promise.race([operation, timeout])
    } finally {
        clearTimeout(timer)
    }
}

class RealtimeVoiceSessionImpl implements VoiceSession {
    private conversationQueue = Promise.resolve()
    private open = false
    private active = false
    private mounted = true
    private bridgeVersion = 0
    private attempt = 0

    constructor(
        private getApi: () => ApiClient,
        private setStatus: StatusCallback,
        private remountBridge: () => void
    ) {}

    unmount() {
        this.mounted = false
        if (this.active || this.open) {
            this.active = false
            resetRealtimeSessionState()
            this.setStatus('disconnected')
        }
    }

    private retireBridge() {
        this.bridgeVersion += 1
        this.open = false
        if (this.mounted) this.remountBridge()
    }

    private async closeConversation(conversation: Conversation) {
        this.open = false
        const version = this.bridgeVersion
        try {
            await withTimeout(conversation.endSession(), END_TIMEOUT_MS)
        } catch (error) {
            if (version === this.bridgeVersion) this.retireBridge()
            throw error
        }
    }

    private enqueueConversationOperation<T>(kind: 'start' | 'end', operation: (checkPending: () => void) => Promise<T>): Promise<T> {
        let expired = false
        let version = this.bridgeVersion
        const checkPending = () => {
            if (expired || version !== this.bridgeVersion) throw new Error('Voice operation cancelled')
        }
        const onTimeout = () => {
            expired = true
            if (version === this.bridgeVersion) this.retireBridge()
        }
        const queued = this.conversationQueue.then(() => {
            version = this.bridgeVersion
            checkPending()
            const running = operation(checkPending)
            return kind === 'start' ? withTimeout(running, START_TIMEOUT_MS, onTimeout) : running
        })
        const result = kind === 'end' ? withTimeout(queued, END_TIMEOUT_MS, onTimeout) : queued
        this.conversationQueue = result.then(() => {}, () => {})
        return result
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!this.mounted) throw new Error('Realtime voice session unmounted')
        if (!conversationInstance && !ensureConversationInstance) {
            const error = new Error('Realtime voice session not initialized')
            console.warn('[Voice] Realtime voice session not initialized')
            this.setStatus('error', 'Voice session not initialized')
            throw error
        }

        const attempt = ++this.attempt
        const assertCurrentAttempt = () => {
            if (!this.mounted || attempt !== this.attempt) throw new Error('Realtime voice session cancelled')
        }
        this.active = true
        this.setStatus('connecting')

        // Load and mount the @elevenlabs/react bridge in parallel with mic
        // permission + token fetch so idle chat opens pay zero bundle cost.
        const conversationPromise = conversationInstance
            ? Promise.resolve(conversationInstance)
            : ensureConversationInstance!()

        void conversationPromise.catch(() => {})
        let generation = voiceSessionGeneration
        let failureMessage: string | undefined = 'Microphone permission denied'
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            stream.getTracks().forEach((track) => track.stop())
            assertCurrentAttempt()

            failureMessage = 'Network error'
            const tokenResponse = await fetchVoiceToken(this.getApi(), {
                voiceId: config.voiceId ?? readStoredVoiceSelection('elevenlabs') ?? undefined
            })
            assertCurrentAttempt()
            if (!tokenResponse.allowed || !tokenResponse.token) {
                failureMessage = tokenResponse.error ?? 'Voice not allowed'
                throw new Error(tokenResponse.error ?? 'Voice not allowed or no token')
            }
            failureMessage = 'Failed to initialize voice session'
            await conversationPromise
            assertCurrentAttempt()

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
            generation = ++voiceSessionGeneration
            failureMessage = undefined
            const conversationId = await this.enqueueConversationOperation('start', async (checkPending) => {
                assertActiveGeneration(generation)
                if (this.open && conversationInstance) {
                    await this.closeConversation(conversationInstance)
                    checkPending()
                    assertActiveGeneration(generation)
                }
                const conversation = conversationInstance ?? await ensureConversationInstance!()
                checkPending()
                assertActiveGeneration(generation)
                const version = this.bridgeVersion
                const isCurrent = () => generation === voiceSessionGeneration
                    && version === this.bridgeVersion
                    && (this.open || attempt === this.attempt)
                const id = await conversation.startSession({
                    ...baseSessionConfig,
                    onConnect: () => {
                        if (isCurrent()) this.setStatus('connected')
                    },
                    onError: (message) => {
                        if (isCurrent()) this.setStatus('error', message)
                    },
                    onDisconnect: () => {
                        if (!isCurrent()) return
                        ++voiceSessionGeneration
                        this.open = false
                        if (attempt === this.attempt) {
                            this.active = false
                            resetRealtimeSessionState()
                        }
                        this.setStatus('disconnected')
                    }
                })
                checkPending()
                if (generation !== voiceSessionGeneration || attempt !== this.attempt) {
                    await this.closeConversation(conversation)
                    assertCurrentAttempt()
                    assertActiveGeneration(generation)
                }
                this.open = true
                return id
            })
            assertActiveGeneration(generation)

            if (DEBUG) {
                console.log('[Voice] Started conversation with ID:', conversationId)
            }

            await deliverVoiceSessionContextAfterConnect({
                streamContextChunks: config.streamContextChunks,
                initialContext: config.initialContext,
                sendChunk: (chunk) => {
                    assertActiveGeneration(generation)
                    return conversationInstance?.sendContextualUpdate(chunk)
                }
            })
            assertActiveGeneration(generation)

            if (isVoiceProactiveSummaryEnabled()) {
                this.sendTextMessage(
                    'Based on the session context you received, give me a brief spoken summary, then wait for my next request.'
                )
            }
        } catch (error) {
            assertCurrentAttempt()
            if (failureMessage !== undefined) {
                if (this.open) {
                    await this.stopConversation(attempt)
                    assertCurrentAttempt()
                }
                this.active = false
                this.setStatus('error', failureMessage)
                throw error
            }
            assertActiveGeneration(generation)
            ++voiceSessionGeneration
            this.active = false
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.error('[Voice] Failed to start realtime session:', {
                error: errorMessage,
                sessionId: config.sessionId,
                language: config.language,
                voiceId: config.voiceId
            })
            this.setStatus('error', `Failed to start voice session: ${errorMessage}`)
            throw error
        }
    }

    async endSession(): Promise<void> {
        if (!this.mounted) return
        await this.stopConversation(++this.attempt)
    }

    private async stopConversation(attempt: number) {
        const generation = ++voiceSessionGeneration
        try {
            await this.enqueueConversationOperation('end', async () => {
                if (this.mounted && this.open && conversationInstance) await this.closeConversation(conversationInstance)
            })
        } finally {
            if (generation === voiceSessionGeneration && attempt === this.attempt) {
                this.active = false
                resetRealtimeSessionState()
                this.setStatus('disconnected')
            }
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
    const apiRef = useRef(api)
    apiRef.current = api
    const onStatusChangeRef = useRef(onStatusChange)
    onStatusChangeRef.current = onStatusChange

    // Use local state for micMuted that syncs with prop
    // This is recommended by ElevenLabs SDK docs
    const [micMuted, setMicMuted] = useState(micMutedProp)

    // Sync local state with prop changes
    useEffect(() => {
        setMicMuted(micMutedProp)
    }, [micMutedProp])

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

    const [bridgeKey, setBridgeKey] = useState(0)
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

        const setStatus: StatusCallback = (...args) => onStatusChangeRef.current?.(...args)
        const session = new RealtimeVoiceSessionImpl(() => apiRef.current, setStatus, () => {
            conversationInstance = null
            setBridgeKey((key) => key + 1)
        })
        registerVoiceSession(session)
        onRegisteredRef.current?.()

        return () => {
            voiceSessionGeneration += 1
            session.unmount()
            conversationInstance = null
            ensureConversationInstance = null
            const waiters = conversationWaitersRef.current.splice(0)
            for (const waiter of waiters) {
                waiter.reject(new Error('Realtime voice session unmounted'))
            }
        }
    }, [])

    if (!bridgeMounted) {
        return null
    }

    return (
        <Suspense fallback={null}>
            <ElevenLabsConversationBridge
                key={bridgeKey}
                micMuted={micMuted}
                onMessage={handleMessage}
                onStatusChange={handleStatusChange}
                onModeChange={handleModeChange}
                onDebug={handleDebug}
                onConversationChange={handleConversationChange}
            />
        </Suspense>
    )
}
