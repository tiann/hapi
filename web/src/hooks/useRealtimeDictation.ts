import { useCallback, useEffect, useRef, useState } from 'react'
import { CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from '@elevenlabs/client'
import {
    ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL,
    type TranscriptionMode,
    type TranscriptionProvider
} from '@hapi/protocol/voice'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { saveDraft, clearDraft, getDraft, getDraftRevision } from '@/lib/composer-drafts'
import { sendVoiceMessage } from '@/lib/dictationSend'
import type { ConversationStatus } from '@/realtime/types'
import { appendTranscript, recoverFailedVoiceSend, transferVoiceDraftAfterSend, type DictationPendingSendOptions } from './useDictation'
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
    onTextChange: (text: string) => void
    sendMessage?: (sessionId: string, text: string, deliveryMode?: MessageDeliveryMode) => Promise<void>
    getCurrentText?: () => string
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
    const onTextChangeRef = useRef(config.onTextChange)
    const elevenLabsRef = useRef<RealtimeConnection | null>(null)
    const elevenLabsActiveRef = useRef(false)
    const elevenLabsFinalizedRef = useRef(false)
    const resolveElevenLabsCommitRef = useRef<(() => void) | null>(null)
    onFinalTranscriptRef.current = config.onFinalTranscript
    onTextChangeRef.current = config.onTextChange

    const updatePartial = useCallback((text: string) => {
        partialRef.current = text
        if (mountedRef.current) setPartialTranscript(text)
    }, [])

    const sendOnFinishRef = useRef<{ sessionId: string; initialText: string; draftAtStart: string; draftRevisionAtStart: number; deliveryMode?: MessageDeliveryMode; options: DictationPendingSendOptions } | null>(null)

    const finish = useCallback(async (text: string) => {
        const pendingSend = sendOnFinishRef.current
        sendOnFinishRef.current = null
        updatePartial('')
        if (pendingSend) {
            const finalMessage = appendTranscript(pendingSend.initialText, text)
            if (finalMessage.trim()) {
                const sendMsg = config.sendMessage ?? ((sid: string, msg: string, dm?: MessageDeliveryMode) => sendVoiceMessage(config.api!, sid, msg, dm))
                let targetSessionId = pendingSend.sessionId
                let resumed = false
                try {
                    if (pendingSend.options.resolveSessionId) {
                        const resolved = await pendingSend.options.resolveSessionId(pendingSend.sessionId)
                        targetSessionId = resolved.sessionId
                        resumed = resolved.resumed
                    }
                    await sendMsg(targetSessionId, finalMessage, pendingSend.deliveryMode)
                    if (resumed) {
                        await transferVoiceDraftAfterSend(
                            pendingSend.sessionId,
                            targetSessionId,
                            pendingSend.draftAtStart,
                            pendingSend.draftRevisionAtStart,
                            pendingSend.options.onSessionResolved,
                        )
                    }
                    const cur = getDraft(pendingSend.sessionId)
                    if (cur === '' || (cur === pendingSend.draftAtStart
                        && getDraftRevision(pendingSend.sessionId) === pendingSend.draftRevisionAtStart)) {
                        clearDraft(pendingSend.sessionId)
                    }
                } catch (sendError) {
                    // After a resume the source session is superseded: recover the
                    // retryable transcript under the LIVE resumed id so the operator
                    // can retry from the resumed session (and is navigated there via
                    // onSessionResolved) instead of leaving it under the archived
                    // source id.
                    const recoverySessionId = resumed ? targetSessionId : pendingSend.sessionId
                    recoverFailedVoiceSend({
                        mounted: mountedRef.current,
                        getCurrentText: config.getCurrentText ?? (() => ''),
                        onTextChange: onTextChangeRef.current,
                        recoverySessionId,
                        initialText: pendingSend.initialText,
                        failedText: finalMessage,
                        draftAtStart: pendingSend.draftAtStart,
                        draftRevisionAtStart: pendingSend.draftRevisionAtStart,
                        sourceSessionId: pendingSend.sessionId,
                        sourceDraftAtStart: pendingSend.draftAtStart,
                    })
                    if (resumed) {
                        pendingSend.options.onSessionResolved?.(recoverySessionId)
                    }
                    if (mountedRef.current) {
                        if (!config.getCurrentText?.().trim()) {
                            onTextChangeRef.current(finalMessage)
                        }
                        setError(sendError instanceof Error ? sendError.message : 'Failed to send message')
                        setStatus('error')
                        return
                    }
                }
            }
        } else if (mountedRef.current) {
            onFinalTranscriptRef.current(text)
            setStatus('disconnected')
        }
        if (mountedRef.current) {
            setStatus('disconnected')
        }
    }, [config.api, config.getCurrentText, config.sendMessage, updatePartial])

    const fail = useCallback((value: unknown) => {
        const pendingSend = sendOnFinishRef.current
        sendOnFinishRef.current = null
        if (pendingSend) {
            const finalMessage = appendTranscript(pendingSend.initialText, partialRef.current)
            recoverFailedVoiceSend({
                mounted: mountedRef.current,
                getCurrentText: config.getCurrentText ?? (() => ''),
                onTextChange: onTextChangeRef.current,
                recoverySessionId: pendingSend.sessionId,
                initialText: pendingSend.initialText,
                failedText: finalMessage,
                draftAtStart: pendingSend.draftAtStart,
                draftRevisionAtStart: pendingSend.draftRevisionAtStart,
            })
        }
        elevenLabsActiveRef.current = false
        resolveElevenLabsCommitRef.current?.()
        resolveElevenLabsCommitRef.current = null
        sessionRef.current?.cancel()
        sessionRef.current = null
        if (!mountedRef.current) return
        setError(value instanceof Error ? value.message : 'Transcription failed')
        setStatus('error')
    }, [config.getCurrentText])

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
                const elevenLabs = Scribe.connect({
                    token,
                    modelId: ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL,
                    commitStrategy: CommitStrategy.MANUAL,
                    languageCode: language?.split('-')[0]?.toLowerCase(),
                    microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                })
                elevenLabsRef.current = elevenLabs
                elevenLabs.on(RealtimeEvents.SESSION_STARTED, () => {
                    if (mountedRef.current && elevenLabsActiveRef.current) setStatus('connected')
                })
                elevenLabs.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
                    if (elevenLabsActiveRef.current && elevenLabsRef.current === elevenLabs) updatePartial(text)
                })
                elevenLabs.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
                    if (!elevenLabsActiveRef.current || elevenLabsRef.current !== elevenLabs) return
                    elevenLabsFinalizedRef.current = true
                    elevenLabsActiveRef.current = false
                    void finish(text)
                    resolveElevenLabsCommitRef.current?.()
                    resolveElevenLabsCommitRef.current = null
                })
                elevenLabs.on(RealtimeEvents.ERROR, ({ error }) => {
                    if (elevenLabsActiveRef.current && elevenLabsRef.current === elevenLabs) fail(new Error(error))
                })
                elevenLabs.on(RealtimeEvents.CLOSE, () => {
                    if (elevenLabsRef.current !== elevenLabs) return
                    elevenLabsRef.current = null
                    if (!elevenLabsActiveRef.current) return
                    const partial = partialRef.current
                    elevenLabsActiveRef.current = false
                    resolveElevenLabsCommitRef.current?.()
                    resolveElevenLabsCommitRef.current = null
                    sessionRef.current = null
                    void finish(partial)
                    if (mountedRef.current) {
                        setError('ElevenLabs realtime transcription disconnected')
                        setStatus('error')
                    }
                })
                sessionRef.current = {
                    stop: async () => {
                        if (mountedRef.current) setStatus('connecting')
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
                            elevenLabs.close()
                            if (elevenLabsRef.current === elevenLabs) elevenLabsRef.current = null
                        }
                    },
                    cancel: () => {
                        elevenLabsActiveRef.current = false
                        elevenLabs.close()
                        if (elevenLabsRef.current === elevenLabs) elevenLabsRef.current = null
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
    }, [config.api, config.provider, fail, finish, status, supported, updatePartial])

    const stop = useCallback(async () => {
        const session = sessionRef.current
        if (!session) {
            operationRef.current += 1
            startAbortRef.current?.abort()
            startAbortRef.current = null
            if (elevenLabsActiveRef.current) {
                elevenLabsActiveRef.current = false
                elevenLabsRef.current?.close()
                elevenLabsRef.current = null
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
    }, [fail])

    const stopAndSend = useCallback(async (targetSessionId: string, initialText?: string, deliveryMode?: MessageDeliveryMode, options: DictationPendingSendOptions = {}) => {
        sendOnFinishRef.current = { sessionId: targetSessionId, initialText: initialText ?? '', draftAtStart: getDraft(targetSessionId), draftRevisionAtStart: getDraftRevision(targetSessionId), deliveryMode, options }
        await stop()
    }, [stop])

    const toggle = useCallback(async () => {
        if (status === 'connected' || status === 'connecting') await stop()
        else await start()
    }, [start, status, stop])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (sendOnFinishRef.current) return
            operationRef.current += 1
            startAbortRef.current?.abort()
            startAbortRef.current = null
            elevenLabsActiveRef.current = false
            resolveElevenLabsCommitRef.current?.()
            sessionRef.current?.cancel()
            sessionRef.current = null
            elevenLabsRef.current?.close()
            elevenLabsRef.current = null
        }
    }, [])

    return { supported, status, error, partialTranscript, toggle, stopAndSend }
}
