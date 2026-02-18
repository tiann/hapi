import { useEffect, useRef, useCallback, useState } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { GEMINI_LIVE_WS_BASE, GEMINI_LIVE_MODEL, VOICE_SYSTEM_PROMPT } from '@hapi/protocol/voice'
import { realtimeClientTools, registerSessionStore } from './realtimeClientTools'

const DEBUG = import.meta.env.DEV

let statusCallback: StatusCallback | null = null

/**
 * Resolve the WebSocket URL for Gemini Live API.
 *
 * Supports two modes:
 * 1. Direct Google API: key is used as query param on googleapis.com
 * 2. CF Workers proxy: user provides a custom URL, key is sent in setup message
 */
function resolveGeminiWsUrl(apiKey: string, proxyUrl?: string | null): string {
    if (proxyUrl) {
        // User-provided proxy URL (CF Workers etc.)
        // Strip trailing slash
        const base = proxyUrl.replace(/\/+$/, '')
        // If it looks like a full wss:// URL already containing the BidiGenerateContent path, use as-is
        if (base.includes('BidiGenerateContent')) {
            return `${base}?key=${encodeURIComponent(apiKey)}`
        }
        // Otherwise, treat as a base URL and append the Gemini Live path
        return `${base}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`
    }
    // Direct Google API
    return `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(apiKey)}`
}

class GeminiVoiceSessionImpl implements VoiceSession {
    private api: ApiClient
    private ws: WebSocket | null = null
    private audioContext: AudioContext | null = null
    private mediaStream: MediaStream | null = null
    private audioWorklet: AudioWorkletNode | null = null
    private sourceNode: MediaStreamAudioSourceNode | null = null
    private playbackQueue: Float32Array[] = []
    private isPlaying = false
    private sessionActive = false

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        statusCallback?.('connecting')

        // Get Gemini API config from hub
        let geminiConfig: { apiKey?: string; proxyUrl?: string | null }
        try {
            geminiConfig = await this.api.getGeminiVoiceConfig()
        } catch (error) {
            console.error('[GeminiVoice] Failed to get config:', error)
            statusCallback?.('error', 'Failed to get Gemini voice configuration')
            throw error
        }

        // Allow user overrides from localStorage
        const userApiKey = localStorage.getItem('hapi-gemini-api-key')
        const userProxyUrl = localStorage.getItem('hapi-gemini-voice-url')

        const apiKey = userApiKey || geminiConfig.apiKey
        const proxyUrl = userProxyUrl || geminiConfig.proxyUrl

        if (!apiKey) {
            const error = new Error('Gemini API key not configured')
            statusCallback?.('error', 'Gemini API key not configured. Set it in Settings or configure GEMINI_API_KEY on the server.')
            throw error
        }

