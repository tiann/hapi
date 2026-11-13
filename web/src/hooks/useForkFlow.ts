import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type ApiClient } from '@/api/client'
import { buildForkPreviewView, type ForkPreviewView } from '@/lib/forkPreview'
import { useTranslation } from '@/lib/use-translation'
import type { ForkBoundary, ForkPreviewResponse } from '@hapi/protocol/forkBoundary'

/** Live session facts the fork flow needs; a superset is fine. */
export type ForkFlowSession = {
    id: string
    thinking: boolean
}

export type ForkPreviewIntent = 'current' | 'message' | 'rewind'

export type ForkFlowState = {
    intent: ForkPreviewIntent
    messageLocalId?: string
    response: ForkPreviewResponse
    view: ForkPreviewView
}

export type ForkFlow = {
    /** True while the flow holds the UI (loading, preview, error or legacy). */
    flowOpen: boolean
    /** Ready preview state; null while closed, loading or errored. */
    preview: ForkFlowState | null
    /** True while a preview request is in flight. */
    loading: boolean
    /** Preview failure message; the dialog stays open and shows it. */
    errorMessage: string | null
    /** True when the failure was a connect-level error (no hub answer), so a
     * retry is meaningful; hub rejections leave it false. */
    errorWasConnectFailure: boolean
    /** True when the hub has no preview endpoint: render the legacy confirm. */
    legacyFallback: boolean
    /** The request to re-run through the legacy confirm dialog. */
    legacyRequest: { intent: ForkPreviewIntent; messageLocalId?: string } | null
    /** True when the last confirm was refused as boundary_moved and the
     * preview has been refreshed for a re-confirmation. */
    stale: boolean
    openFork: (messageLocalId?: string) => void
    openRewind: (messageLocalId: string) => void
    closePreview: () => void
    confirmPreview: () => Promise<void>
    /** Legacy confirm for the 404 fallback path (old hub, no preview route). */
    confirmLegacy: () => Promise<void>
    /** Re-run the request that produced the current error dialog. */
    retryPreview: () => void
}

type UseForkFlowOptions = {
    session: ForkFlowSession
    api: ApiClient
    /** Called with the child session id after a confirmed fork. */
    onForked: (childSessionId: string) => void
    /** Called with the boundary localId after a confirmed rewind. */
    onRewound?: (messageLocalId: string) => void | Promise<void>
    /** The runner can only fork at this boundary instead of rewinding. */
    onRewindForkSafeFallback?: (messageLocalId: string) => void
}

function apiErrorText(error: unknown, fallback: string): string {
    if (error instanceof ApiError && error.body) {
        try {
            const parsed = JSON.parse(error.body) as { error?: unknown }
            if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
        } catch {
            // Fall through to the generic message.
        }
    }
    if (error instanceof Error && error.message) return error.message
    return fallback
}

/**
 * One fork/rewind flow for the session chat and the session list: ask the hub
 * for a preview, show it, and confirm with the boundary token. A 409
 * boundary_moved refreshes the preview in place and demands a re-confirm; a
 * 404 (older hub) falls back to the legacy confirm dialog.
 */
