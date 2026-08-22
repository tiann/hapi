import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import type { ConversationStatus } from '@/realtime/types'
import type { MessageDeliveryMode } from '@hapi/protocol'
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

/**
 * Recover a failed voice send into the draft store without losing text the
 * operator typed while transcription/delivery was pending.
 *
 * While the composer is mounted its edits live in memory (session storage is
 * only written on unmount), so the live composer text is the authoritative
 * replacement source; a persisted draft written since `draftAtStart` covers
 * the unmounted case. Either way the failed voice text is appended after the
 * replacement so both remain recoverable, and the composer (when mounted) is
 * reseated to the merged draft so the later unmount persists the same value.
 */
export function recoverFailedVoiceSend(args: {
    mounted: boolean
    getCurrentText: () => string
    onTextChange: (text: string) => void
    recoverySessionId: string
    /** Composer text captured when the send was requested. */
    initialText: string
    /** Text that failed to deliver (the voice message to retry). */
    failedText: string
    /** Persisted draft baseline captured before the delivery attempt. */
    draftAtStart: string
}): void {
    const liveReplacement = args.mounted ? args.getCurrentText() : ''
    const persistedDraft = getDraft(args.recoverySessionId)
    if (liveReplacement.trim() && liveReplacement !== args.initialText) {
        const merged = appendTranscript(liveReplacement, args.failedText)
        saveDraft(args.recoverySessionId, merged)
        args.onTextChange(merged)
    } else if (persistedDraft !== '' && persistedDraft !== args.draftAtStart) {
        saveDraft(args.recoverySessionId, appendTranscript(persistedDraft, args.failedText))
    } else {
        saveDraft(args.recoverySessionId, args.failedText)
        if (args.mounted) args.onTextChange(args.failedText)
    }
}


/**
 * Optional session resolution for a `stopAndSend` voice send.
 *
 * Mirrors the text-send pipeline's `resolveSessionId` contract
 * (`useSendMessage`): an inactive session must be resumed via
 * `api.resumeSession` before the message POST, because the hub rejects
 * messages to inactive sessions with 409 `session_inactive`. The
 * dictation hooks send after transcription completes (possibly after the
 * composer unmounted), so the resolver is captured at call time and
 * applied at send time.
 */
export type DictationPendingSendOptions = {
    /**
     * Maps the target session id to the id the message should actually be
     * sent to (e.g. the resumed session id for an inactive session).
     * Invoked right before the message send. May throw to abort the send.
     */
    resolveSessionId?: (sessionId: string) => Promise<{ sessionId: string; resumed: boolean }>
    /**
     * Called when `resolveSessionId` resumed the session into a live one,
     * so the caller can navigate/seed the resumed session. Fires only
     * after the message was delivered successfully.
     */
    onSessionResolved?: (sessionId: string) => void
}

