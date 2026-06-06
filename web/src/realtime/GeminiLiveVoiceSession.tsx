import { useEffect, useRef, useCallback } from 'react'
import { registerVoiceSession, resetRealtimeSessionState } from './RealtimeSession'
import { registerSessionStore } from './realtimeClientTools'
import { fetchGeminiToken } from '@/api/voice'
import { GeminiAudioRecorder } from './gemini/audioRecorder'
import { GeminiAudioPlayer } from './gemini/audioPlayer'
import { handleGeminiFunctionCalls } from './gemini/toolAdapter'
import { buildGeminiLiveSetupMessage } from '@hapi/protocol/voice'
import { resolveGeminiLiveVoice } from '@hapi/protocol/voicePickerCatalog'
import {
    buildResolvedVoiceSystemPrompt,
    encodeVoiceSystemPromptForProxy,
    truncatePromptForProxy
} from '@/lib/voicePersonalitySession'
import { loadVoicePersonalityFromStorage } from '@/hooks/useVoicePersonality'
import { isVoiceProactiveSummaryEnabled, streamDeferredVoiceContext } from '@/lib/voiceContextStream'
import { readStoredVoiceSelection } from '@/lib/voicePickerPreferences'
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
    playbackContext: AudioContext | null
    statusCallback: StatusCallback | null
    apiKey: string | null
    wsBaseUrl: string | null
    modelSpeaking: boolean
    micMuted: boolean
}

const state: GeminiLiveState = {
    ws: null,
    recorder: null,
    player: null,
    playbackContext: null,
    statusCallback: null,
    apiKey: null,
    wsBaseUrl: null,
    modelSpeaking: false,
    micMuted: false
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
    // Always reset modelSpeaking so a restart doesn't begin with audio capture silenced
    state.modelSpeaking = false
}

class GeminiLiveVoiceSessionImpl implements VoiceSession {
    private api: ApiClient

