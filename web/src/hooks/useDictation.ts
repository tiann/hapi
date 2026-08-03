import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ConversationStatus } from '@/realtime/types'
import type { TranscriptionMode, TranscriptionProvider } from '@hapi/protocol/voice'
import { useRealtimeDictation } from './useRealtimeDictation'

export function appendTranscript(text: string, transcript: string): string {
    const addition = transcript.trim()
    if (!addition) return text
    if (!text) return addition
    return `${text}${/\s$/.test(text) ? '' : ' '}${addition}`
}

function recordingExtension(mimeType: string): string {
    if (mimeType.includes('mp4')) return 'm4a'
    if (mimeType.includes('ogg')) return 'ogg'
    return 'webm'
}

function preferredMimeType(): string | undefined {
    if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined
    return [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/webm',
        'audio/ogg;codecs=opus'
    ].find((type) => MediaRecorder.isTypeSupported(type))
}

export function useDictation(config: {
    api: ApiClient | null
    provider: TranscriptionProvider | null
    mode: TranscriptionMode
    getCurrentText: () => string
    onTextChange: (text: string) => void
}) {
    const onFinalTranscript = useCallback((transcript: string) => {
        config.onTextChange(appendTranscript(config.getCurrentText(), transcript))
    }, [config])
    const realtime = useRealtimeDictation({
        api: config.api,
        provider: config.provider,
        mode: config.mode,
        onFinalTranscript
    })
    const browserCanRecord = typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices?.getUserMedia === 'function'
        && typeof MediaRecorder !== 'undefined'
    const standardSupported = config.api !== null
        && config.provider !== null
        && config.mode === 'standard'
        && browserCanRecord
    const [status, setStatus] = useState<ConversationStatus>('disconnected')
    const [error, setError] = useState<string | null>(null)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const mountedRef = useRef(true)
    const operationRef = useRef(0)
    const transcribingRef = useRef(false)

    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
    }, [])

    const start = useCallback(async () => {
        if (!standardSupported || !config.provider || status === 'connecting' || status === 'connected') return
        const operation = ++operationRef.current
        const provider = config.provider
        const language = localStorage.getItem('hapi-voice-lang') || undefined
        setError(null)
        setStatus('connecting')
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            })
            if (operationRef.current !== operation) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }
            const mimeType = preferredMimeType()
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
            streamRef.current = stream
            recorderRef.current = recorder
            chunksRef.current = []
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data)
            }
            recorder.onerror = () => {
                stopTracks()
                setError('Audio recording failed')
                setStatus('error')
            }
            recorder.onstop = async () => {
                stopTracks()
                const type = recorder.mimeType || mimeType || 'audio/webm'
                const blob = new Blob(chunksRef.current, { type })
                recorderRef.current = null
                chunksRef.current = []
                if (!mountedRef.current) return
                if (!blob.size) {
                    transcribingRef.current = false
                    setError('No audio was recorded')
                    setStatus('error')
                    return
                }
                transcribingRef.current = true
                try {
                    const result = await config.api!.transcribeVoice({
                        file: new File([blob], `speech.${recordingExtension(type)}`, { type }),
                        provider,
                        mode: 'standard',
                        language
                    })
                    if (!mountedRef.current) return
                    config.onTextChange(appendTranscript(config.getCurrentText(), result.text))
                    setStatus('disconnected')
                } catch (transcriptionError) {
                    if (!mountedRef.current) return
                    setError(transcriptionError instanceof Error ? transcriptionError.message : 'Transcription failed')
                    setStatus('error')
                } finally {
                    transcribingRef.current = false
                }
            }
            recorder.start()
            setStatus('connected')
        } catch (startError) {
            if (operationRef.current !== operation) return
            stopTracks()
            setError(startError instanceof Error ? startError.message : 'Could not start transcription')
            setStatus('error')
        }
    }, [config, standardSupported, status, stopTracks])

    const stop = useCallback(async () => {
        if (transcribingRef.current) return
        operationRef.current += 1
        const recorder = recorderRef.current
        if (recorder && recorder.state !== 'inactive') {
            transcribingRef.current = true
            setStatus('connecting')
            recorder.stop()
        } else {
            setStatus('disconnected')
            stopTracks()
        }
    }, [stopTracks])

    const toggle = useCallback(async () => {
        if (status === 'connected' || status === 'connecting') await stop()
        else await start()
    }, [start, status, stop])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            operationRef.current += 1
            transcribingRef.current = false
            const recorder = recorderRef.current
            if (recorder && recorder.state !== 'inactive') recorder.stop()
            stopTracks()
        }
    }, [stopTracks])

    return config.mode === 'realtime'
        ? realtime
        : { supported: standardSupported, status, error, partialTranscript: '', toggle }
}
