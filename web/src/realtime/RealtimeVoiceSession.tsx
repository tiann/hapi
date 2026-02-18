import { useEffect, useRef } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { SessionStore } from './transcriptRouter'
import { routeTranscript, speak } from './transcriptRouter'
import { RealtimeWhisperVoiceSessionImpl } from './RealtimeWhisperVoiceSession'
import { buildVoiceWebSocketUrl, transcribeVoiceAudio } from '@/api/voice'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const DEBUG = import.meta.env.DEV

// Module-level state shared between the React component and VoiceSession implementations
let statusCallback: StatusCallback | null = null
let sessionStore: SessionStore | null = null

// ---------------------------------------------------------------------------
// Chunked HTTP fallback implementation (uses MediaRecorder + POST /api/voice/transcribe)
// ---------------------------------------------------------------------------

class LocalWhisperVoiceSessionImpl implements VoiceSession {
    private readonly api: ApiClient
    private mediaStream: MediaStream | null = null
    private mediaRecorder: MediaRecorder | null = null
    private transcriptionChain: Promise<void> = Promise.resolve()
    private activeSessionId: string | null = null
    private activeLanguage: string | undefined
    private isMuted = false
    private rotateTimer: ReturnType<typeof setInterval> | null = null
    private pendingTranscriptions = 0
    private isStopping = false

    constructor(api: ApiClient) {
        this.api = api
    }

    setMuted(muted: boolean) {
        this.isMuted = muted
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!sessionStore) {
            statusCallback?.('error', 'Voice session store not initialized')
            throw new Error('Voice session store not initialized')
        }

        statusCallback?.('connecting')
        this.activeSessionId = config.sessionId
        this.activeLanguage = config.language

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
            statusCallback?.('error', 'Microphone permission denied')
            throw error
        }

        this.startRecorder()
        this.rotateTimer = setInterval(() => {
            if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.stop()
            }
        }, 3000)
        statusCallback?.('connected')
    }

    async endSession(): Promise<void> {
        this.isStopping = true

        if (this.rotateTimer) {
            clearInterval(this.rotateTimer)
            this.rotateTimer = null
        }

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop()
        }
        this.mediaRecorder = null

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop())
            this.mediaStream = null
        }

        if (this.pendingTranscriptions > 0) {
            statusCallback?.('processing')
            await this.transcriptionChain
        }

        this.activeSessionId = null
        this.activeLanguage = undefined
        this.pendingTranscriptions = 0
        this.isStopping = false

        statusCallback?.('disconnected')
    }

    private startRecorder(): void {
        if (!this.mediaStream || !this.activeSessionId) {
            return
        }

        try {
            this.mediaRecorder = new MediaRecorder(this.mediaStream, {
                mimeType: MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : undefined
            })
        } catch {
            this.mediaRecorder = new MediaRecorder(this.mediaStream)
        }

        this.mediaRecorder.addEventListener('dataavailable', (event) => {
            if (!event.data || event.data.size === 0 || this.isMuted || !this.activeSessionId) {
                return
            }

            const sessionId = this.activeSessionId
            const language = this.activeLanguage
            this.pendingTranscriptions++
            if (this.pendingTranscriptions === 1) {
                statusCallback?.('processing')
            }
            this.transcriptionChain = this.transcriptionChain.then(async () => {
                try {
                    const result = await transcribeVoiceAudio(this.api, event.data, language)
                    if (!result.ok || !result.text) {
                        if (DEBUG && result.error) {
                            console.warn('[Voice] Transcription failed:', result.error)
                        }
                        return
                    }

                    const text = result.text.trim()
                    if (!text || !sessionStore) {
                        return
                    }

                    await routeTranscript(sessionStore, sessionId, text)
                } finally {
                    this.pendingTranscriptions--
                    if (this.pendingTranscriptions === 0 && this.activeSessionId && !this.isStopping) {
                        statusCallback?.('connected')
                    }
                }
            }).catch((error) => {
                console.error('[Voice] Transcription pipeline failed:', error)
            })
        })

        this.mediaRecorder.addEventListener('stop', () => {
            if (!this.activeSessionId || !this.mediaStream) {
                return
            }
            this.startRecorder()
        })

        this.mediaRecorder.start()
    }

    sendTextMessage(message: string): void {
        speak(message)
    }

    sendContextualUpdate(_update: string): void {
        // local-whisper mode: context updates not spoken automatically
    }
}