export function useDictation(config: {
    api: ApiClient | null
    provider: TranscriptionProvider | null
    mode: TranscriptionMode
    getCurrentText: () => string
    onTextChange: (text: string) => void
    sendMessage?: (sessionId: string, text: string, deliveryMode?: MessageDeliveryMode) => Promise<void>
}) {
    const onFinalTranscript = useCallback((transcript: string) => {
        config.onTextChange(appendTranscript(config.getCurrentText(), transcript))
    }, [config])
    const realtime = useRealtimeDictation({
        api: config.api,
        provider: config.provider,
        mode: config.mode,
        onFinalTranscript,
        sendMessage: config.sendMessage,
        getCurrentText: config.getCurrentText
    })
    const browserCanRecord = typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices?.getUserMedia === 'function'
        && typeof MediaRecorder !== 'undefined'
    const standardSupported = config.mode === 'standard'
        && config.api !== null
        && config.provider !== null
        && browserCanRecord

    const supported = realtime.supported || standardSupported
    const [status, setStatus] = useState<ConversationStatus>('disconnected')
    const [error, setError] = useState<string | null>(null)
    const mountedRef = useRef(true)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const mediaStreamRef = useRef<MediaStream | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const operationRef = useRef(0)
    const transcribingRef = useRef(false)
    const sendOnFinishRef = useRef<{ sessionId: string; initialText: string; draftAtStart: string; deliveryMode?: MessageDeliveryMode; options: DictationPendingSendOptions } | null>(null)

    const stopTracks = useCallback(() => {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop())
            mediaStreamRef.current = null
        }
    }, [])

    const start = useCallback(async () => {
        if (status !== 'disconnected' && status !== 'error') return
        setError(null)
        if (realtime.supported) {
            await realtime.toggle()
            return
        }
        if (!standardSupported || !browserCanRecord) {
            setError('Voice input is not supported in this browser')
            setStatus('error')
            return
        }
        const mimeType = preferredMimeType()
        operationRef.current += 1
        const operation = operationRef.current
        setStatus('connecting')

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            if (operationRef.current !== operation) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }
            mediaStreamRef.current = stream
            chunksRef.current = []

            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
            recorderRef.current = recorder
            const type = recorder.mimeType || mimeType || 'audio/webm'

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data)
            }

            // A MediaRecorder error can still be followed by dataavailable +
            // stop with partial bytes; treat it as a failed recording instead
            // of transcribing (and possibly auto-sending) corrupt audio.
            let recordingFailed = false
            recorder.onerror = () => {
                recordingFailed = true
            }

            recorder.onstop = async () => {
                stopTracks()
                try {
                    const blob = new Blob(chunksRef.current, { type })
                    recorderRef.current = null
                    chunksRef.current = []
                    const pendingSend = sendOnFinishRef.current
                    sendOnFinishRef.current = null

                    if (!mountedRef.current && !pendingSend) return

                    const draftUnchanged = (sid: string, baseline: string) => {
                        const cur = getDraft(sid)
                        return cur === '' || cur === baseline
                    }

                    if (recordingFailed) {
                        transcribingRef.current = false
                        if (pendingSend) {
                            recoverFailedVoiceSend({
                                mounted: mountedRef.current,
                                getCurrentText: config.getCurrentText,
                                onTextChange: config.onTextChange,
                                recoverySessionId: pendingSend.sessionId,
                                initialText: pendingSend.initialText,
                                failedText: pendingSend.initialText,
                                draftAtStart: pendingSend.draftAtStart,
                            })
                        }
                        if (mountedRef.current) {
                            setError('Audio recording failed')
                            setStatus('error')
                        }
                        return
                    }

                    if (!blob.size) {
                        transcribingRef.current = false
                        if (pendingSend) {
                            recoverFailedVoiceSend({
                                mounted: mountedRef.current,
                                getCurrentText: config.getCurrentText,
                                onTextChange: config.onTextChange,
                                recoverySessionId: pendingSend.sessionId,
                                initialText: pendingSend.initialText,
                                failedText: pendingSend.initialText,
                                draftAtStart: pendingSend.draftAtStart,
                            })
                        }
                        if (mountedRef.current) {
                            setError('No audio was recorded')
                            setStatus('error')
                        }
                        return
                    }
                    transcribingRef.current = true
                    try {
                        const savedLanguage = (typeof localStorage !== 'undefined' && localStorage.getItem('hapi-voice-lang')) || undefined
                        const result = await config.api!.transcribeVoice({
                            file: new File([blob], `speech.${recordingExtension(type)}`, { type }),
                            provider: config.provider!,
                            mode: 'standard',
                            language: savedLanguage
                        })
                        const transcribedText = result.text || ''
                        if (pendingSend) {
                            const finalMessage = appendTranscript(pendingSend.initialText, transcribedText)
                            if (finalMessage.trim()) {
                                const sendMsg = config.sendMessage ?? ((sid: string, msg: string, dm?: MessageDeliveryMode) => config.api!.sendMessage(sid, msg, null, undefined, undefined, dm))
                                let targetSessionId = pendingSend.sessionId
                                let resumed = false
                                let recoveryDraftAtStart = pendingSend.draftAtStart
                                try {
                                    if (pendingSend.options.resolveSessionId) {
                                        const resolved = await pendingSend.options.resolveSessionId(pendingSend.sessionId)
                                        targetSessionId = resolved.sessionId
                                        resumed = resolved.resumed
                                        // Snapshot the resumed session's draft BEFORE the send: the
                                        // catch compares against this to avoid clobbering text the
                                        // operator typed into the resumed composer while the request
                                        // was in flight.
                                        if (resumed) recoveryDraftAtStart = getDraft(targetSessionId)
                                    }
                                    await sendMsg(targetSessionId, finalMessage, pendingSend.deliveryMode)
                                    if (resumed) {
                                        pendingSend.options.onSessionResolved?.(targetSessionId)
                                    }
                                    if (draftUnchanged(pendingSend.sessionId, pendingSend.draftAtStart)) {
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
                                        getCurrentText: config.getCurrentText,
                                        onTextChange: config.onTextChange,
                                        recoverySessionId,
                                        initialText: pendingSend.initialText,
                                        failedText: finalMessage,
                                        draftAtStart: recoveryDraftAtStart,
                                    })
                                    if (resumed) {
                                        pendingSend.options.onSessionResolved?.(recoverySessionId)
                                    }
                                    if (mountedRef.current) {
                                        if (!config.getCurrentText().trim()) {
                                            config.onTextChange(finalMessage)
                                        }
                                        setError(sendError instanceof Error ? sendError.message : 'Failed to send message')
                                        setStatus('error')
                                        return
                                    }
                                }
                            }
                        } else if (mountedRef.current) {
                            config.onTextChange(appendTranscript(config.getCurrentText(), transcribedText))
                        }
                        if (mountedRef.current) {
                            setStatus('disconnected')
                        }
                    } catch (transcriptionError) {
                        if (pendingSend) {
                            recoverFailedVoiceSend({
                                mounted: mountedRef.current,
                                getCurrentText: config.getCurrentText,
                                onTextChange: config.onTextChange,
                                recoverySessionId: pendingSend.sessionId,
                                initialText: pendingSend.initialText,
                                failedText: pendingSend.initialText,
                                draftAtStart: pendingSend.draftAtStart,
                            })
                        }
                        if (mountedRef.current) {
                            setError(transcriptionError instanceof Error ? transcriptionError.message : 'Transcription failed')
                            setStatus('error')
                        }
                    }
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

    const stopAndSend = useCallback(async (targetSessionId: string, initialText?: string, deliveryMode?: MessageDeliveryMode, options: DictationPendingSendOptions = {}) => {
        sendOnFinishRef.current = {
            sessionId: targetSessionId,
            initialText: initialText ?? config.getCurrentText(),
            draftAtStart: getDraft(targetSessionId),
            deliveryMode,
            options
        }
        await stop()
    }, [config, stop])

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
        ? { ...realtime, stopAndSend: realtime.stopAndSend }
        : { supported, status, error, partialTranscript: '', toggle, stopAndSend }
}
