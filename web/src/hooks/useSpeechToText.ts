import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationStatus } from '@/realtime/types'

interface SpeechRecognitionResultLike {
    isFinal: boolean
    0: {
        transcript: string
    }
}

interface SpeechRecognitionEventLike extends Event {
    results: ArrayLike<SpeechRecognitionResultLike>
    resultIndex: number
}

interface SpeechRecognitionLike extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    onstart: ((event: Event) => void) | null
    onend: ((event: Event) => void) | null
    onerror: ((event: Event & { error?: string }) => void) | null
    onresult: ((event: SpeechRecognitionEventLike) => void) | null
    start(): void
    stop(): void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
    interface Window {
        SpeechRecognition?: SpeechRecognitionConstructor
        webkitSpeechRecognition?: SpeechRecognitionConstructor
    }
}

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

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
    return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export function useSpeechToText(config: {
    getCurrentText: () => string
    onTextChange: (text: string) => void
}): {
    supported: boolean
    status: ConversationStatus
    start: () => void
    stop: () => void
    toggle: () => void
} {
    const supported = typeof window !== 'undefined' && getRecognitionConstructor() !== null
    const [status, setStatus] = useState<ConversationStatus>('disconnected')
    const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
    const baseTextRef = useRef('')
    const finalizedTextRef = useRef('')

    const stop = useCallback(() => {
        recognitionRef.current?.stop()
    }, [])

    const start = useCallback(() => {
        const Recognition = getRecognitionConstructor()
        if (!Recognition) {
            setStatus('error')
            return
        }

        recognitionRef.current?.stop()
        setStatus('connecting')

        const recognition = new Recognition()
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = localStorage.getItem('hapi-voice-lang') || navigator.language || 'en-US'

        baseTextRef.current = config.getCurrentText()
        finalizedTextRef.current = ''

        recognition.onstart = () => {
            setStatus('connected')
        }

        recognition.onresult = (event) => {
            let finalizedChunk = ''
            let interimChunk = ''

            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const transcript = event.results[index]?.[0]?.transcript ?? ''
                if (!transcript.trim()) continue
                if (event.results[index].isFinal) {
                    finalizedChunk += `${transcript} `
                } else {
                    interimChunk += `${transcript} `
                }
            }

            if (finalizedChunk.trim()) {
                finalizedTextRef.current = `${finalizedTextRef.current} ${finalizedChunk}`.trim()
            }

            const nextText = normalizeText(
                baseTextRef.current,
                `${finalizedTextRef.current} ${interimChunk}`.trim()
            )
            config.onTextChange(nextText)
        }

        recognition.onerror = () => {
            recognitionRef.current = null
            setStatus('error')
        }

        recognition.onend = () => {
            recognitionRef.current = null
            setStatus((current) => (current === 'error' ? current : 'disconnected'))
        }

        recognitionRef.current = recognition
        recognition.start()
    }, [config])

    const toggle = useCallback(() => {
        if (status === 'connected' || status === 'connecting') {
            stop()
            return
        }
        start()
    }, [start, status, stop])

    useEffect(() => {
        return () => {
            recognitionRef.current?.stop()
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
