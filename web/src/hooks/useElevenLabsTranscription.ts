import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useScribe } from '@elevenlabs/react'
import type { ApiClient } from '@/api/client'
import type { ConversationStatus } from '@/realtime/types'
import { getElevenLabsCodeFromPreference } from '@/lib/languages'

function normalizeText(baseText: string, transcript: string): string {
    const trimmedTranscript = transcript.trim()
    if (!trimmedTranscript) {
        return baseText
    }

    const prefix = baseText.trimEnd()
    if (!prefix) {
        return trimmedTranscript
    }

    return `${prefix} ${trimmedTranscript}`
}

export function useElevenLabsTranscription(config: {
    api: ApiClient | null
    getCurrentText: () => string
    onTextChange: (text: string) => void
}): {
    supported: boolean
    status: ConversationStatus
    start: () => Promise<void>
    stop: () => Promise<void>
    toggle: () => Promise<void>
} {
    const supported = typeof window !== 'undefined'
        && typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices?.getUserMedia === 'function'
        && config.api !== null

    const baseTextRef = useRef('')
    const committedTextRef = useRef('')
    const pendingStartRef = useRef(false)
    const [localStatus, setLocalStatus] = useState<ConversationStatus>('disconnected')

    const updateText = useCallback((partialTranscript: string) => {
        config.onTextChange(
            normalizeText(
                baseTextRef.current,
                `${committedTextRef.current} ${partialTranscript}`.trim()
            )
        )
    }, [config])

    const scribe = useScribe({
        modelId: 'scribe_v2_realtime',
        onConnect: () => {
            pendingStartRef.current = false
            setLocalStatus('connected')
        },
        onPartialTranscript: ({ text }) => {
            updateText(text)
        },
        onCommittedTranscript: ({ text }) => {
            const trimmedText = text.trim()
            if (!trimmedText) return
            committedTextRef.current = `${committedTextRef.current} ${trimmedText}`.trim()
            updateText('')
        },
        onDisconnect: () => {
            pendingStartRef.current = false
            setLocalStatus('disconnected')
        },
        onError: (error) => {
            pendingStartRef.current = false
            console.error('[Voice] ElevenLabs realtime transcription error:', error)
            setLocalStatus('error')
        }
    })

    const status = useMemo<ConversationStatus>(() => {
        if (localStatus === 'error') return 'error'
        if (pendingStartRef.current) return 'connecting'
        if (scribe.status === 'connecting') return 'connecting'
        if (scribe.status === 'connected' || scribe.status === 'transcribing') return 'connected'
        if (scribe.status === 'error') return 'error'
        return localStatus
    }, [localStatus, scribe.status])

    const stop = useCallback(async () => {
        pendingStartRef.current = false
        setLocalStatus('disconnected')
        if (!scribe.isConnected && scribe.status !== 'connecting') {
            return
        }
        scribe.disconnect()
    }, [scribe])

    const start = useCallback(async () => {
        if (!supported) {
            return
        }

        if (scribe.isConnected || scribe.status === 'connecting' || pendingStartRef.current) {
            return
        }

        pendingStartRef.current = true
        setLocalStatus('connecting')
        baseTextRef.current = config.getCurrentText()
        committedTextRef.current = ''
        scribe.clearTranscripts()

        try {
            const tokenResponse = await config.api!.fetchVoiceScribeToken()
            if (!tokenResponse.token) {
                throw new Error(tokenResponse.error || 'Failed to fetch ElevenLabs realtime token')
            }

            const languageCode = getElevenLabsCodeFromPreference(localStorage.getItem('hapi-voice-lang'))

            await scribe.connect({
                token: tokenResponse.token,
                modelId: 'scribe_v2_realtime',
                languageCode,
                microphone: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1
                }
            })
        } catch (error) {
            pendingStartRef.current = false
            console.error('[Voice] Failed to start ElevenLabs realtime transcription:', error)
            setLocalStatus('error')
        }
    }, [config, scribe, supported])

    const toggle = useCallback(async () => {
        if (status === 'connected' || status === 'connecting') {
            await stop()
            return
        }
        await start()
    }, [start, status, stop])

    useEffect(() => {
        return () => {
            pendingStartRef.current = false
            scribe.disconnect()
        }
    }, [])

    return {
        supported,
        status,
        start,
        stop,
        toggle
    }
}
