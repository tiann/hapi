import { useEffect, useRef } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchQwenToken } from '@/api/voice'
import { GeminiAudioRecorder } from './gemini/audioRecorder'
import { GeminiAudioPlayer } from './gemini/audioPlayer'
import { realtimeClientTools } from './realtimeClientTools'
import { resolveQwenRealtimeVoice } from '@hapi/protocol/voicePickerCatalog'
import {
    buildResolvedVoiceSystemPrompt,
    encodeVoiceSystemPromptForProxy,
    truncatePromptForProxy
} from '@/lib/voicePersonalitySession'
import { isVoiceProactiveSummaryEnabled, streamDeferredVoiceContext } from '@/lib/voiceContextStream'
import { readStoredVoiceSelection } from '@/lib/voicePickerPreferences'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const DEBUG = import.meta.env.DEV

// Qwen WebSocket connects via Hub proxy (browser can't set Authorization header)

interface QwenState {
    ws: WebSocket | null
    recorder: GeminiAudioRecorder | null
    player: GeminiAudioPlayer | null
    playbackContext: AudioContext | null
    statusCallback: StatusCallback | null
    apiKey: string | null
    wsBaseUrl: string | null
    micMuted: boolean
}

const state: QwenState = {
    ws: null,
    recorder: null,
    player: null,
    playbackContext: null,
    statusCallback: null,
    apiKey: null,
    wsBaseUrl: null,
    micMuted: false
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
    if (state.playbackContext && state.playbackContext.state !== 'closed') {
        void state.playbackContext.close()
    }
    state.playbackContext = null
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
    private currentInstructions: string | null = null

    constructor(api: ApiClient) {
        this.api = api
    }

    private updateInstructions(update: string): void {
        if (this.currentInstructions === null) return
        this.currentInstructions = `${this.currentInstructions}\n\n${update}`
        // Hub filter allows only instruction-only session.update frames.
        sendEvent('session.update', { session: { instructions: this.currentInstructions } })
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        // Mirror the base instructions the hub will send so subsequent updates accumulate correctly.
        // buildResolvedVoiceSystemPrompt returns the user-customised prompt when set; with empty prefs
        // it falls back to VOICE_SYSTEM_PROMPT + buildVoiceLanguageBlock(language) (general language handling).
        this.currentInstructions = buildResolvedVoiceSystemPrompt({
            language: config.language,
            backend: 'qwen-realtime'
        })
        cleanup()
        state.statusCallback?.('connecting')

        // Create playback AudioContext immediately while still inside the user
        // gesture (click/tap). Mobile browsers require this for autoplay policy.
        // Store in state so cleanup() can close it on failure or stop.
        state.playbackContext = new AudioContext({ sampleRate: 24000 })
        await state.playbackContext.resume()

        // Check Qwen availability (hub no longer sends the raw API key)
        const tokenResp = await fetchQwenToken(this.api)
        if (!tokenResp.allowed) {
            const msg = tokenResp.error ?? 'DashScope API key not available'
            state.statusCallback?.('error', msg)
            cleanup()
            throw new Error(msg)
        }
        state.apiKey = null // key stays server-side
        state.wsBaseUrl = tokenResp.wsUrl || null

        // Request microphone
        let permissionStream: MediaStream | null = null
        try {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
            state.statusCallback?.('error', 'Microphone permission denied')
            cleanup()
            throw error
        } finally {
            permissionStream?.getTracks().forEach((t) => t.stop())
        }

        // Connect via Hub WebSocket proxy (DashScope requires Authorization header,
        // which browser WebSocket API doesn't support)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const defaultProxyUrl = `${protocol}//${window.location.host}/api/voice/qwen-ws`
        const proxyUrl = state.wsBaseUrl || defaultProxyUrl
        const authToken = this.api.getAuthToken() || ''
        const separator = proxyUrl.includes('?') ? '&' : '?'
        const langParam = config.language ? `&language=${encodeURIComponent(config.language)}` : ''
        // Voice picker selection is forwarded to the hub so the hub-owned session.update uses it.
        const resolvedVoice = resolveQwenRealtimeVoice(
            config.voiceName ?? readStoredVoiceSelection('qwen-realtime')
        )
        const voiceParam = `&voice=${encodeURIComponent(resolvedVoice)}`
        // User's resolved system prompt is forwarded so the hub's session.update applies the override.
        // Truncate before encoding so long prompts are trimmed rather than silently dropped.
        const encodedPrompt = encodeVoiceSystemPromptForProxy(truncatePromptForProxy(this.currentInstructions ?? ''))
        const promptParam = `&systemPrompt=${encodeURIComponent(encodedPrompt)}`
        const wsUrl = `${proxyUrl}${separator}token=${encodeURIComponent(authToken)}${langParam}${voiceParam}${promptParam}`
        const ws = new WebSocket(wsUrl)
        state.ws = ws

        return new Promise<void>((resolve, reject) => {
            let sessionReady = false

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

                // Session created — hub sends the initial session.update; browser waits for session.updated.
                if (eventType === 'session.created') {
                    if (DEBUG) console.log('[Qwen] Session created (hub owns setup)')
                    return
                }

                // Session updated - only act on the first one (initial config ack).
                // Subsequent session.update calls (for instruction appends) also
                // echo session.updated — ignore those after setup is complete.
                if (eventType === 'session.updated') {
                    if (sessionReady) return
                    sessionReady = true
                    if (DEBUG) console.log('[Qwen] Session configured')
                    try {
                        await startAudioCapture(state.playbackContext!)
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'Microphone error'
                        cleanup()
                        state.statusCallback?.('error', message)
                        reject(error instanceof Error ? error : new Error(message))
                        return
                    }
                    state.statusCallback?.('connected')

                    await streamDeferredVoiceContext(
                        (chunk) => this.sendContextualUpdate(chunk),
                        config.streamContextChunks ?? []
                    )

                    const proactive = isVoiceProactiveSummaryEnabled()
                    if (proactive) {
                        if (config.initialContext?.trim()) {
                            this.sendContextualUpdate(config.initialContext)
                        }
                        this.sendTextMessage(
                            'Based on all session context above, give me a brief spoken summary of what the coding agent has been doing, then wait.'
                        )
                    } else {
                        if (config.initialContext?.trim()) {
                            this.sendContextualUpdate(config.initialContext)
                        }
                        this.sendTextMessage(
                            '[Greet the user. Say a brief hello and invite them to speak. Do not mention Qwen or any model name.]'
                        )
                    }

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
                    const message = err?.message || 'Realtime session setup failed'
                    console.error('[Qwen] Server error:', message)
                    state.statusCallback?.('error', message)
                    if (!sessionReady) {
                        reject(new Error(message))
                        ws.close()
                    }
                    return
                }
            }

            ws.onerror = (event) => {
                console.error('[Qwen] WebSocket error:', event)
                if (!sessionReady) {
                    sessionReady = true
                    cleanup()
                    state.statusCallback?.('error', 'WebSocket connection failed')
                    reject(new Error('WebSocket connection failed'))
                }
            }

            ws.onclose = (event) => {
                if (state.ws !== ws) return
                if (DEBUG) console.log('[Qwen] WebSocket closed:', event.code, event.reason)
                cleanup()
                resetRealtimeSessionState()
                if (!sessionReady) {
                    const message = event.reason || 'WebSocket closed before setup completed'
                    state.statusCallback?.('error', message)
                    reject(new Error(message))
                    return
                }
                state.statusCallback?.('disconnected')
            }
        })
    }

    async endSession(): Promise<void> {
        this.currentInstructions = null
        cleanup()
        resetRealtimeSessionState()
        state.statusCallback?.('disconnected')
    }

    sendTextMessage(message: string): void {
        // Qwen Realtime requires a user conversation item before response.create.
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
        // Append context silently — no response.create, so model doesn't speak yet.
        this.updateInstructions(`[System Context Update] ${update}`)
    }
}