// ---------------------------------------------------------------------------
// A unified interface for implementations that support setMuted
// ---------------------------------------------------------------------------

interface MutableVoiceSession extends VoiceSession {
    setMuted(muted: boolean): void
}

// ---------------------------------------------------------------------------
// React component: selects WebSocket or chunked HTTP implementation
// ---------------------------------------------------------------------------

export interface RealtimeVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function RealtimeVoiceSession({
    api,
    micMuted = false,
    onStatusChange,
    getSession,
    sendMessage,
    approvePermission,
    denyPermission
}: RealtimeVoiceSessionProps) {
    const implRef = useRef<MutableVoiceSession | null>(null)

    // Keep store synced during render so startSession can run immediately after mount.
    if (getSession && sendMessage && approvePermission && denyPermission) {
        const store: SessionStore = {
            getSession,
            sendMessage,
            approvePermission,
            denyPermission
        }
        sessionStore = store
        registerSessionStore({
            getSession: (sessionId: string) => getSession(sessionId) as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage,
            approvePermission,
            denyPermission
        })

        // Sync store into WebSocket impl if it's the active one
        const impl = implRef.current
        if (impl && impl instanceof RealtimeWhisperVoiceSessionImpl) {
            impl.setSessionStore(store)
        }
    } else {
        sessionStore = null
    }

    useEffect(() => {
        statusCallback = onStatusChange || null

        // Sync callback into WebSocket impl if it's the active one
        const impl = implRef.current
        if (impl && impl instanceof RealtimeWhisperVoiceSessionImpl) {
            impl.setStatusCallback(onStatusChange || null)
        }

        return () => {
            statusCallback = null
        }
    }, [onStatusChange])

    useEffect(() => {
        if (!implRef.current) {
            const wsUrl = buildVoiceWebSocketUrl(api)
            const wsImpl = new RealtimeWhisperVoiceSessionImpl(wsUrl)
            wsImpl.setStatusCallback(statusCallback)
            wsImpl.setSessionStore(sessionStore)

            // Wrap to support fallback: if startSession fails on WS, swap to chunked
            const fallbackImpl: MutableVoiceSession = {
                setMuted(muted: boolean) {
                    wsImpl.setMuted(muted)
                },
                async startSession(config: VoiceSessionConfig): Promise<void> {
                    try {
                        await wsImpl.startSession(config)
                        // WS succeeded — replace fallback wrapper internals to go direct
                        fallbackImpl.startSession = (c) => wsImpl.startSession(c)
                        fallbackImpl.endSession = () => wsImpl.endSession()
                        fallbackImpl.sendTextMessage = (m) => wsImpl.sendTextMessage(m)
                        fallbackImpl.sendContextualUpdate = (u) => wsImpl.sendContextualUpdate(u)
                    } catch (wsError) {
                        if (DEBUG) console.warn('[Voice] WebSocket realtime not available, falling back to chunked HTTP', wsError)
                        // Swap to chunked HTTP
                        const chunkedImpl = new LocalWhisperVoiceSessionImpl(api)
                        fallbackImpl.setMuted = (m) => chunkedImpl.setMuted(m)
                        fallbackImpl.startSession = (c) => chunkedImpl.startSession(c)
                        fallbackImpl.endSession = () => chunkedImpl.endSession()
                        fallbackImpl.sendTextMessage = (m) => chunkedImpl.sendTextMessage(m)
                        fallbackImpl.sendContextualUpdate = (u) => chunkedImpl.sendContextualUpdate(u)
                        // Retry with chunked
                        await chunkedImpl.startSession(config)
                    }
                },
                async endSession(): Promise<void> {
                    await wsImpl.endSession()
                },
                sendTextMessage(message: string): void {
                    wsImpl.sendTextMessage(message)
                },
                sendContextualUpdate(update: string): void {
                    wsImpl.sendContextualUpdate(update)
                }
            }

            implRef.current = fallbackImpl
            registerVoiceSession(fallbackImpl)
        }

        return () => {
            const impl = implRef.current
            implRef.current = null
            if (impl) {
                void impl.endSession()
            }
            resetRealtimeSessionState()
        }
    }, [api])

    useEffect(() => {
        implRef.current?.setMuted(micMuted)
    }, [micMuted])

    return null
}
