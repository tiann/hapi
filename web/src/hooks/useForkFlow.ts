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
}

type UseForkFlowOptions = {
    session: ForkFlowSession
    api: ApiClient
    /** Called with the child session id after a confirmed fork. */
    onForked: (childSessionId: string) => void
    /** Called after a confirmed rewind (refresh the message window). */
    onRewound?: () => void | Promise<void>
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
    const { api, onForked, onRewound } = options
    const { t } = useTranslation()
    const [state, setState] = useState<ForkFlowState | null>(null)
    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [legacyRequest, setLegacyRequest] = useState<ForkFlow['legacyRequest']>(null)
    const [stale, setStale] = useState(false)
    const requestSeq = useRef(0)
    const sessionRef = useRef(options.session)
    sessionRef.current = options.session
    const stateRef = useRef(state)
    stateRef.current = state

    const closePreview = useCallback(() => {
        requestSeq.current += 1
        setState(null)
        setLoading(false)
        setErrorMessage(null)
        setLegacyRequest(null)
        setStale(false)
    }, [])

    const fetchPreview = useCallback(async (intent: ForkPreviewIntent, messageLocalId?: string) => {
        const seq = ++requestSeq.current
        setLoading(true)
        setErrorMessage(null)
        try {
            const response = await api.forkPreview(sessionRef.current.id, intent, messageLocalId)
            if (seq !== requestSeq.current) return
            setState({ intent, messageLocalId, response, view: buildForkPreviewView(response) })
        } catch (error) {
            if (seq !== requestSeq.current) return
            if (error instanceof ApiError && error.status === 404) {
                // Older hub without the preview route: keep the requested
                // boundary for the legacy confirm dialog.
                setLegacyRequest({ intent, messageLocalId })
                setState(null)
                return
            }
            setErrorMessage(apiErrorText(error, t('dialog.error.default')))
        } finally {
            if (seq === requestSeq.current) setLoading(false)
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
            await onRewound?.()
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
                await onRewound?.()
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
            throw error
        }
    }, [api, closePreview, fetchPreview, onForked, onRewound])

    // The hub resolves the mode from the live session. Re-answer the preview
    // while the dialog is open when the source starts or stops running, so the
    // shown boundary never outlives the state it was computed from.
    const thinking = options.session.thinking
    const lastThinkingRef = useRef(thinking)
    useEffect(() => {
        const wasThinking = lastThinkingRef.current
        lastThinkingRef.current = thinking
        if (wasThinking === thinking) return
        const current = stateRef.current
        if (!current && !loading) return
        const intent = current?.intent ?? legacyRequest?.intent
        if (!intent) return
        void fetchPreview(intent, current?.messageLocalId ?? legacyRequest?.messageLocalId)
    }, [fetchPreview, legacyRequest, loading, thinking])

    return {
        flowOpen: state !== null || loading || errorMessage !== null || legacyRequest !== null,
        preview: state,
        loading,
        errorMessage,
        legacyFallback: legacyRequest !== null,
        legacyRequest,
        stale,
        openFork,
        openRewind,
        closePreview,
        confirmPreview,
        confirmLegacy
    }
}