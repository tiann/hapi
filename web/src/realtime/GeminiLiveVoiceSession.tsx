import { useEffect, useRef, useCallback } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchGeminiToken } from '@/api/voice'
import { GeminiAudioRecorder } from './gemini/audioRecorder'
import { GeminiAudioPlayer } from './gemini/audioPlayer'
import { handleGeminiFunctionCalls } from './gemini/toolAdapter'
import { buildGeminiLiveConfig } from '@hapi/protocol/voice'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { GeminiFunctionCall } from './gemini/toolAdapter'

const DEBUG = import.meta.env.DEV

// Default Gemini Live WebSocket API endpoint (Google direct)
const DEFAULT_GEMINI_LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

interface GeminiLiveState {
    ws: WebSocket | null
    recorder: GeminiAudioRecorder | null
    player: GeminiAudioPlayer | null
    statusCallback: StatusCallback | null
    apiKey: string | null
    wsBaseUrl: string | null
    modelSpeaking: boolean
}

const state: GeminiLiveState = {
    ws: null,
    recorder: null,
    player: null,
    statusCallback: null,
    apiKey: null,
    wsBaseUrl: null,
    modelSpeaking: false
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

class GeminiLiveVoiceSessionImpl implements VoiceSession {
    private api: ApiClient

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        cleanup()
        state.statusCallback?.('connecting')

        // Get API key from hub
        const tokenResp = await fetchGeminiToken(this.api)
        if (!tokenResp.allowed || !tokenResp.apiKey) {
            const msg = tokenResp.error ?? 'Gemini API key not available'
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

        // Connect WebSocket
        const wsBase = state.wsBaseUrl || DEFAULT_GEMINI_LIVE_WS_BASE
        const wsUrl = `${wsBase}?key=${encodeURIComponent(state.apiKey)}`
        const ws = new WebSocket(wsUrl)
        state.ws = ws

        return new Promise<void>((resolve, reject) => {
            let setupDone = false

            ws.onopen = () => {
                if (DEBUG) console.log('[GeminiLive] WebSocket connected, sending setup')

                const liveConfig = buildGeminiLiveConfig()
                const setupMessage = {
                    setup: {
                        model: `models/${liveConfig.model}`,
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName: 'Aoede' }
                                }
                            }
                        },
                        systemInstruction: {
                            parts: [{ text: liveConfig.systemInstruction }]
                        },
                        tools: liveConfig.tools.map((t) => ({
                            functionDeclarations: t.functionDeclarations.map((fd) => ({
                                name: fd.name,
                                description: fd.description,
                                parameters: fd.parameters
                            }))
                        }))
                    }
                }

                ws.send(JSON.stringify(setupMessage))
            }

            ws.onmessage = async (event) => {
                let data: Record<string, unknown>
                try {
                    if (event.data instanceof Blob) {
                        const text = await event.data.text()
                        data = JSON.parse(text) as Record<string, unknown>
                    } else {
                        data = JSON.parse(event.data as string) as Record<string, unknown>
                    }
                } catch {
                    if (DEBUG) console.warn('[GeminiLive] Failed to parse message')
                    return
                }

                // Log all message types for debugging
                const msgKeys = Object.keys(data).filter(k => k !== 'serverContent' || !('modelTurn' in (data.serverContent as Record<string, unknown> || {})))
                if (!data.serverContent) {
                    console.log('[GeminiLive] Message:', msgKeys.join(', '), JSON.stringify(data).slice(0, 200))
                }

                // Setup complete
                if (data.setupComplete && !setupDone) {
                    setupDone = true
                    if (DEBUG) console.log('[GeminiLive] Setup complete')
                    state.statusCallback?.('connected')

                    // Start audio capture
                    startAudioCapture()

                    // Send initial context if available (no clientContent greeting — it breaks tool calls)
                    if (config.initialContext) {
                        sendClientContent(`[Context] ${config.initialContext}`)
                    }

                    resolve()
                    return
                }

                // Server content (audio / text / turn complete)
                const serverContent = data.serverContent as {
                    modelTurn?: { parts?: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }> }
                    turnComplete?: boolean
                } | undefined

                if (serverContent) {
                    if (serverContent.modelTurn?.parts) {
                        // Model is generating — mute mic to prevent barge-in from noise
                        if (!state.modelSpeaking) {
                            state.modelSpeaking = true
                            state.recorder?.setMuted(true)
                        }
                        for (const part of serverContent.modelTurn.parts) {
                            if (part.inlineData?.data) {
                                state.player?.enqueue(part.inlineData.data)
                            }
                            if (part.text) {
                                console.log('[GeminiLive] Text:', part.text)
                            }
                        }
                    }
                    if (serverContent.turnComplete) {
                        console.log('[GeminiLive] Turn complete')
                        // Model done — unmute mic for next user turn
                        state.modelSpeaking = false
                        state.recorder?.setMuted(false)
                    }
                }

                // Tool calls
                const toolCall = data.toolCall as {
                    functionCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>
                } | undefined

                if (toolCall?.functionCalls && toolCall.functionCalls.length > 0) {
                    console.log('[GeminiLive] Tool calls:', toolCall.functionCalls.map((c) => c.name))

                    const responses = await handleGeminiFunctionCalls(
                        toolCall.functionCalls as GeminiFunctionCall[]
                    )

                    // Send tool responses back
                    if (state.ws?.readyState === WebSocket.OPEN) {
                        state.ws.send(JSON.stringify({
                            toolResponse: {
                                functionResponses: responses.map((r) => ({
                                    id: r.id,
                                    name: r.name,
                                    response: r.response
                                }))
                            }
                        }))
                    }
                }
            }

            ws.onerror = (event) => {
                console.error('[GeminiLive] WebSocket error:', event)
                if (!setupDone) {
                    state.statusCallback?.('error', 'WebSocket connection failed')
                    reject(new Error('WebSocket connection failed'))
                }
            }

            ws.onclose = (event) => {
                if (DEBUG) console.log('[GeminiLive] WebSocket closed:', event.code, event.reason)
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
        sendClientContent(message)
    }

    sendContextualUpdate(update: string): void {
        // Send as a system-like context message
        sendClientContent(`[System Context Update] ${update}`)
    }
}