async function startAudioCapture(playbackContext: AudioContext): Promise<void> {
    state.player = new GeminiAudioPlayer(playbackContext)
    state.recorder = new GeminiAudioRecorder()

    await state.recorder.start(
        (base64Pcm) => {
            sendEvent('input_audio_buffer.append', { audio: base64Pcm })
        },
        (error) => {
            console.error('[Qwen] Audio capture error:', error)
            state.statusCallback?.('error', 'Microphone error')
        }
    )

    // Apply mute state after recorder has a stream — safe to call either way
    state.recorder.setMuted(state.micMuted)
}

// --- React component ---

export interface QwenVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    onRegistered?: () => void
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function QwenVoiceSession({
    api,
    micMuted = false,
    onStatusChange,
    onRegistered,
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
                onRegistered?.()
            } catch (error) {
                console.error('[Qwen] Failed to register voice session:', error)
            }
        }
    }, [api]) // eslint-disable-line react-hooks/exhaustive-deps

    // Sync mic mute state — also persist to module state so startAudioCapture can apply it
    useEffect(() => {
        state.micMuted = micMuted
        if (state.recorder) {
            state.recorder.setMuted(micMuted)
        }
    }, [micMuted])

    useEffect(() => {
        return () => { cleanup() }
    }, [])

    return null
}
