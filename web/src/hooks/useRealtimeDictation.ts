import { useCallback, useEffect, useRef, useState } from 'react'
import { CommitStrategy, useScribe } from '@elevenlabs/react'
import {
    ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL,
    type TranscriptionMode,
    type TranscriptionProvider
} from '@hapi/protocol/voice'
import type { ApiClient } from '@/api/client'
import type { ConversationStatus } from '@/realtime/types'
import {
    startBrowserLocalTranscription,
    startDeepgramRealtimeTranscription,
    startOpenAIRealtimeTranscription,
    type RealtimeTranscriptionCallbacks,
    type RealtimeTranscriptionSession
} from './realtimeTranscription'

function realtimeBrowserSupport(provider: TranscriptionProvider | null): boolean {
    if (typeof navigator === 'undefined') return false
    if (provider === 'browser-local') return true
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return false
    if (provider === 'openai') return typeof RTCPeerConnection !== 'undefined'
    if (provider === 'deepgram') return typeof WebSocket !== 'undefined' && typeof MediaRecorder !== 'undefined'
    return provider === 'elevenlabs'
}

export function useRealtimeDictation(config: {
    api: ApiClient | null
    provider: TranscriptionProvider | null
    mode: TranscriptionMode
    onFinalTranscript: (text: string) => void
}) {
    const supported = config.api !== null
        && config.mode === 'realtime'
        && ['openai', 'elevenlabs', 'deepgram', 'browser-local'].includes(config.provider ?? '')
        && realtimeBrowserSupport(config.provider)
    const [status, setStatus] = useState<ConversationStatus>('disconnected')
    const [error, setError] = useState<string | null>(null)
    const [partialTranscript, setPartialTranscript] = useState('')
    const mountedRef = useRef(true)
    const operationRef = useRef(0)
    const startAbortRef = useRef<AbortController | null>(null)
    const sessionRef = useRef<RealtimeTranscriptionSession | null>(null)
    const partialRef = useRef('')
    const onFinalTranscriptRef = useRef(config.onFinalTranscript)
    const elevenLabsActiveRef = useRef(false)
    const elevenLabsFinalizedRef = useRef(false)
    const resolveElevenLabsCommitRef = useRef<(() => void) | null>(null)
    onFinalTranscriptRef.current = config.onFinalTranscript

    const updatePartial = useCallback((text: string) => {
        partialRef.current = text
        if (mountedRef.current) setPartialTranscript(text)
    }, [])

    const finish = useCallback((text: string) => {
        if (!mountedRef.current) return
        updatePartial('')
        onFinalTranscriptRef.current(text)
        setStatus('disconnected')
    }, [updatePartial])

    const fail = useCallback((value: unknown) => {
        if (!mountedRef.current) return
        elevenLabsActiveRef.current = false
        resolveElevenLabsCommitRef.current?.()
        resolveElevenLabsCommitRef.current = null
        sessionRef.current?.cancel()
        sessionRef.current = null
        setError(value instanceof Error ? value.message : 'Realtime transcription failed')
        setStatus('error')
    }, [])

    const elevenLabs = useScribe({
        modelId: ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL,
        commitStrategy: CommitStrategy.MANUAL,
        onSessionStarted: () => {
            if (mountedRef.current && elevenLabsActiveRef.current) setStatus('connected')
        },
        onPartialTranscript: ({ text }) => {
            if (elevenLabsActiveRef.current) updatePartial(text)
        },
        onCommittedTranscript: ({ text }) => {
            if (!elevenLabsActiveRef.current) return
            elevenLabsFinalizedRef.current = true
            elevenLabsActiveRef.current = false
            finish(text)
            resolveElevenLabsCommitRef.current?.()
            resolveElevenLabsCommitRef.current = null
        },
        onError: (scribeError) => {
            if (elevenLabsActiveRef.current) fail(scribeError)
        },
        onDisconnect: () => {
            if (!mountedRef.current || !elevenLabsActiveRef.current) return
            const partial = partialRef.current
            elevenLabsActiveRef.current = false
            resolveElevenLabsCommitRef.current?.()
            resolveElevenLabsCommitRef.current = null
            sessionRef.current = null
            finish(partial)
            setError('ElevenLabs realtime transcription disconnected')
            setStatus('error')
        }
    })
    const elevenLabsRef = useRef(elevenLabs)
    elevenLabsRef.current = elevenLabs

    const start = useCallback(async () => {
        if (!supported || !config.api || !config.provider || status === 'connecting' || status === 'connected') return
        const operation = ++operationRef.current
        const controller = new AbortController()
        startAbortRef.current = controller
        const provider = config.provider
        const language = localStorage.getItem('hapi-voice-lang') || undefined
        setError(null)
        updatePartial('')
        setStatus('connecting')

        const callbacks: RealtimeTranscriptionCallbacks = {
            onConnected: () => {
                if (mountedRef.current && operationRef.current === operation) setStatus('connected')
            },
            onPartial: (text) => {
                if (operationRef.current === operation) updatePartial(text)
            },
            onFinal: (text) => {
                if (operationRef.current === operation) finish(text)
            },
            onError: (realtimeError) => {
                if (operationRef.current === operation) fail(realtimeError)
            }
        }

        try {
            if (provider === 'elevenlabs') {
                const { token } = await config.api.fetchRealtimeTranscriptionToken('elevenlabs', language, controller.signal)
                if (operationRef.current !== operation) return
                elevenLabsActiveRef.current = true
                elevenLabsFinalizedRef.current = false
                await elevenLabs.connect({
                    token,
                    modelId: ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL,
                    commitStrategy: CommitStrategy.MANUAL,
                    languageCode: language?.split('-')[0]?.toLowerCase(),
                    microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                })
                if (operationRef.current !== operation) {
                    elevenLabsActiveRef.current = false
                    elevenLabs.disconnect()
                    return
                }
                sessionRef.current = {
                    stop: async () => {
                        setStatus('connecting')
                        const committed = new Promise<void>((resolve) => {
                            resolveElevenLabsCommitRef.current = resolve
                        })
                        try {
                            elevenLabs.commit()
                            await Promise.race([
                                committed,
                                new Promise<void>((resolve) => setTimeout(resolve, 2_500))
                            ])
                        } finally {
                            if (elevenLabsActiveRef.current && !elevenLabsFinalizedRef.current) finish(partialRef.current)
                            elevenLabsActiveRef.current = false
                            resolveElevenLabsCommitRef.current = null
                            elevenLabs.disconnect()
                        }
                    },
                    cancel: () => {
                        elevenLabsActiveRef.current = false
                        elevenLabs.disconnect()
                    }
                }
                return
            }

            const getToken = async () => {
                if (operationRef.current !== operation) throw new Error('Realtime transcription cancelled')
                const result = await config.api!.fetchRealtimeTranscriptionToken(
                    provider as 'openai' | 'deepgram',
                    language,
                    controller.signal
                )
                if (operationRef.current !== operation) throw new Error('Realtime transcription cancelled')
                return result.token
            }
            const session = provider === 'openai'
                ? await startOpenAIRealtimeTranscription({ getToken, signal: controller.signal, callbacks })
                : provider === 'deepgram'
                    ? await startDeepgramRealtimeTranscription({ getToken, language, signal: controller.signal, callbacks })
                    : await startBrowserLocalTranscription({ language, signal: controller.signal, callbacks })
            if (operationRef.current !== operation) session.cancel()
            else sessionRef.current = session
        } catch (startError) {
            if (operationRef.current === operation) fail(startError)
        } finally {
            if (startAbortRef.current === controller) startAbortRef.current = null
        }
    }, [config.api, config.provider, elevenLabs, fail, finish, status, supported, updatePartial])

    const stop = useCallback(async () => {
        const session = sessionRef.current
        if (!session) {
            operationRef.current += 1
            startAbortRef.current?.abort()
            startAbortRef.current = null
            if (elevenLabsActiveRef.current) {
                elevenLabsActiveRef.current = false
                elevenLabs.disconnect()
            }
            setStatus('disconnected')
            return
        }
        setStatus('connecting')
        try {
            await session.stop()
        } catch (stopError) {
            fail(stopError)
        } finally {
            if (sessionRef.current === session) sessionRef.current = null
        }
    }, [elevenLabs, fail])

    const toggle = useCallback(async () => {
        if (status === 'connected' || status === 'connecting') await stop()
        else await start()
    }, [start, status, stop])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            operationRef.current += 1
            startAbortRef.current?.abort()
            startAbortRef.current = null
            elevenLabsActiveRef.current = false
            elevenLabsRef.current.disconnect()
            resolveElevenLabsCommitRef.current?.()
            sessionRef.current?.cancel()
            sessionRef.current = null
        }
    }, [])

    return { supported, status, error, partialTranscript, toggle }
}