function sendClientContent(text: string): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    state.ws.send(JSON.stringify({
        clientContent: {
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
        }
    }))
}

function sendAudioChunk(base64Pcm: string): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    // Don't send audio while model is speaking
    if (state.modelSpeaking) return
    state.ws.send(JSON.stringify({
        realtimeInput: {
            mediaChunks: [{
                mimeType: 'audio/pcm;rate=16000',
                data: base64Pcm
            }]
        }
    }))
}

function startAudioCapture(): void {
    state.player = new GeminiAudioPlayer()
    state.recorder = new GeminiAudioRecorder()

    state.recorder.start(
        (pcm16Chunk) => sendAudioChunk(pcm16Chunk),
        (error) => {
            console.error('[GeminiLive] Audio capture error:', error)
            state.statusCallback?.('error', 'Microphone error')
        }
    )
}

// --- React component ---

export interface GeminiLiveVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function GeminiLiveVoiceSession({
    api,
    micMuted = false,
    onStatusChange,
    getSession,
    sendMessage,
    approvePermission,
    denyPermission
}: GeminiLiveVoiceSessionProps) {
    const hasRegistered = useRef(false)

    // Store status callback
    useEffect(() => {
        state.statusCallback = onStatusChange || null
        return () => { state.statusCallback = null }
    }, [onStatusChange])

    // Register session store for client tools
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

    // Register voice session once
    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new GeminiLiveVoiceSessionImpl(api))
                hasRegistered.current = true
            } catch (error) {
                console.error('[GeminiLive] Failed to register voice session:', error)
            }
        }
    }, [api])

    // Sync mic mute state
    useEffect(() => {
        if (state.recorder) {
            state.recorder.setMuted(micMuted)
        }
    }, [micMuted])

    // Handle barge-in: clear audio queue when user starts speaking
    const handleBargeIn = useCallback(() => {
        if (state.player?.isPlaying()) {
            state.player.clearQueue()
        }
    }, [])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup()
        }
    }, [])

    return null
}
