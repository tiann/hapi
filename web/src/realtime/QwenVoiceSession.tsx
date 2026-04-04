import { useEffect, useRef, useCallback } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchQwenToken } from '@/api/voice'
import { GeminiAudioRecorder } from './gemini/audioRecorder'
import { GeminiAudioPlayer } from './gemini/audioPlayer'
import { realtimeClientTools } from './realtimeClientTools'
import {
    QWEN_REALTIME_MODEL,
    QWEN_REALTIME_VOICE,
    VOICE_SYSTEM_PROMPT,
    VOICE_TOOL_DEFINITIONS
} from '@hapi/protocol/voice'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const DEBUG = import.meta.env.DEV

// Qwen WebSocket connects via Hub proxy (browser can't set Authorization header)

interface QwenState {
    ws: WebSocket | null
    recorder: GeminiAudioRecorder | null
    player: GeminiAudioPlayer | null
    statusCallback: StatusCallback | null
    apiKey: string | null
    wsBaseUrl: string | null
}

const state: QwenState = {
    ws: null,
    recorder: null,
    player: null,
    statusCallback: null,
    apiKey: null,
    wsBaseUrl: null
}

let eventCounter = 0
function nextEventId(): string {
    return `evt_${++eventCounter}`
}

function cleanup() {
    if (state.recorder) {
        state.recorder.dispose()
        state.recorder = null
    }
    if (state.player) {
        state.player.dispose()
        state.player = null
    }
    if (state.ws) {
        if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
            state.ws.close()
        }
        state.ws = null
    }
}

function sendEvent(type: string, payload?: Record<string, unknown>): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    state.ws.send(JSON.stringify({
        event_id: nextEventId(),
        type,
        ...payload
    }))
}

class QwenVoiceSessionImpl implements VoiceSession {
    private api: ApiClient

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        cleanup()
        state.statusCallback?.('connecting')

        // Get API key from hub
        const tokenResp = await fetchQwenToken(this.api)
        if (!tokenResp.allowed || !tokenResp.apiKey) {
            const msg = tokenResp.error ?? 'DashScope API key not available'
            state.statusCallback?.('error', msg)
            throw new Error(msg)
        }
        state.apiKey = tokenResp.apiKey
        state.wsBaseUrl = tokenResp.wsUrl || null

        // Request microphone
        let permissionStream: MediaStream | null = null
        try {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
            state.statusCallback?.('error', 'Microphone permission denied')
            throw error
        } finally {
            permissionStream?.getTracks().forEach((t) => t.stop())
        }

        // Connect via Hub WebSocket proxy (DashScope requires Authorization header,
        // which browser WebSocket API doesn't support)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const proxyBase = state.wsBaseUrl || `${protocol}//${window.location.host}`
        const model = QWEN_REALTIME_MODEL
        const wsUrl = `${proxyBase}/api/voice/qwen-ws?model=${encodeURIComponent(model)}`
        const ws = new WebSocket(wsUrl)
        state.ws = ws