    constructor(api: ApiClient) {
        this.api = api
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        cleanup()
        state.statusCallback?.('connecting')

        // Create playback AudioContext immediately while still inside the user
        // gesture (click/tap). Mobile browsers require this for autoplay policy.
        // Store in state so cleanup() can close it on failure or stop.
        state.playbackContext = new AudioContext({ sampleRate: 24000 })
        await state.playbackContext.resume()

        // Get API key from hub
        console.log('[GeminiLive] Fetching token...')
        const tokenResp = await fetchGeminiToken(this.api)
        console.log('[GeminiLive] Token response:', { allowed: tokenResp.allowed, hasKey: !!tokenResp.apiKey, error: tokenResp.error })
        if (!tokenResp.allowed || !tokenResp.apiKey) {
            const msg = tokenResp.error ?? 'Gemini API key not available'
            console.error('[GeminiLive] Token failed:', msg)
            state.statusCallback?.('error', msg)
            cleanup()
            throw new Error(msg)
        }
        state.apiKey = tokenResp.apiKey
        state.wsBaseUrl = tokenResp.wsUrl || null
        if (!state.wsBaseUrl) {
            const msg = 'Hub must provide wsUrl for Gemini connections — direct key connection is not supported'
            state.statusCallback?.('error', msg)
            cleanup()
            throw new Error(msg)
        }

        // Request microphone
        console.log('[GeminiLive] Requesting microphone...')
        let permissionStream: MediaStream | null = null
        try {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
            console.log('[GeminiLive] Microphone granted')
        } catch (error) {
            console.error('[GeminiLive] Microphone denied:', error)
            state.statusCallback?.('error', 'Microphone permission denied')
            cleanup()
            throw error
        } finally {
            permissionStream?.getTracks().forEach((t) => t.stop())
        }

        // Connect WebSocket — use proxy URL if provided (avoids region restrictions)
        const wsBase = state.wsBaseUrl || DEFAULT_GEMINI_LIVE_WS_BASE
        const isProxy = !!state.wsBaseUrl
        const authToken = this.api.getAuthToken() || ''
        const languageParam = config.language ? `&language=${encodeURIComponent(config.language)}` : ''
        const resolvedVoice = resolveGeminiLiveVoice(config.voiceName ?? readStoredVoiceSelection('gemini-live'))
        const voiceParam = `&voice=${encodeURIComponent(resolvedVoice)}`
        const systemInstruction = buildResolvedVoiceSystemPrompt({
            language: config.language,
            backend: 'gemini-live'
        })
        const encodedPrompt = encodeVoiceSystemPromptForProxy(truncatePromptForProxy(systemInstruction))
        const promptParam = `&systemPrompt=${encodeURIComponent(encodedPrompt)}`
        const prefs = loadVoicePersonalityFromStorage()
        const affectiveParam = prefs.gemini?.affective_dialog ? '&affectiveDialog=1' : ''
        const wsUrl = isProxy
            ? `${wsBase}${wsBase.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}${languageParam}${voiceParam}${promptParam}${affectiveParam}`
            : `${wsBase}?key=${encodeURIComponent(state.apiKey)}`
        console.log('[GeminiLive] Connecting WebSocket to:', wsBase, isProxy ? '(proxied)' : '(direct)')
        const ws = new WebSocket(wsUrl)
        state.ws = ws

        return new Promise<void>((resolve, reject) => {
            let setupDone = false

            ws.onopen = () => {
                if (DEBUG) console.log('[GeminiLive] WebSocket connected', isProxy ? '(hub sends setup)' : ', sending setup')

                // Proxied sessions: hub sends HAPI-owned setup server-side (see gemini-ws proxy).
                if (!isProxy) {
                    ws.send(JSON.stringify(buildGeminiLiveSetupMessage(
                        config.language,
                        resolvedVoice,
                        systemInstruction
                    )))
                }
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

                    // Await audio capture so setMuted runs after getUserMedia resolves.
                    // Wrap so a mic failure rejects the outer startSession promise.
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
                        (chunk) => sendClientContent(`[Context] ${chunk}`, false),
                        config.streamContextChunks ?? []
                    )

                    const proactive = isVoiceProactiveSummaryEnabled()
                    if (proactive) {
                        if (config.initialContext?.trim()) {
                            sendClientContent(`[Context] ${config.initialContext}`, false)
                        }
                        sendClientContent(
                            '[Summarize] Based on all session context above, give the user a brief spoken summary of what the coding agent has been doing, then wait.',
                            true
                        )
                    } else {
                        if (config.initialContext?.trim()) {
                            sendClientContent(`[Context] ${config.initialContext}`, false)
                        }
                        sendClientContent(
                            '[Greet the user. Say a brief hello and invite them to speak. Do not mention Gemini or any model name.]',
                            true
                        )
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
                        // Restore to user's chosen mute state, not unconditionally unmuted
                        state.modelSpeaking = false
                        state.recorder?.setMuted(state.micMuted)
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
                    setupDone = true
                    cleanup()
                    state.statusCallback?.('error', 'WebSocket connection failed')
                    reject(new Error('WebSocket connection failed'))
                }
            }

            ws.onclose = (event) => {
                if (state.ws !== ws) return
                if (DEBUG) console.log('[GeminiLive] WebSocket closed:', event.code, event.reason)
                cleanup()
                resetRealtimeSessionState()
                if (!setupDone) {
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
        cleanup()
        resetRealtimeSessionState()
        state.statusCallback?.('disconnected')
    }

    sendTextMessage(message: string): void {
        sendClientContent(message)
    }

    sendContextualUpdate(update: string): void {
        // Append context without triggering a response — turnComplete: false accumulates
        // silently until the next sendTextMessage fires with turnComplete: true
        sendClientContent(`[System Context Update] ${update}`, false)
    }
}

function sendClientContent(text: string, turnComplete = true): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    state.ws.send(JSON.stringify({
        clientContent: {
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete
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

async function startAudioCapture(playbackContext: AudioContext): Promise<void> {
    state.player = new GeminiAudioPlayer(playbackContext)
    state.recorder = new GeminiAudioRecorder()

    await state.recorder.start(
        (pcm16Chunk) => sendAudioChunk(pcm16Chunk),
        (error) => {
            console.error('[GeminiLive] Audio capture error:', error)
            state.statusCallback?.('error', 'Microphone error')
        }
    )

    // Apply mute state after recorder has a stream — safe to call either way
    state.recorder.setMuted(state.micMuted)
}

// --- React component ---

export interface GeminiLiveVoiceSessionProps {
    api: ApiClient
    micMuted?: boolean
    onStatusChange?: StatusCallback
    onRegistered?: () => void
    getSession?: (sessionId: string) => Session | null
    sendMessage?: (sessionId: string, message: string) => void
    approvePermission?: (sessionId: string, requestId: string) => Promise<void>
    denyPermission?: (sessionId: string, requestId: string) => Promise<void>
}

export function GeminiLiveVoiceSession({
    api,
    micMuted = false,
    onStatusChange,
    onRegistered,
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
                onRegistered?.()
            } catch (error) {
                console.error('[GeminiLive] Failed to register voice session:', error)
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


    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup()
        }
    }, [])

    return null
}