export function useForkFlow(options: UseForkFlowOptions): ForkFlow {
    const { api, onForked, onRewound, onRewindForkSafeFallback } = options
    const { t } = useTranslation()
    const [state, setState] = useState<ForkFlowState | null>(null)
    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [errorWasConnectFailure, setErrorWasConnectFailure] = useState(false)
    const [legacyRequest, setLegacyRequest] = useState<ForkFlow['legacyRequest']>(null)
    const [stale, setStale] = useState(false)
    const lastFailedRequestRef = useRef<ForkFlow['legacyRequest']>(null)
    const pendingRequestRef = useRef<ForkFlow['legacyRequest']>(null)
    const confirmingRef = useRef(false)
    const requestSeq = useRef(0)
    const sessionRef = useRef(options.session)
    sessionRef.current = options.session
    const stateRef = useRef(state)
    stateRef.current = state

    const closePreview = useCallback(() => {
        requestSeq.current += 1
        pendingRequestRef.current = null
        setState(null)
        setLoading(false)
        setErrorMessage(null)
        setErrorWasConnectFailure(false)
        setLegacyRequest(null)
        setStale(false)
        lastFailedRequestRef.current = null
    }, [])

    const fetchPreview = useCallback(async (intent: ForkPreviewIntent, messageLocalId?: string) => {
        const seq = ++requestSeq.current
        pendingRequestRef.current = { intent, messageLocalId }
        setLoading(true)
        setErrorMessage(null)
        setErrorWasConnectFailure(false)
        try {
            const response = await api.forkPreview(sessionRef.current.id, intent, messageLocalId)
            if (seq !== requestSeq.current) return
            pendingRequestRef.current = null
            lastFailedRequestRef.current = null
            setState({ intent, messageLocalId, response, view: buildForkPreviewView(response) })
        } catch (error) {
            if (seq !== requestSeq.current) return
            pendingRequestRef.current = null
            if (error instanceof ApiError && error.status === 404) {
                // Older hub without the preview route: keep the requested
                // boundary for the legacy confirm dialog.
                setLegacyRequest({ intent, messageLocalId })
                setState(null)
                return
            }
            // Drop the previous preview so the error dialog is not masked by
            // the outdated boundary still being mounted.
            setState(null)
            // Connect-level failures (no hub answer) are retryable; hub
            // rejections answer with an ApiError and stay dismiss-only.
            setErrorWasConnectFailure(!(error instanceof ApiError))
            lastFailedRequestRef.current = { intent, messageLocalId }
            setErrorMessage(apiErrorText(error, t('dialog.error.default')))
        } finally {
            if (seq === requestSeq.current) {
                pendingRequestRef.current = null
                setLoading(false)
            }
        }
    }, [api, t])

    const openFork = useCallback((messageLocalId?: string) => {
        setStale(false)
        void fetchPreview(messageLocalId ? 'message' : 'current', messageLocalId)
    }, [fetchPreview])

    const openRewind = useCallback((messageLocalId: string) => {
        setStale(false)
        void fetchPreview('rewind', messageLocalId)
    }, [fetchPreview])

    const confirmLegacy = useCallback(async () => {
        // Older hub: no preview route exists, so re-derive the fork mode
        // client-side exactly like the pre-preview confirm dialog did.
        const request = legacyRequest ?? { intent: 'current' as const, messageLocalId: state?.messageLocalId }
        const target = sessionRef.current
        if (request.intent === 'rewind') {
            await api.rewindConversation(target.id, request.messageLocalId!)
            closePreview()
            await onRewound?.(request.messageLocalId!)
            return
        }
        const supportsCompletedFork = (target as unknown as {
            metadata?: { capabilities?: { conversationHistory?: { forkLatestCompleted?: boolean } } }
        })?.metadata?.capabilities?.conversationHistory?.forkLatestCompleted === true
        const result = !request.messageLocalId && target.thinking && supportsCompletedFork
            ? await api.forkConversation(target.id, undefined, true)
            : await api.forkConversation(target.id, request.messageLocalId)
        closePreview()
        onForked(result.sessionId)
    }, [api, closePreview, legacyRequest, onForked, onRewound, state])

    const confirmPreview = useCallback(async () => {
        const current = stateRef.current
        if (!current) return
        const { intent, messageLocalId, response } = current
        const boundary: ForkBoundary = response.boundary
        try {
            if (intent === 'rewind') {
                await api.rewindConversation(sessionRef.current.id, messageLocalId!, boundary)
                closePreview()
                await onRewound?.(messageLocalId!)
                return
            }
            const message = intent === 'message' ? messageLocalId : undefined
            const latestCompleted = response.mode === 'latestCompleted'
            const result = await api.forkConversation(sessionRef.current.id, message, latestCompleted, boundary)
            closePreview()
            onForked(result.sessionId)
        } catch (error) {
            if (error instanceof ApiError && error.code === 'boundary_moved') {
                // The source moved since the preview: refresh in place and ask
                // for a fresh confirmation instead of closing the dialog.
                setStale(true)
                await fetchPreview(intent, messageLocalId)
                return
            }
            if (intent === 'rewind' && error instanceof ApiError
                && error.code === 'ambiguous_native_boundary_fork_safe') {
                closePreview()
                onRewindForkSafeFallback?.(messageLocalId!)
                return
            }
            throw error
        }
    }, [api, closePreview, fetchPreview, onForked, onRewindForkSafeFallback, onRewound])

    // The hub resolves the mode from the live session. Re-answer the preview
    // while the dialog is open when the source starts or stops running, so the
    // shown boundary never outlives the state it was computed from. The
    // in-flight request is tracked in a ref so an edge that lands before the
    // answer still re-issues it, and a confirm in flight is left alone.
    const thinking = options.session.thinking
    const lastThinkingRef = useRef(thinking)
    useEffect(() => {
        const wasThinking = lastThinkingRef.current
        lastThinkingRef.current = thinking
        if (wasThinking === thinking) return
        if (confirmingRef.current) return
        const current = stateRef.current
        const pending = pendingRequestRef.current
        if (!current && !pending && !loading) return
        const intent = current?.intent ?? pending?.intent ?? legacyRequest?.intent
        if (!intent) return
        void fetchPreview(intent, current?.messageLocalId ?? pending?.messageLocalId ?? legacyRequest?.messageLocalId)
    }, [fetchPreview, legacyRequest, loading, thinking])

    return {
        flowOpen: state !== null || loading || errorMessage !== null || legacyRequest !== null,
        preview: state,
        loading,
        errorMessage,
        errorWasConnectFailure,
        legacyFallback: legacyRequest !== null,
        legacyRequest,
        stale,
        openFork,
        openRewind,
        closePreview,
        confirmPreview,
        confirmLegacy,
        retryPreview: () => {
            const request = lastFailedRequestRef.current
            if (request) void fetchPreview(request.intent, request.messageLocalId)
        }
    }
}