        return new Promise<void>((resolve, reject) => {
            let sessionCreated = false

            ws.onopen = () => {
                if (DEBUG) console.log('[Qwen] WebSocket connected')
            }

            ws.onmessage = async (event) => {
                let data: Record<string, unknown>
                try {
                    data = JSON.parse(event.data as string) as Record<string, unknown>
                } catch {
                    if (DEBUG) console.warn('[Qwen] Failed to parse message')
                    return
                }

                const eventType = data.type as string

                // Session created - send configuration
                if (eventType === 'session.created' && !sessionCreated) {
                    sessionCreated = true
                    if (DEBUG) console.log('[Qwen] Session created')

                    // Build tools config
                    const tools = VOICE_TOOL_DEFINITIONS.map((td) => ({
                        type: 'function' as const,
                        name: td.name,
                        description: td.description,
                        parameters: td.parameters
                    }))

                    // Send session.update with full configuration
                    const instructions = config.initialContext
                        ? `${VOICE_SYSTEM_PROMPT}\n\n[Current Context]\n${config.initialContext}`
                        : VOICE_SYSTEM_PROMPT

                    sendEvent('session.update', {
                        session: {
                            modalities: ['text', 'audio'],
                            voice: QWEN_REALTIME_VOICE,
                            input_audio_format: 'pcm',
                            output_audio_format: 'pcm',
                            instructions,
                            temperature: 0.7,
                            turn_detection: {
                                type: 'server_vad',
                                threshold: 0.5,
                                silence_duration_ms: 800,
                                prefix_padding_ms: 300
                            },
                            tools,
                            tool_choice: 'auto'
                        }
                    })
                    return
                }

                // Session updated - ready to go
                if (eventType === 'session.updated') {
                    if (DEBUG) console.log('[Qwen] Session configured')
                    state.statusCallback?.('connected')
                    startAudioCapture()
                    resolve()
                    return
                }

                // Audio output streaming
                if (eventType === 'response.audio.delta') {
                    const delta = data.delta as string
                    if (delta) {
                        state.player?.enqueue(delta)
                    }
                    return
                }

                // Text transcript (for debug)
                if (eventType === 'response.audio_transcript.delta' && DEBUG) {
                    console.log('[Qwen] Transcript:', data.delta)
                    return
                }

                // Function call complete
                if (eventType === 'response.function_call_arguments.done') {
                    const callId = data.call_id as string
                    const fnName = data.name as string
                    const argsStr = data.arguments as string

                    if (DEBUG) console.log('[Qwen] Tool call:', fnName, argsStr)

                    let args: Record<string, unknown> = {}
                    try { args = JSON.parse(argsStr) } catch { /* empty */ }

                    // Execute the tool
                    const handler = fnName === 'messageCodingAgent'
                        ? realtimeClientTools.messageCodingAgent
                        : fnName === 'processPermissionRequest'
                        ? realtimeClientTools.processPermissionRequest
                        : null

                    const result = handler
                        ? await handler(args)
                        : `error (unknown tool: ${fnName})`

                    // Send function result back
                    sendEvent('conversation.item.create', {
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: typeof result === 'string' ? result : JSON.stringify(result)
                        }
                    })
                    // Trigger model to continue
                    sendEvent('response.create')
                    return
                }

                // VAD: user started speaking - barge-in
                if (eventType === 'input_audio_buffer.speech_started') {
                    if (state.player?.isPlaying()) {
                        state.player.clearQueue()
                    }
                    return
                }

                // Response done
                if (eventType === 'response.done' && DEBUG) {
                    const resp = data.response as Record<string, unknown> | undefined
                    const usage = resp?.usage as Record<string, unknown> | undefined
                    if (usage) console.log('[Qwen] Usage:', usage)
                    return
                }

                // Error
                if (eventType === 'error') {
                    const err = data.error as { message?: string } | undefined
                    console.error('[Qwen] Server error:', err?.message || data)
                    return
                }
            }

            ws.onerror = (event) => {
                console.error('[Qwen] WebSocket error:', event)
                if (!sessionCreated) {
                    state.statusCallback?.('error', 'WebSocket connection failed')
                    reject(new Error('WebSocket connection failed'))
                }
            }

            ws.onclose = (event) => {
                if (DEBUG) console.log('[Qwen] WebSocket closed:', event.code, event.reason)
                cleanup()
                resetRealtimeSessionState()
                state.statusCallback?.('disconnected')
            }
        })
    }

    async endSession(): Promise<void> {
        cleanup()
        resetRealtimeSessionState()
        state.statusCallback?.('disconnected')
    }

    sendTextMessage(message: string): void {
        // Send text as a user message via conversation.item.create
        sendEvent('conversation.item.create', {
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: message }]
            }
        })
        sendEvent('response.create')
    }

    sendContextualUpdate(update: string): void {
        // Send context as a system-like user message
        sendEvent('conversation.item.create', {
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `[System Context Update] ${update}` }]
            }
        })
    }
}

function startAudioCapture(): void {
    state.player = new GeminiAudioPlayer()
    state.recorder = new GeminiAudioRecorder()

    state.recorder.start(
        (base64Pcm) => {
            sendEvent('input_audio_buffer.append', { audio: base64Pcm })
        },
        (error) => {
            console.error('[Qwen] Audio capture error:', error)
            state.statusCallback?.('error', 'Microphone error')
        }
    )
}

// --- React component ---

export interface QwenVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function QwenVoiceSession({
    api,
    micMuted = false,
    onStatusChange,
    getSession,
    sendMessage,
    approvePermission,
    denyPermission
}: QwenVoiceSessionProps) {
    const hasRegistered = useRef(false)

    useEffect(() => {
        state.statusCallback = onStatusChange || null
        return () => { state.statusCallback = null }
    }, [onStatusChange])

    useEffect(() => {
        if (getSession && sendMessage && approvePermission && denyPermission) {
            registerSessionStore({
                getSession: (sessionId: string) =>
                    getSession(sessionId) as { agentState?: { requests?: Record<string, unknown> } } | null,
                sendMessage,
                approvePermission,
                denyPermission
            })
        }
    }, [getSession, sendMessage, approvePermission, denyPermission])

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new QwenVoiceSessionImpl(api))
                hasRegistered.current = true
            } catch (error) {
                console.error('[Qwen] Failed to register voice session:', error)
            }
        }
    }, [api])

    useEffect(() => {
        if (state.recorder) {
            state.recorder.setMuted(micMuted)
        }
    }, [micMuted])

    useEffect(() => {
        return () => { cleanup() }
    }, [])

    return null
}
