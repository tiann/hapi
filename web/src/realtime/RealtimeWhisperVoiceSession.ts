import type { VoiceSession, VoiceSessionConfig, StatusCallback } from './types'
import type { SessionStore } from './transcriptRouter'
import { routeTranscript, speak } from './transcriptRouter'
import { PcmAudioCapture, arrayBufferToBase64 } from './pcmAudioCapture'

const DEBUG = import.meta.env.DEV

/**
 * VoiceSession implementation that streams audio over a WebSocket
 * to a Speaches-compatible Realtime API (OpenAI protocol) via the hub proxy.
 *
 * The hub at /api/voice/ws transparently proxies the WebSocket to
 * the local Speaches server at /v1/realtime?intent=transcription.
 *
 * Speaches handles Voice Activity Detection (VAD) server-side, so
 * the "processing" status only shows when the user actually stops speaking.
 */
export class RealtimeWhisperVoiceSessionImpl implements VoiceSession {
    private ws: WebSocket | null = null
    private audioCapture: PcmAudioCapture | null = null
    private activeSessionId: string | null = null
    private isMuted = false

    private statusCallback: StatusCallback | null = null
    private sessionStore: SessionStore | null = null

    constructor(private readonly wsUrl: string) {}

    setMuted(muted: boolean): void {
        this.isMuted = muted
        this.audioCapture?.setMuted(muted)
    }

    setStatusCallback(cb: StatusCallback | null): void {
        this.statusCallback = cb
    }

    setSessionStore(store: SessionStore | null): void {
        this.sessionStore = store
    }

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!this.sessionStore) {
            this.statusCallback?.('error', 'Voice session store not initialized')
            throw new Error('Voice session store not initialized')
        }

        this.activeSessionId = config.sessionId
        this.statusCallback?.('connecting')

        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl)
            this.ws = ws
            let settled = false
            let upstreamOpen = false
            let sessionConfigured = false

            const maybeStartAudioCapture = () => {
                if (settled || !upstreamOpen || !sessionConfigured) {
                    return
                }
                settled = true
                if (DEBUG) console.log('[Voice WS] Upstream ready + session configured, starting audio capture')
                this.startAudioCapture(ws, config).then(resolve, reject)
            }

            ws.onopen = () => {
                if (DEBUG) console.log('[Voice WS] Connected')
            }

            ws.onmessage = (event) => {
                if (typeof event.data !== 'string') return

                let msg: { type: string; [key: string]: unknown }
                try { msg = JSON.parse(event.data) } catch { return }

                if (msg.type === 'hapi.upstream.open') {
                    upstreamOpen = true
                    maybeStartAudioCapture()
                    return
                }

                // Wait for session.created, then send session.update
                if (msg.type === 'session.created') {
                    if (DEBUG) console.log('[Voice WS] Session created, configuring...')
                    const session: Record<string, unknown> = {
                        turn_detection: {
                            type: 'server_vad',
                            create_response: false,
                            silence_duration_ms: 550,
                            threshold: 0.9
                        }
                    }
                    if (config.language) {
                        session.input_audio_transcription = {
                            model: (msg as { session?: { input_audio_transcription?: { model?: string } } })
                                .session?.input_audio_transcription?.model ?? 'Systran/faster-distil-whisper-small.en',
                            language: config.language
                        }
                    }
                    ws.send(JSON.stringify({ type: 'session.update', session }))
                    return
                }

                // Once session.updated confirms, start audio capture
                if (msg.type === 'session.updated') {
                    sessionConfigured = true
                    maybeStartAudioCapture()
                    return
                }

                this.handleMessage(event.data)
            }

            ws.onerror = (event) => {
                if (DEBUG) console.error('[Voice WS] Error:', event)
                if (!settled) {
                    settled = true
                    this.statusCallback?.('error', 'Voice WebSocket connection failed')
                    this.cleanup()
                    reject(new Error('WebSocket connection failed'))
                }
            }

            ws.onclose = () => {
                if (DEBUG) console.log('[Voice WS] Closed')
                if (!settled) {
                    settled = true
                    this.statusCallback?.('error', 'Voice WebSocket closed unexpectedly')
                    this.cleanup()
                    reject(new Error('WebSocket closed before session was configured'))
                } else if (this.activeSessionId) {
                    this.statusCallback?.('disconnected')
                    this.cleanup()
                }
            }
        })
    }

    private async startAudioCapture(ws: WebSocket, _config: VoiceSessionConfig): Promise<void> {
        try {
            this.audioCapture = new PcmAudioCapture()
            this.audioCapture.setMuted(this.isMuted)
            await this.audioCapture.start((pcm16) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: arrayBufferToBase64(pcm16)
                    }))
                }
            })
            this.statusCallback?.('connected')
        } catch (error) {
            this.statusCallback?.('error', 'Microphone permission denied')
            this.cleanup()
            throw error
        }
    }

    async endSession(): Promise<void> {
        this.cleanup()
        this.statusCallback?.('disconnected')
    }

    sendTextMessage(message: string): void {
        speak(message)
    }

    sendContextualUpdate(_update: string): void {
        // Not used in local whisper realtime mode
    }

    private handleMessage(data: string | ArrayBuffer | Blob): void {
        if (typeof data !== 'string') return

        let message: { type: string; transcript?: string; error?: { message?: string } }
        try {
            message = JSON.parse(data)
        } catch {
            if (DEBUG) console.warn('[Voice WS] Failed to parse message:', data)
            return
        }

        if (DEBUG) console.log('[Voice WS] Event:', message.type)

        switch (message.type) {
            case 'input_audio_buffer.speech_started':
                // User started speaking — stay in connected state
                break

            case 'input_audio_buffer.speech_stopped':
                // User stopped speaking — server is processing
                this.statusCallback?.('processing')
                break

            case 'input_audio_buffer.committed':
                // Buffer committed for transcription — still processing
                break

            case 'conversation.item.input_audio_transcription.completed': {
                const transcript = message.transcript?.trim()
                if (transcript && this.activeSessionId && this.sessionStore) {
                    void routeTranscript(this.sessionStore, this.activeSessionId, transcript)
                }
                // Ready for next utterance
                this.statusCallback?.('connected')
                break
            }

            case 'error': {
                const errMsg = message.error?.message || 'Transcription error'
                // Non-fatal errors (e.g. unsupported field warnings) — log but don't change status
                if (errMsg.includes('not supported') || errMsg.includes('not configurable')) {
                    if (DEBUG) console.warn('[Voice WS] Non-fatal server warning:', errMsg)
                } else {
                    console.error('[Voice WS] Server error:', errMsg)
                    this.statusCallback?.('error', errMsg)
                }
                break
            }

            default:
                if (DEBUG) console.log('[Voice WS] Unhandled event:', message.type)
        }
    }

    private cleanup(): void {
        this.activeSessionId = null

        if (this.audioCapture) {
            this.audioCapture.stop()
            this.audioCapture = null
        }

        if (this.ws) {
            const ws = this.ws
            this.ws = null
            if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
                ws.close()
            }
        }
    }
}