        // Request microphone permission
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            })
        } catch (error) {
            console.error('[GeminiVoice] Microphone permission denied:', error)
            statusCallback?.('error', 'Microphone permission denied')
            throw error
        }

        // Setup AudioContext for playback
        this.audioContext = new AudioContext({ sampleRate: 24000 })

        // Connect WebSocket
        const wsUrl = resolveGeminiWsUrl(apiKey, proxyUrl)
        if (DEBUG) console.log('[GeminiVoice] Connecting to:', wsUrl.replace(/key=[^&]+/, 'key=***'))

        try {
            await this.connectWebSocket(wsUrl, config)
        } catch (error) {
            this.cleanup()
            console.error('[GeminiVoice] WebSocket connection failed:', error)
            statusCallback?.('error', 'Failed to connect to Gemini Live API')
            throw error
        }
    }

    private connectWebSocket(url: string, config: VoiceSessionConfig): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url)

            const timeout = setTimeout(() => {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    this.ws?.close()
                    reject(new Error('WebSocket connection timeout'))
                }
            }, 10000)

            this.ws.onopen = () => {
                clearTimeout(timeout)
                if (DEBUG) console.log('[GeminiVoice] WebSocket connected')

                // Send setup message
                const setupMsg = {
                    setup: {
                        model: `models/${GEMINI_LIVE_MODEL}`,
                        generation_config: {
                            response_modalities: ['AUDIO'],
                            speech_config: {
                                voice_config: {
                                    prebuilt_voice_config: {
                                        voice_name: 'Aoede'
                                    }
                                }
                            }
                        },
                        system_instruction: {
                            parts: [{
                                text: VOICE_SYSTEM_PROMPT + (config.initialContext ? `\n\nCurrent session context:\n${config.initialContext}` : '')
                            }]
                        }
                    }
                }
                this.ws!.send(JSON.stringify(setupMsg))
            }

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data as string) as Record<string, unknown>

                    // Setup complete response
                    if ('setupComplete' in data) {
                        if (DEBUG) console.log('[GeminiVoice] Setup complete')
                        this.sessionActive = true
                        statusCallback?.('connected')
                        this.startAudioCapture()
                        resolve()
                        return
                    }

                    // Server content (audio/text response)
                    if ('serverContent' in data) {
                        this.handleServerContent(data.serverContent as Record<string, unknown>)
                        return
                    }

                    // Tool call from Gemini
                    if ('toolCall' in data) {
                        this.handleToolCall(data.toolCall as Record<string, unknown>)
                        return
                    }

                    if (DEBUG) console.log('[GeminiVoice] Unhandled message:', data)
                } catch (e) {
                    if (DEBUG) console.error('[GeminiVoice] Failed to parse message:', e)
                }
            }

            this.ws.onerror = (error) => {
                clearTimeout(timeout)
                console.error('[GeminiVoice] WebSocket error:', error)
                statusCallback?.('error', 'WebSocket connection error')
                reject(error)
            }

            this.ws.onclose = (event) => {
                clearTimeout(timeout)
                if (DEBUG) console.log('[GeminiVoice] WebSocket closed:', event.code, event.reason)
                if (this.sessionActive) {
                    this.sessionActive = false
                    resetRealtimeSessionState()
                    statusCallback?.('disconnected')
                } else {
                    reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`))
                }
            }
        })
    }

    private handleServerContent(content: Record<string, unknown>) {
        const modelTurn = content.modelTurn as { parts?: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }> } | undefined
        if (!modelTurn?.parts) return

        for (const part of modelTurn.parts) {
            if (part.inlineData?.data) {
                // Audio data - base64 encoded PCM
                this.playAudio(part.inlineData.data)
            }
            if (part.text) {
                if (DEBUG) console.log('[GeminiVoice] Text response:', part.text)
            }
        }
    }

    private async handleToolCall(toolCall: Record<string, unknown>) {
        const functionCalls = toolCall.functionCalls as Array<{ name: string; args: unknown; id: string }> | undefined
        if (!functionCalls) return

        for (const call of functionCalls) {
            if (DEBUG) console.log('[GeminiVoice] Tool call:', call.name, call.args)

            const handler = realtimeClientTools[call.name as keyof typeof realtimeClientTools]
            if (handler) {
                try {
                    const result = await handler(call.args)
                    // Send tool response back
                    this.ws?.send(JSON.stringify({
                        toolResponse: {
                            functionResponses: [{
                                id: call.id,
                                name: call.name,
                                response: { result }
                            }]
                        }
                    }))
                } catch (error) {
                    console.error('[GeminiVoice] Tool call error:', error)
                    this.ws?.send(JSON.stringify({
                        toolResponse: {
                            functionResponses: [{
                                id: call.id,
                                name: call.name,
                                response: { error: 'Tool execution failed' }
                            }]
                        }
                    }))
                }
            }
        }
    }

    private async startAudioCapture() {
        if (!this.mediaStream || !this.audioContext) return

        try {
            // Create a capture context at 16kHz for input
            const captureCtx = new AudioContext({ sampleRate: 16000 })
            const source = captureCtx.createMediaStreamSource(this.mediaStream)

            // Use ScriptProcessorNode for broader compatibility
            const processor = captureCtx.createScriptProcessor(4096, 1, 1)
            processor.onaudioprocess = (e) => {
                if (!this.sessionActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return

                const inputData = e.inputBuffer.getChannelData(0)
                // Convert float32 to int16 PCM
                const pcm16 = new Int16Array(inputData.length)
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]))
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
                }

                // Base64 encode
                const bytes = new Uint8Array(pcm16.buffer)
                let binary = ''
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i])
                }
                const base64 = btoa(binary)

                // Send audio to Gemini
                this.ws!.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            data: base64,
                            mimeType: 'audio/pcm;rate=16000'
                        }]
                    }
                }))
            }

            source.connect(processor)
            processor.connect(captureCtx.destination)

            this.sourceNode = source as unknown as MediaStreamAudioSourceNode
            this.audioWorklet = processor as unknown as AudioWorkletNode
        } catch (error) {
            console.error('[GeminiVoice] Audio capture setup failed:', error)
        }
    }

    private playAudio(base64Data: string) {
        if (!this.audioContext) return

        try {
            // Decode base64 to PCM bytes
            const binaryString = atob(base64Data)
            const bytes = new Uint8Array(binaryString.length)
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i)
            }

            // Convert int16 PCM to float32
            const int16 = new Int16Array(bytes.buffer)
            const float32 = new Float32Array(int16.length)
            for (let i = 0; i < int16.length; i++) {
                float32[i] = int16[i] / 32768.0
            }

            this.playbackQueue.push(float32)
            if (!this.isPlaying) {
                this.playNextChunk()
            }
        } catch (error) {
            if (DEBUG) console.error('[GeminiVoice] Audio decode error:', error)
        }
    }

    private playNextChunk() {
        if (!this.audioContext || this.playbackQueue.length === 0) {
            this.isPlaying = false
            return
        }

        this.isPlaying = true
        const chunk = this.playbackQueue.shift()!

        const buffer = this.audioContext.createBuffer(1, chunk.length, 24000)
        buffer.copyToChannel(new Float32Array(chunk), 0)

        const source = this.audioContext.createBufferSource()
        source.buffer = buffer
        source.connect(this.audioContext.destination)
        source.onended = () => this.playNextChunk()
        source.start()
    }

    async endSession(): Promise<void> {
        this.sessionActive = false
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'Session ended by user')
        }
        this.cleanup()
        statusCallback?.('disconnected')
    }

    private cleanup() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop())
            this.mediaStream = null
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {})
            this.audioContext = null
        }
        this.ws = null
        this.sourceNode = null
        this.audioWorklet = null
        this.playbackQueue = []
        this.isPlaying = false
    }

    sendTextMessage(message: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[GeminiVoice] WebSocket not connected')
            return
        }

        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: message }]
                }],
                turnComplete: true
            }
        }))
    }

    sendContextualUpdate(update: string): void {
        // Gemini Live doesn't have a direct "contextual update" concept like ElevenLabs.
        // We send it as a system-level text message.
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return
        }

        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: `[System Context Update] ${update}` }]
                }],
                turnComplete: true
            }
        }))
    }
}

export interface GeminiVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function GeminiVoiceSession({
    api,
    micMuted: micMutedProp = false,
    onStatusChange,
    getSession,
    sendMessage,
    approvePermission,
    denyPermission
}: GeminiVoiceSessionProps) {
    const hasRegistered = useRef(false)
    const [micMuted, setMicMuted] = useState(micMutedProp)

    useEffect(() => {
        setMicMuted(micMutedProp)
    }, [micMutedProp])

    useEffect(() => {
        statusCallback = onStatusChange || null
        return () => {
            statusCallback = null
        }
    }, [onStatusChange])

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

    // Register voice session implementation
    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new GeminiVoiceSessionImpl(api))
                hasRegistered.current = true
            } catch (error) {
                console.error('[GeminiVoice] Failed to register voice session:', error)
            }
        }
    }, [api])

    // This component doesn't render anything visible
    return null
}
