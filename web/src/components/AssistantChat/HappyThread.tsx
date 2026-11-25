import { useSelectedSessionSeen } from '@/hooks/useSelectedSessionSeen'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive, unstable_useThreadMessageIds, useAuiState } from '@assistant-ui/react'
import type { ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HappyRuntimeExtras } from '@/lib/assistant-runtime'
import type { Session, SessionContentMatch, SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import {
    findConversationMessageAnchor,
    findConversationMessageTextRange,
    getConversationMessageAnchorId
} from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import {
    HappyChatProvider,
    type OlderHistoryLoadResult
} from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { getToolCardDisplayPresentation, useToolCardDisplayMode } from '@/hooks/useToolCardDisplayMode'
import { useTranslation } from '@/lib/use-translation'
import { CheckIcon, CloseIcon } from '@/components/icons'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getSessionTitle } from '@/lib/sessionTitle'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { getMessageWindowState, holdHistoryNavigationWindow, type HistoryNavigationWindow, type OlderLoadOutcome } from '@/lib/message-window-store'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { getSessionProjectLabel, getSessionProjectPath } from '@/lib/sessionProjectLabel'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { useTransientScrollbar } from '@/hooks/useTransientScrollbar'
import { queryKeys } from '@/lib/query-keys'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { matchesSearchQuery } from '@hapi/protocol'

type ScrollAnchor = {
    id: string
    topOffset: number
}

type PrependAnchorMetrics = {
    bottomOffset: number
    height: number
}

type PendingScrollRestore = {
    runId: number
    anchor: ScrollAnchor | null
    prependFirstCardMetrics: PrependAnchorMetrics | null
    scrollTop: number
    scrollHeight: number
    targetHistoryVersion: number | null
    preserveTail: boolean
}

type HistoryLoadSource = 'coverage' | 'user' | 'consumer'
type PullToLoadState = 'idle' | 'pulling' | 'ready'
type NavigationStatus = 'idle' | 'loading' | 'success' | 'error'
type NavigationFeedbackKind = 'conversationStart' | 'prompt'

export function shouldHoldHistoryNavigation(historyNavigationActive: boolean, atBottom: boolean): boolean {
    return historyNavigationActive && atBottom
}

export function getNavigationFeedback(
    conversationStartStatus: NavigationStatus,
    promptNavigationStatus: NavigationStatus
): { status: NavigationStatus; kind: NavigationFeedbackKind } {
    if (promptNavigationStatus !== 'idle') {
        return { status: promptNavigationStatus, kind: 'prompt' }
    }
    return { status: conversationStartStatus, kind: 'conversationStart' }
}

export function getPromptNavigationCompletionStatus(loadedOlderHistory: boolean): NavigationStatus {
    return loadedOlderHistory ? 'success' : 'idle'
}

type HistoryLoaderState = {
    runId: number
    phase: 'idle' | 'loading' | 'backoff' | 'awaiting-render'
    source: HistoryLoadSource | null
    failureCount: number
    autoPaused: boolean
}

type SearchTargetPhase = 'idle' | 'loading' | 'waiting-runtime' | 'waiting-render' | 'complete' | 'failed'

type ShareTurnState = {
    id: number
    snapshots: ShareTurnSnapshot[]
    sourceContentWidth: number | null
} | null

type ShareTurnSnapshot = {
    html: string
    text: string
    role?: 'user' | 'assistant'
}

export function isNestedScrollEvent(event: Event): boolean {
    const target = event.target
    const element = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    return element?.closest('[data-hapi-nested-scroll="true"]') != null
}

function findNearestMessageElement(content: HTMLElement, clientY?: number): HTMLElement | null {
    const messages = Array.from(content.querySelectorAll('.happy-thread-messages > [id]'))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
    if (messages.length === 0) return null
    if (typeof clientY !== 'number' || !Number.isFinite(clientY)) {
        return messages[messages.length - 1] ?? null
    }

    let best: HTMLElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        const distance = clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
                ? clientY - rect.bottom
                : 0
        if (distance < bestDistance) {
            best = message
            bestDistance = distance
        }
    }
    return best
}

export function prependMissingUserSnapshot(
    snapshots: ShareTurnSnapshot[],
    fallbackSnapshot?: ShareTurnSnapshot
): ShareTurnSnapshot[] {
    const hasUser = snapshots.some((snapshot) =>
        snapshot.role === 'user' || snapshot.html.includes('data-hapi-message-role="user"')
    )
    if (hasUser || fallbackSnapshot?.role !== 'user' || fallbackSnapshot.text.trim().length === 0) {
        return snapshots
    }
    return [fallbackSnapshot, ...snapshots]
}

const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'

function focusFirstConversationMessage(viewport: HTMLElement): void {
    const firstMessage = viewport.querySelector<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
    if (!firstMessage) return
    if (!firstMessage.hasAttribute('tabindex')) firstMessage.tabIndex = -1
    firstMessage.focus({ preventScroll: true })
}
const SEARCH_TARGET_HIGHLIGHT_CLASS = 'hapi-message-search-target'
const PENDING_REQUEST_TARGET_HIGHLIGHT_CLASS = 'hapi-message-pending-target'
const SEARCH_TARGET_MATCH_ATTRIBUTE = 'data-hapi-source-search-match'
const SEARCH_TARGET_QUERY_RETRY_DELAY_MS = 75
const MAX_SEARCH_TARGET_QUERY_RETRIES = 80
const MAX_SEARCH_TARGET_CONTEXT_RETRIES = 3
const MAX_SEARCH_TARGET_RENDER_RETRIES = 120
const SEARCH_TARGET_SCROLL_DELAYS_MS = [
    0, 16, 50, 120, 250, 500, 900, 1400, 2200, 3500, 5000, 7000,
    10_000, 15_000, 22_000, 30_000, 45_000
] as const
// Resume tail-following only once the user has actually reached the bottom.
// A wider proximity threshold makes a downward-reading user enter tail mode
// early; the next content/layout update then snaps the viewport to the end.
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1
const MANUAL_SCROLL_EPSILON_PX = 1
const INITIAL_SCROLL_SETTLE_MS = 1800
const INITIAL_SCROLL_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500, 900, 1400, 1800] as const
const HISTORY_PRELOAD_MARGIN_PX = 200
// Bounded backoff for the same logical history load. A failed page leaves the
// viewport geometry unchanged, so no new scroll/resize signal is guaranteed.
const COVERAGE_FAILURE_RETRY_DELAY_MS = 1000
const MAX_COVERAGE_LOAD_RETRIES = 3
// Show feedback early, but require a deliberate pull before release loads.
const TOP_PULL_FEEDBACK_PX = 16
const TOP_PULL_TRIGGER_PX = 64
// Silence between wheel events that marks the end of one upward gesture.
// Trackpads emit a burst per swipe; one signal is enough to restart a paused
// run after its bounded retry budget is exhausted.
const WHEEL_GESTURE_GAP_MS = 250
const POINTER_CANCEL_INTENT_WINDOW_MS = 750
const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])
const NAVIGATION_TRANSIENT_RETRY_DELAY_MS = 200
const MAX_NAVIGATION_TRANSIENT_RETRIES = 150

export function getPullToLoadState(distancePx: number): PullToLoadState {
    if (distancePx >= TOP_PULL_TRIGGER_PX) {
        return 'ready'
    }
    if (distancePx >= TOP_PULL_FEEDBACK_PX) {
        return 'pulling'
    }
    return 'idle'
}

type ScrollIntent = {
    distanceFromBottom: number
    isNearBottom: boolean
    isScrollingUp: boolean
    isScrollingDown: boolean
}

type LocateOutlineTargetOptions = {
    targetMessageId: string
    findTarget: (anchorId: string) => HTMLElement | null
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
    thresholdPx?: number
}): ScrollIntent {
    const thresholdPx = params.thresholdPx ?? AUTO_SCROLL_RESUME_THRESHOLD_PX
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isNearBottom: distanceFromBottom <= thresholdPx,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX,
        isScrollingDown: params.scrollTop > params.previousScrollTop + MANUAL_SCROLL_EPSILON_PX
    }
}

export function shouldShowScrollToBottomButton(intent: ScrollIntent): boolean {
    return !intent.isNearBottom
}

export function getScrollToBottomButtonVisibility(
    _wasVisible: boolean,
    intent: ScrollIntent
): boolean {
    return shouldShowScrollToBottomButton(intent)
}

export function shouldRenderScrollToBottomButton(
    isVisible: boolean,
    unseenCount: number
): boolean {
    return isVisible && unseenCount === 0
}

export function shouldCancelInitialScrollSettling(
    intent: ScrollIntent,
    hasExplicitUpwardIntent: boolean
): boolean {
    return hasExplicitUpwardIntent
        && intent.isScrollingUp
        && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX
}

/**
 * Recover the raw message id behind a scroll anchor so the store can protect
 * that row from trimming.
 *
 * Parsing the rendered DOM id is not enough: a streamed Pi assistant card
 * carries its *stream* id there, while the store matches canonical
 * `message.id` / `localId`. Prefer the source metadata the renderer already
 * emits, and fall back to the id only for kinds that embed a raw id.
 */
export function anchorMessageIdFromAnchor(anchor: ScrollAnchor | null): string | null {
    if (!anchor) return null

    const element = document.getElementById(anchor.id)
    if (element) {
        const own = element
            .closest('[data-hapi-source-message-id]')
            ?.getAttribute('data-hapi-source-message-id')
        if (own) return own

        for (const attribute of ['data-hapi-source-part-message-ids', 'data-hapi-source-message-ids']) {
            const ids = element.closest(`[${attribute}]`)?.getAttribute(attribute)
            const first = ids?.split(/\s+/).filter(Boolean)[0]
            if (first) return first
        }
    }

    const withoutPrefix = anchor.id.replace(/^hapi-message-/, '')
    const parts = withoutPrefix.split(':')
    return parts.length > 1 ? parts[1]! : null
}

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
            return {
                id: message.id,
                topOffset: rect.top - viewportRect.top
            }
        }
    }
    return null
}

function capturePrependFirstCardMetrics(
    viewport: HTMLElement,
    anchor: ScrollAnchor | null
): PrependAnchorMetrics | null {
    const firstMessage = viewport.querySelector<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
    if (!anchor || !firstMessage || firstMessage.id !== anchor.id) {
        return null
    }
    const viewportRect = viewport.getBoundingClientRect()
    const rect = firstMessage.getBoundingClientRect()
    return {
        bottomOffset: rect.bottom - viewportRect.top,
        height: rect.height
    }
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = document.getElementById(anchor.id)
    if (!target || !viewport.contains(target)) {
        return false
    }
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    viewport.scrollTop += targetRect.top - viewportRect.top - anchor.topOffset
    return true
}

export async function locateOutlineTargetMessage(options: LocateOutlineTargetOptions): Promise<HTMLElement | null> {
    const anchorId = getConversationMessageAnchorId(options.targetMessageId)
    let target = options.findTarget(anchorId)
    while (!target && options.hasMoreMessages()) {
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) {
            break
        }
        target = options.findTarget(anchorId)
    }
    return target
}

function createSearchMatchMarkerElement(sourceMessageId: string | null): HTMLElement {
    const marker = document.createElement('mark')
    marker.className = SEARCH_TARGET_HIGHLIGHT_CLASS
    marker.setAttribute(SEARCH_TARGET_MATCH_ATTRIBUTE, 'true')
    if (sourceMessageId) {
        marker.setAttribute('data-hapi-source-message-id', sourceMessageId)
    }
    return marker
}

function getSearchMatchTextSegments(range: Range): Array<{ node: Text; start: number; end: number }> {
    const segments: Array<{ node: Text; start: number; end: number }> = []
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer
    if (!root) return segments

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let current: Node | null
    while ((current = walker.nextNode())) {
        const node = current as Text
        if (!range.intersectsNode(node)) continue
        const start = node === range.startContainer ? range.startOffset : 0
        const end = node === range.endContainer ? range.endOffset : node.data.length
        if (end > start) segments.push({ node, start, end })
    }
    return segments
}

function createSearchMatchMarker(range: Range, sourceMessageId: string | null): HTMLElement | null {
    const marker = createSearchMatchMarkerElement(sourceMessageId)

    try {
        range.surroundContents(marker)
        return marker
    } catch {
        // Markdown can split one logical match across several text nodes,
        // such as `KV <strong>Cache</strong>`. Wrapping the entire range then
        // throws because it would partially contain the strong element. Wrap
        // each intersecting text segment instead so the matched text remains
        // visibly highlighted without disturbing the markdown structure.
        const markers: HTMLElement[] = []
        for (const segment of getSearchMatchTextSegments(range)) {
            const segmentMarker = createSearchMatchMarkerElement(sourceMessageId)
            const segmentRange = document.createRange()
            segmentRange.setStart(segment.node, segment.start)
            segmentRange.setEnd(segment.node, segment.end)
            try {
                segmentRange.surroundContents(segmentMarker)
                markers.push(segmentMarker)
            } catch {
                // Continue with other text nodes; a class-only card fallback
                // below still keeps the target visibly identifiable.
            }
        }
        if (markers.length > 0) return markers[0]!

        const fallback = range.commonAncestorContainer instanceof HTMLElement
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement
        fallback?.classList.add(SEARCH_TARGET_HIGHLIGHT_CLASS)
        return fallback
    }
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
    let current = element.parentElement
    while (current) {
        const overflowY = window.getComputedStyle(current).overflowY
        if (
            current.scrollHeight > current.clientHeight + 1
            && (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
        ) {
            return current
        }
        current = current.parentElement
    }
    return null
}

function scrollSearchTargetIntoView(target: HTMLElement, preferredViewport?: HTMLElement | null): void {
    const viewport = preferredViewport ?? findScrollableAncestor(target)
    if (!viewport) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
    }

    const targetRect = target.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const targetCenter = (targetRect.top + targetRect.bottom) / 2
    const viewportCenter = (viewportRect.top + viewportRect.bottom) / 2
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, viewport.scrollTop + targetCenter - viewportCenter)
    )
    viewport.scrollTo({ top: nextScrollTop, behavior: 'smooth' })
}

function removeSearchMatchMarker(marker: HTMLElement, target: HTMLElement): void {
    if (marker === target) {
        marker.classList.remove(SEARCH_TARGET_HIGHLIGHT_CLASS)
        return
    }

    const parent = marker.parentNode
    if (!parent) return
    while (marker.firstChild) {
        parent.insertBefore(marker.firstChild, marker)
    }
    marker.remove()
    parent.normalize()
}

export function shouldLoadOlderForViewport(params: {
    scrollHeight: number
    clientHeight: number
    viewportTop: number
    sentinelTop: number
    sentinelBottom: number
    preloadMarginPx?: number
}): boolean {
    const preloadMarginPx = params.preloadMarginPx ?? HISTORY_PRELOAD_MARGIN_PX
    if (params.scrollHeight <= params.clientHeight + 1) {
        return true
    }
    return params.sentinelBottom >= params.viewportTop - preloadMarginPx
        && params.sentinelTop <= params.viewportTop + preloadMarginPx
}

export function getHistoryCoverageRetryDelay(deadline: number, now: number): number {
    return Math.max(0, deadline - now) + 16
}

type PromptAnchorState = {
    current: boolean
    nextAnchorId: string | null
    oldestAnchorId?: string | null
    oldestSourceMessageIds?: readonly string[]
    sourceMessageIds?: readonly string[]
    blockedBySystemTurn?: boolean
    rawBoundary?: { epoch: number; rowId: string }
}

function getPromptAnchorSourceMessageIds(anchor: HTMLElement): string[] {
    return (anchor.dataset.hapiReplySourceMessageIds ?? anchor.dataset.hapiSourceMessageIds)?.split(/\s+/).filter(Boolean) ?? []
}

function findRekeyedReply(messages: HTMLElement[], sourceIds: readonly string[]): HTMLElement | undefined {
    if (sourceIds.length === 0) return
    const ids = new Set(sourceIds)
    const candidates = messages.filter(message => message.dataset.hapiMessageRole === 'assistant'
        && getPromptAnchorSourceMessageIds(message).some(id => ids.has(id)))
    return candidates.length === 1 ? candidates[0] : undefined
}

function findRekeyedSourceBoundary(messages: HTMLElement[], sourceIds: readonly string[]): HTMLElement | undefined {
    if (sourceIds.length === 0) return
    const ids = new Set(sourceIds)
    const candidates = messages.filter(message => getPromptAnchorSourceMessageIds(message).some(id => ids.has(id)))
    return candidates.length === 1 ? candidates[0] : undefined
}

function findPromptBefore(messages: HTMLElement[], end: number, state?: PromptAnchorState): HTMLElement | null {
    for (let index = end - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.dataset.hapiSystemTurn === 'true') {
            if (state) state.blockedBySystemTurn = true
            return null
        }
        if (message.dataset.hapiTurnInput === 'true') return message
    }
    return null
}

function findPromptBeforeWithOverlap(messages: HTMLElement[], end: number, state: PromptAnchorState): HTMLElement | null {
    const target = findPromptBefore(messages, end, state)
    if (!target && !state.blockedBySystemTurn) {
        // Older pages retain an overlap. Carry the oldest verified boundary
        // into it even when the selected reply and its source IDs are evicted.
        const oldest = messages[0]
        if (oldest) {
            state.oldestAnchorId = oldest.id
            const sourceIds = getPromptAnchorSourceMessageIds(oldest)
            state.oldestSourceMessageIds = sourceIds.length > 0 ? sourceIds : undefined
        }
    }
    return target
}

export async function waitForPromptScrollSettlement(
    viewport: HTMLElement,
    target: HTMLElement,
    isCancelled?: () => boolean
): Promise<boolean> {
    const deadline = Date.now() + 3_000
    let lastTargetRect: { top: number; bottom: number } | null = null
    let stableFrames = 0
    while (Date.now() < deadline) {
        await new Promise<void>(resolve => {
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => resolve())
            else window.setTimeout(resolve, 16)
        })
        if (isCancelled?.() || !target.isConnected) return false
        const viewportRect = viewport.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        // The intended destination is the prompt's start. Oversized prompts
        // may extend below the viewport without being a failed jump.
        const visible = targetRect.top >= viewportRect.top - 1 && targetRect.top < viewportRect.bottom - 1
        const stable = lastTargetRect?.top === targetRect.top && lastTargetRect.bottom === targetRect.bottom
        stableFrames = visible && stable ? stableFrames + 1 : 0
        if (stableFrames >= 2) return true
        lastTargetRect = { top: targetRect.top, bottom: targetRect.bottom }
    }
    return false
}

export function findPreviousUserMessage(
    viewport: HTMLElement,
    messageId: string,
    state?: PromptAnchorState
): HTMLElement | null {
    const messageAnchorId = getConversationMessageAnchorId(messageId)
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    const messageIndex = messages.findIndex((message) => message.id === messageAnchorId)
    return messageIndex < 0 ? null : findPromptBefore(messages, messageIndex, state)
}

export function findPromptTarget(
    viewport: HTMLElement,
    messageId: string,
    assistantAnchorState: PromptAnchorState,
    replyToMessageId?: string
): HTMLElement | null {
    if (assistantAnchorState.blockedBySystemTurn) return null
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    if (replyToMessageId) {
        const replyTargetAnchorId = getConversationMessageAnchorId(replyToMessageId)
        const replyTarget = messages.find(message => message.id === replyTargetAnchorId)
        if (replyTarget?.dataset.hapiSystemTurn === 'true') {
            assistantAnchorState.blockedBySystemTurn = true
            return null
        }
        if (replyTarget?.dataset.hapiTurnInput === 'true') return replyTarget
    }

    const assistantAnchorId = getConversationMessageAnchorId(messageId)
    const assistantAnchor = messages.find(message => message.id === assistantAnchorId)
        ?? findRekeyedReply(messages, assistantAnchorState.sourceMessageIds ?? [])
    if (assistantAnchor) {
        assistantAnchorState.current = true
        assistantAnchorState.sourceMessageIds ??= getPromptAnchorSourceMessageIds(assistantAnchor)
        assistantAnchorState.nextAnchorId ??=
            assistantAnchor.nextElementSibling instanceof HTMLElement
                ? assistantAnchor.nextElementSibling.id
                : null
    }

    if (assistantAnchor) return findPromptBeforeWithOverlap(messages, messages.indexOf(assistantAnchor), assistantAnchorState)
    if (!assistantAnchorState.current) return null
    if (assistantAnchorState.nextAnchorId) {
        const boundaryIndex = messages.findIndex((message) => message.id === assistantAnchorState.nextAnchorId)
        if (boundaryIndex >= 0) return findPromptBeforeWithOverlap(messages, boundaryIndex, assistantAnchorState)
    }
    if (assistantAnchorState.oldestAnchorId) {
        const boundary = messages.find(message => message.id === assistantAnchorState.oldestAnchorId)
            ?? findRekeyedSourceBoundary(messages, assistantAnchorState.oldestSourceMessageIds ?? [])
        const boundaryIndex = boundary ? messages.indexOf(boundary) : -1
        if (boundaryIndex >= 0) return findPromptBeforeWithOverlap(messages, boundaryIndex, assistantAnchorState)
    }
    // The transcript may grow at the tail while we load older pages. Never
    // search past the selected reply when every verified boundary is gone.
    return null
}

// In concise view an entire overlap can consist of hidden tool output. Prove
// continuity with raw rows, but keep the rendered turn markers authoritative
// for which rows are inputs, steers, batch continuations, or system wakes.
function findPromptBeforeRawOverlap(
    viewport: HTMLElement,
    state: PromptAnchorState,
    window: ReturnType<typeof getMessageWindowState>
): HTMLElement | null {
    const boundary = state.rawBoundary
    if (!boundary || boundary.epoch !== window.epoch || state.blockedBySystemTurn) return null
    const boundaryIndex = window.messages.findIndex(row => row.id === boundary.rowId)
    if (boundaryIndex <= 0) return null
    const earlierIds = new Set(window.messages.slice(0, boundaryIndex).map(row => row.id))
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)).filter(anchor =>
        (anchor.dataset.hapiTurnInput === 'true' || anchor.dataset.hapiSystemTurn === 'true')
        && getPromptAnchorSourceMessageIds(anchor).some(id => earlierIds.has(id)))
    const target = findPromptBefore(messages, messages.length, state)
    if (!target && !state.blockedBySystemTurn) {
        const oldest = window.messages.find(row => typeof row.seq === 'number')
        if (oldest) boundary.rowId = oldest.id
    }
    return target
}

export function capturePromptAnchorState(
    viewport: HTMLElement | null,
    messageId: string,
    replyToMessageId?: string
): PromptAnchorState {
    if (!viewport) return { current: false, nextAnchorId: null }
    const anchor = document.getElementById(getConversationMessageAnchorId(messageId))
    if (!(anchor instanceof HTMLElement) || !viewport.contains(anchor)) {
        return { current: false, nextAnchorId: null }
    }
    const state: PromptAnchorState = {
        current: true,
        sourceMessageIds: getPromptAnchorSourceMessageIds(anchor),
        nextAnchorId: anchor.nextElementSibling instanceof HTMLElement
            ? anchor.nextElementSibling.id
            : null
    }
    // Establish an overlap while the selected reply is still rendered; an
    // older page already in flight can evict the reply before lookup resumes.
    findPromptTarget(viewport, messageId, state, replyToMessageId)
    return state
}

async function findPreviousUserMessageAfterRender(
    findTarget: () => HTMLElement | null,
    state: PromptAnchorState
): Promise<HTMLElement | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const target = findTarget()
        if (target || state.blockedBySystemTurn) return target
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    }
    return findTarget()
}

export async function loadAllOlderMessages(options: {
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
    isCancelled?: () => boolean
}): Promise<boolean> {
    while (options.hasMoreMessages()) {
        if (options.isCancelled?.()) return false
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) return false
        if (options.isCancelled?.()) return false
    }
    return true
}

async function waitForViewportTop(
    viewport: HTMLElement,
    timeoutMs = 2500,
    isCancelled?: () => boolean
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (viewport.scrollTop > 1 && Date.now() < deadline) {
        if (isCancelled?.()) return false
        await new Promise<void>((resolve) => {
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve())
            } else {
                window.setTimeout(resolve, 16)
            }
        })
    }
    return !isCancelled?.() && viewport.scrollTop <= 1
}

export async function runAfterPendingHistoryLoad(
    pendingLoad: Promise<unknown> | null,
    action: () => boolean | Promise<boolean>,
    onStart?: () => void
): Promise<boolean> {
    onStart?.()
    if (pendingLoad) await pendingLoad
    return await action()
}

export async function loadOlderForNavigationWithRetry(
    loadOlder: () => Promise<OlderHistoryLoadResult>,
    options: {
        maxTransientRetries?: number
        retryDelayMs?: number
        wait?: (delayMs: number) => Promise<void>
        isCancelled?: () => boolean
    } = {}
): Promise<boolean> {
    const maxTransientRetries = options.maxTransientRetries ?? MAX_NAVIGATION_TRANSIENT_RETRIES
    const retryDelayMs = options.retryDelayMs ?? NAVIGATION_TRANSIENT_RETRY_DELAY_MS
    const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs)
    }))

    for (let transientRetries = 0; ; transientRetries += 1) {
        if (options.isCancelled?.()) return false
        const result = await loadOlder()
        if (options.isCancelled?.()) return false
        if (result === 'loaded') return true
        if (result === 'terminal-stop' || transientRetries >= maxTransientRetries) return false
        await wait(retryDelayMs)
    }
}

const SCROLL_TO_BOTTOM_BUTTON_CLASS = 'absolute bottom-0 right-2 z-10 h-6 w-6 rounded-full border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-0 text-[var(--app-fg)] hover:bg-[var(--app-bg)]'

function ScrollToBottomButton(props: { onClick: () => void; count?: number }) {
    const { t } = useTranslation()
    const hasCount = typeof props.count === 'number'
    const label = hasCount
        ? `${t('misc.newMessage', { n: props.count! })} — ${t('misc.scrollToBottom')}`
        : t('misc.scrollToBottom')
    const buttonClass = hasCount
        ? 'absolute bottom-0 right-2 z-10 h-6 w-6 rounded-full border-[var(--app-button)] bg-[var(--app-button)] px-0 text-[var(--app-button-text)] hover:opacity-90'
        : SCROLL_TO_BOTTOM_BUTTON_CLASS

    return (
        <Button
            variant="outline"
            type="button"
            onClick={props.onClick}
            aria-label={label}
            title={label}
            className={buttonClass}
        >
            {hasCount ? (
                <span className="translate-y-px text-[10px] font-semibold leading-none tabular-nums" aria-hidden="true">
                    {props.count! > 99 ? '99+' : props.count}
                </span>
            ) : (
                <svg
                    className="h-4 w-4 translate-y-px"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            )}
        </Button>
    )
}

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) {
        return null
    }
    return <ScrollToBottomButton count={props.count} onClick={props.onClick} />
}

export function ConversationStartStatus(props: {
    status: NavigationStatus
    kind?: NavigationFeedbackKind
    belowSearchToolbar?: boolean
}) {
    const { t } = useTranslation()
    const prompt = props.kind === 'prompt'
    const loading = props.status === 'loading'
    const success = props.status === 'success'
    const active = loading || success
    const badgeClass = `pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] shadow-lg ${props.belowSearchToolbar ? 'top-12' : 'top-3'}`

    return (
        <>
            <div data-testid="history-navigation-status" role="status" aria-live="polite" aria-atomic="true" className={active ? badgeClass : 'sr-only'}>
                {loading ? <Spinner size="sm" label={null} /> : null}
                {success ? <CheckIcon className="h-4 w-4 text-green-500" /> : null}
                {loading ? <span>{t(prompt ? 'message.loadingPrompt' : 'message.loadingConversationStart')}</span> : null}
                {success ? <span>{t(prompt ? 'message.reachedPrompt' : 'message.reachedConversationStart')}</span> : null}
            </div>
            {props.status === 'error' ? (
                <div role="alert" className={badgeClass}>
                    <span className="text-red-500" aria-hidden="true">!</span>
                    <span>{t(prompt ? 'message.loadPromptFailed' : 'message.loadConversationStartFailed')}</span>
                </div>
            ) : null}
        </>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']

/**
 * Render messages by stable id instead of their current array index.
 *
 * Rewind can replace a non-empty transcript with an empty one in a single
 * external-runtime update. Index-based providers may then ask assistant-ui
 * for message 0 while its lookup table is already empty. Stable id providers
 * unmount removed rows without consulting a stale index.
 */
export function ThreadMessagesById({ components }: { components: ThreadMessageComponents }) {
    const messageIds = unstable_useThreadMessageIds()

    return (
        <>
            {messageIds.map((messageId) => (
                <ThreadPrimitive.Unstable_MessageById
                    key={messageId}
                    messageId={messageId}
                    components={components}
                />
            ))}
        </>
    )
}

export function ConversationOutlinePanel(props: {
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
}) {
    const { t, locale } = useTranslation()
    const [searchQuery, setSearchQuery] = useState('')
    const normalizedSearchQuery = searchQuery.trim()
    const filteredItems = useMemo(() => {
        if (normalizedSearchQuery.length === 0) {
            return props.items
        }
        return props.items.filter((item) => (
            matchesSearchQuery(item.label, normalizedSearchQuery)
        ))
    }, [normalizedSearchQuery, props.items])

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            aria-label={t('session.outline.title')}
        >
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -left-px w-px bg-[var(--app-border)]" />
            <div className="border-b border-[var(--app-border)] p-3">
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
                            aria-hidden="true"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('session.outline.searchPlaceholder')}
                            aria-label={t('session.outline.searchLabel')}
                            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-3 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                    </div>
                    {props.hasMoreMessages ? (
                        <Button
                            variant="outline"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                            aria-busy={props.isLoadingMoreMessages}
                            aria-label={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            title={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            className="h-9 w-9 shrink-0 px-0"
                        >
                            {props.isLoadingMoreMessages ? (
                                <Spinner size="sm" label={null} className="text-current" />
                            ) : (
                                <span className="text-base leading-none" aria-hidden="true">↑</span>
                            )}
                        </Button>
                    ) : null}
                    <Button
                        variant="outline"
                        type="button"
                        onClick={props.onClose}
                        aria-label={t('button.close')}
                        title={t('button.close')}
                        className="h-9 w-9 shrink-0 px-0"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </Button>
                </div>
                {normalizedSearchQuery.length > 0 ? (
                    <div className="mt-1.5 text-right text-xs text-[var(--app-hint)]" aria-live="polite">
                        {t('session.outline.searchResults', {
                            matched: filteredItems.length,
                            total: props.items.length
                        })}
                    </div>
                ) : null}
            </div>

            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : filteredItems.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.noSearchResults')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {filteredItems.map((item) => {
                            const createdAt = new Date(item.createdAt)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group block w-full min-w-0 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                        <time
                                            dateTime={createdAt.toISOString()}
                                            title={formatMessageTimestampTitle(createdAt)}
                                            className="truncate"
                                        >
                                            {formatOutlineTimestamp(createdAt, locale)}
                                        </time>
                                    </span>
                                    <span className="mt-0.5 line-clamp-2 pl-4 text-sm leading-snug text-[var(--app-fg)]">
                                        {item.label}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    session: Session
    serviceTier?: string | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    allowInactiveFork?: boolean
    onRefresh: () => void
    onContinuePlan?: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onBranchConversation?: (messageLocalId?: string, messageId?: string) => void
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    assistantForkPoints?: ReadonlyMap<string, string>
    onViewModeChange: (mode: 'tail' | 'history') => void
    onJumpToTail?: () => void
    readThroughRevision?: number
    isSyncingTail: boolean
    /** Cached re-entry: rendering the persisted window while the authoritative latest-page fetch is in flight. */
    isCatchingUpFromCache?: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    /** A context window still has messages between it and the session head. */
    hasMoreNewerMessages?: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    /** Walk a context window one page forward; resolves true once caught up. */
    onLoadNewer?: (resolvePreserveMessageId?: () => string | null) => Promise<boolean>
    onCancelLoadMore: () => void
    unseenCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    historyVersion: number
    forceScrollToken: number
    outlineOpen: boolean
    outlineItems: readonly ConversationOutlineItem[]
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    initialTargetMessageId?: string
    initialTargetMessageQuery?: string
    targetHighlightKind?: 'search' | 'pending-request'
    searchRequestId?: number
    onLoadMessageContext?: (messageId: string) => Promise<boolean>
    onInitialTargetConsumed?: () => void
    onSearchTargetDismissed?: () => void
}) {
    const { t, locale } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const { machines } = useMachines(props.api, true)
    const machineLabelsById = useMachineLabels(machines)
    const [shareTurn, setShareTurn] = useState<ShareTurnState>(null)
    const shareDialogOpen = shareTurn !== null
    const getGeneratedMediaBlob = useCallback(
        (imageId: string) => props.api.getGeneratedImageBlob(props.sessionId, imageId),
        [props.api, props.sessionId]
    )
    const shareTitle = shareTurn ? getSessionTitle(props.session) : ''
    const shareRelativeTimeTick = useMinuteTick(headerMetadata.lastActive && shareDialogOpen)
    const shareMetadataItems = useMemo(() => {
        const agentFlavor = props.session.metadata?.flavor ?? null
        const agentLabel = agentFlavor?.trim() || null
        const machineLabel = resolveSessionHeaderMachineLabel(props.session, machineLabelsById)
        const projectPath = getSessionProjectPath(props.session.metadata)
        const projectLabel = projectPath ? getSessionProjectLabel(projectPath) : null
        const modelLabel = getSessionModelLabel(props.session)
        const reasoningLabel = getShareTurnReasoningLabel(
            agentFlavor,
            props.session.modelReasoningEffort,
            props.session.effort,
            headerMetadata.showLabels
        )
        const lastActiveAt = props.session.activeAt || props.session.updatedAt || props.session.createdAt
        const lastActiveLabel = lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null
        const createdAtLabel = formatSessionHeaderTimestamp(props.session.createdAt, locale)
        const updatedAtLabel = formatSessionHeaderTimestamp(props.session.updatedAt, locale)
        const worktreeBranch = props.session.metadata?.worktree?.branch?.trim() || null
        const showFastBadge = agentFlavor === 'codex'
            && isFastServiceTier(props.serviceTier ?? props.session.serviceTier)

        return selectShareTurnMetadata(headerMetadata, {
            agent: agentLabel ? { text: agentLabel, flavor: agentFlavor } : undefined,
            project: projectLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.project')}: ` : ''}${projectLabel}`,
            } : undefined,
            machine: machineLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}${machineLabel}`,
            } : undefined,
            lastActive: lastActiveLabel ? { text: lastActiveLabel } : undefined,
            model: modelLabel ? {
                text: `${headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}${modelLabel.value}`,
            } : undefined,
            reasoning: reasoningLabel ? { text: reasoningLabel } : undefined,
            fastMode: showFastBadge ? { text: 'fast' } : undefined,
            createdAt: createdAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}${createdAtLabel}`,
            } : undefined,
            updatedAt: updatedAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updatedAtLabel}`,
            } : undefined,
            worktree: worktreeBranch ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}${worktreeBranch}`,
            } : undefined,
        })
    }, [headerMetadata, locale, machineLabelsById, props.serviceTier, props.session, shareDialogOpen, shareRelativeTimeTick, t])
    const { toolCardDisplayMode } = useToolCardDisplayMode()
    const { terminalToolDisplayMode } = getToolCardDisplayPresentation(toolCardDisplayMode)
    const hubSettingsQuery = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => props.api.getHubSettings(),
        enabled: Boolean(props.api),
        staleTime: 30_000,
        refetchInterval: 30_000,
        retry: false,
    })
    const showSessionSummaryInChat = hubSettingsQuery.data?.sessionSummaryInChat === true
    const targetSearchQuery = props.initialTargetMessageQuery?.trim() ?? ''
    const initialSearchTargetId = props.initialTargetMessageId?.trim() ?? ''
    const hasSearchTarget = Boolean(initialSearchTargetId && targetSearchQuery)
    const [activeSearchMatchId, setActiveSearchMatchId] = useState<string | null>(null)
    const activeSearchMatchRequestIdRef = useRef<number | undefined>(undefined)
    const sessionContentMatchesQuery = useQuery({
        queryKey: queryKeys.sessionContentSearch(props.sessionId, targetSearchQuery),
        queryFn: ({ signal }) => props.api.searchSessionContentMatches(
            props.sessionId,
            targetSearchQuery,
            500,
            signal
        ),
        enabled: hasSearchTarget,
        staleTime: 30_000,
        retry: false
    })
    const searchMatches: SessionContentMatch[] = sessionContentMatchesQuery.data?.matches ?? []
    const activeSearchTargetId = activeSearchMatchRequestIdRef.current === props.searchRequestId
        ? activeSearchMatchId ?? initialSearchTargetId
        : initialSearchTargetId
    const activeSearchMatchIndex = searchMatches.findIndex((match) => match.messageId === activeSearchTargetId)
    const searchMatchTotal = sessionContentMatchesQuery.data?.total ?? searchMatches.length
    const searchMatchTotalLabel = sessionContentMatchesQuery.isLoading
        ? '…'
        : searchMatchTotal > searchMatches.length
            ? `${searchMatches.length}+`
            : String(searchMatchTotal)
    const searchMatchCurrentLabel = activeSearchMatchIndex >= 0
        ? String(activeSearchMatchIndex + 1)
        : sessionContentMatchesQuery.isLoading
            ? '…'
            : '—'
    const runtimeExtras = useAuiState((s) => s.thread.extras) as HappyRuntimeExtras | undefined
    const appliedMessagesVersion = runtimeExtras?.messagesVersion ?? props.messagesVersion
    const appliedHistoryVersion = runtimeExtras?.historyVersion ?? props.historyVersion
    const viewportRef = useRef<HTMLDivElement | null>(null)
    useTransientScrollbar(viewportRef, 'right')
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [pullToLoadState, setPullToLoadState] = useState<PullToLoadState>('idle')
    const [searchTargetRetryVersion, setSearchTargetRetryVersion] = useState(0)
    const [isLocatingSearchTarget, setIsLocatingSearchTarget] = useState(false)
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)
    const pullToLoadStateRef = useRef<PullToLoadState>('idle')
    const shareTurnIdRef = useRef(0)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isSyncingTailRef = useRef(props.isSyncingTail)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onCancelLoadMoreRef = useRef(props.onCancelLoadMore)
    const pendingLoadPromiseRef = useRef<Promise<OlderHistoryLoadResult> | null>(null)
    const pendingLoadResolveRef = useRef<((value: OlderHistoryLoadResult) => void) | null>(null)
    const coverageCheckTimerRef = useRef<number | null>(null)
    const failureRetryTimerRef = useRef<number | null>(null)
    const tailScrollInProgressRef = useRef(false)
    const historyLoaderRef = useRef<HistoryLoaderState>({
        runId: 0,
        phase: 'idle',
        source: null,
        failureCount: 0,
        autoPaused: false
    })

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const updateScrollbarGutter = () => {
            const supportsStableBothEdges = typeof CSS !== 'undefined'
                && typeof CSS.supports === 'function'
                && CSS.supports('scrollbar-gutter: stable both-edges')
            const gutter = supportsStableBothEdges
                ? Math.max(0, (viewport.offsetWidth - viewport.clientWidth) / 2)
                : 0
            viewport.style.setProperty('--chat-scroll-gutter-inline', `${gutter}px`)
        }

        updateScrollbarGutter()
        if (typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(updateScrollbarGutter)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [])
    const requestOlderRef = useRef<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>(
        () => Promise.resolve('transient-stop')
    )
    const startHistoryLoadAttemptRef = useRef<(runId: number) => void>(() => {})
    const needsViewportCoverageRef = useRef<(options?: { includePreloadMargin?: boolean }) => boolean>(() => false)
    useSelectedSessionSeen(props.sessionId,
        !props.isSyncingTail && !props.messagesWarning ? props.readThroughRevision : undefined,
        props.session.readState?.version, viewportRef, contentRef)
    const atBottomRef = useRef(true)
    const onViewModeChangeRef = useRef(props.onViewModeChange)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const userCancelledInitialTailRef = useRef(false)
    const initialTargetMessageIdRef = useRef(Boolean(props.initialTargetMessageId?.trim()))
    initialTargetMessageIdRef.current = Boolean(props.initialTargetMessageId?.trim())
    const rawMessagesCountRef = useRef(props.rawMessagesCount)
    rawMessagesCountRef.current = props.rawMessagesCount
    const messagesVersionRef = useRef(props.messagesVersion)
    messagesVersionRef.current = props.messagesVersion
    const appliedMessagesVersionRef = useRef(appliedMessagesVersion)
    appliedMessagesVersionRef.current = appliedMessagesVersion
    const initialScrollSessionRef = useRef<string | null>(null)
    const initialScrollDeadlineRef = useRef(0)
    const initialScrollTimersRef = useRef<number[]>([])
    const searchTargetJumpRef = useRef<{
        messageId: string
        messageQuery?: string
        requestId?: number
        phase: SearchTargetPhase
    } | null>(null)
    // Keep automatic initial/tail reconciliation from reclaiming the viewport
    // after a historical search result has been applied. The lock is released
    // by an explicit jump to the latest messages or by a new session/target.
    const searchTargetHistoryLockRef = useRef(false)
    const hasMoreNewerRef = useRef(props.hasMoreNewerMessages === true)
    // A forward page can trim 200 rows off the old end of the window. Message
    // CSS disables browser scroll anchoring, so without restoring an anchor
    // the unchanged scrollTop lands ~200 messages later.
    const pendingForwardAnchorRef = useRef<ScrollAnchor | null>(null)
    const requestForwardPageRef = useRef<() => void>(() => {})
    const onLoadNewerRef = useRef(props.onLoadNewer)
    const loadingNewerRef = useRef(false)
    const searchTargetInputKeyRef = useRef<string | null>(null)
    const searchTargetValidatedRequestKeyRef = useRef<string | null>(null)
    const searchTargetRetryTimerRef = useRef<number | null>(null)
    const searchTargetQueryRetryCountRef = useRef(0)
    const searchTargetContextRetryCountRef = useRef(0)
    const searchTargetRenderRetryCountRef = useRef(0)
    const searchTargetScrollTimersRef = useRef<number[]>([])
    const searchTargetScrollCleanupTimerRef = useRef<number | null>(null)
    const preserveSearchTargetScrollOnReleaseRef = useRef(false)
    const pendingRequestTargetCleanupTimerRef = useRef<number | null>(null)

    // Smart scroll state: enabled only while the user is intentionally at the bottom.
    const autoScrollEnabledRef = useRef(true)
    // Explicit history navigation owns the viewport while it loads and settles
    // the final jump. Programmatic anchor restoration can otherwise look like
    // a bottom arrival and switch the bounded history window back to tail mode,
    // which immediately requests and renders the latest page.
    const historyNavigationRef = useRef(false)
    const navigationRunRef = useRef(0)
    const historyNavigationWindowRef = useRef<HistoryNavigationWindow | null>(null)
    const navigationInFlightRef = useRef(false)
    const [isNavigationInFlight, setIsNavigationInFlight] = useState(false)
    const promptNavigationTimerRef = useRef<number | null>(null)
    const [promptNavigationStatus, setPromptNavigationStatus] = useState<NavigationStatus>('idle')
    const [loadingPromptMessageId, setLoadingPromptMessageId] = useState<string | null>(null)
    const [conversationStartStatus, setConversationStartStatus] = useState<NavigationStatus>('idle')
    const conversationStartStatusTimerRef = useRef<number | null>(null)
    const isLoadingConversationStart = conversationStartStatus === 'loading'
    // Keep pagination refs current during render. Explicit navigation can
    // continue in a microtask immediately after a layout effect settles a
    // page load, before passive effects would otherwise update these refs.
    hasMoreMessagesRef.current = props.hasMoreMessages
    isLoadingMoreRef.current = props.isLoadingMoreMessages
    onLoadMoreRef.current = props.onLoadMore

    useLayoutEffect(() => {
        if (!props.initialTargetMessageId) return
        // A target jump owns the viewport immediately. A passive effect is too
        // late: ResizeObserver can fire after the smooth scroll starts and pin
        // the viewport back to the tail before the target effect disables it.
        searchTargetHistoryLockRef.current = true
        autoScrollEnabledRef.current = false
        atBottomRef.current = false
        tailScrollInProgressRef.current = false
    }, [props.initialTargetMessageId, props.searchRequestId, props.targetHighlightKind])
    useEffect(() => {
        onViewModeChangeRef.current = props.onViewModeChange
    }, [props.onViewModeChange])
    useEffect(() => () => {
        if (pendingRequestTargetCleanupTimerRef.current !== null) {
            window.clearTimeout(pendingRequestTargetCleanupTimerRef.current)
        }
    }, [])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useLayoutEffect(() => {
        isSyncingTailRef.current = props.isSyncingTail
    }, [props.isSyncingTail])
    useLayoutEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

    useEffect(() => {
        hasMoreNewerRef.current = props.hasMoreNewerMessages === true
    }, [props.hasMoreNewerMessages])

    useEffect(() => {
        onLoadNewerRef.current = props.onLoadNewer
    }, [props.onLoadNewer])

    useEffect(() => {
        requestForwardPageRef.current = () => {
            if (!hasMoreNewerRef.current || loadingNewerRef.current) return
            const load = onLoadNewerRef.current
            if (!load) return
            loadingNewerRef.current = true
            const viewport = viewportRef.current
            pendingForwardAnchorRef.current = viewport ? captureScrollAnchor(viewport) : null
            // Resolved when the page is applied, so a reader who scrolled
            // during the request keeps the row they are on rather than the
            // one they started from.
            void load(() => anchorMessageIdFromAnchor(pendingForwardAnchorRef.current))
                .finally(() => { loadingNewerRef.current = false })
        }
    }, [])

    // A coalesced context (streamed cards, collapsed tool groups) can render
    // shorter than the viewport. Then scrollTop never moves, no scroll event
    // fires, and the reader is stranded with no way to ask for the next page.
    //
    // Keyed on the *applied* runtime version as well: replacing an overflowing
    // window with a short context would otherwise measure the previous DOM,
    // return, and never run again because nothing else changes. A resize
    // observer covers late layout shifts for the same reason.
    useEffect(() => {
        if (props.hasMoreNewerMessages !== true) return
        const viewport = viewportRef.current
        if (!viewport) return

        let frame = 0
        const check = () => {
            if (props.hasMoreNewerMessages !== true) return
            if (viewport.scrollHeight - viewport.clientHeight > 2) return
            requestForwardPageRef.current()
        }
        const schedule = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(check)
        }

        schedule()
        const observer = new ResizeObserver(schedule)
        observer.observe(viewport)
        const content = viewport.firstElementChild
        if (content) observer.observe(content)

        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
        }
    }, [
        props.hasMoreNewerMessages,
        props.historyVersion,
        props.messagesVersion,
        appliedHistoryVersion
    ])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onCancelLoadMoreRef.current = props.onCancelLoadMore
    }, [props.onCancelLoadMore])

    useLayoutEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    useLayoutEffect(() => {
        const inputKey = hasSearchTarget
            ? `${props.sessionId}\u0000${initialSearchTargetId}\u0000${targetSearchQuery}\u0000${props.searchRequestId ?? 0}`
            : null
        if (searchTargetInputKeyRef.current === inputKey) return
        searchTargetInputKeyRef.current = inputKey
        activeSearchMatchRequestIdRef.current = props.searchRequestId
        setActiveSearchMatchId(initialSearchTargetId || null)
    }, [hasSearchTarget, initialSearchTargetId, props.searchRequestId, props.sessionId, targetSearchQuery])

    const navigateSearchMatch = useCallback((direction: -1 | 1) => {
        if (searchMatches.length === 0) return
        const currentIndex = activeSearchMatchIndex >= 0 ? activeSearchMatchIndex : 0
        const nextIndex = (currentIndex + direction + searchMatches.length) % searchMatches.length
        const nextMatch = searchMatches[nextIndex]
        if (nextMatch) {
            activeSearchMatchRequestIdRef.current = props.searchRequestId
            // A single result still represents a useful navigation action:
            // clicking either arrow should re-center the current match after
            // the user has scrolled away. Reset the completed jump so the
            // normal locating path runs again even though the message id is
            // unchanged.
            if (searchMatches.length === 1 && nextMatch.messageId === activeSearchTargetId) {
                searchTargetJumpRef.current = null
                setSearchTargetRetryVersion((version) => version + 1)
            }
            setActiveSearchMatchId(nextMatch.messageId)
        }
    }, [activeSearchMatchIndex, activeSearchTargetId, props.searchRequestId, searchMatches])

    const isInitialScrollSettling = useCallback(() => {
        return initialScrollSessionRef.current === sessionIdRef.current && Date.now() < initialScrollDeadlineRef.current
    }, [])

    const hasBlockingScrollRestore = useCallback((): boolean => {
        const pending = pendingScrollRef.current
        if (!pending) {
            return false
        }
        return !pending.preserveTail || historyLoaderRef.current.phase === 'awaiting-render'
    }, [])

    const isAwaitingInitialTailCommit = useCallback((): boolean => {
        return initialScrollSessionRef.current !== sessionIdRef.current
            && !userCancelledInitialTailRef.current
            && !searchTargetHistoryLockRef.current
            && !initialTargetMessageIdRef.current
    }, [])

    const canBypassInitialSettlingForUncoveredTail = useCallback((): boolean => {
        const viewport = viewportRef.current
        if (!viewport || viewport.clientHeight <= 0) {
            return false
        }
        return !isSyncingTailRef.current
            && rawMessagesCountRef.current > 0
            && appliedMessagesVersionRef.current === messagesVersionRef.current
            && initialScrollSessionRef.current === sessionIdRef.current
            && autoScrollEnabledRef.current
            && atBottomRef.current
            && !searchTargetHistoryLockRef.current
            && viewport.scrollHeight <= viewport.clientHeight + 1
    }, [])

    const isReadyForAutomaticCoverage = useCallback((): boolean => {
        return !navigationInFlightRef.current
            && !isSyncingTailRef.current
            && !isLoadingMoreRef.current
            && appliedMessagesVersionRef.current === messagesVersionRef.current
            && !(rawMessagesCountRef.current > 0 && isAwaitingInitialTailCommit())
    }, [isAwaitingInitialTailCommit])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        initialScrollTimersRef.current = []
    }, [])
    const clearSearchTargetScrollTimers = useCallback(() => {
        for (const timer of searchTargetScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        searchTargetScrollTimersRef.current = []
    }, [])
    const clearSearchTargetRetryTimer = useCallback(() => {
        if (searchTargetRetryTimerRef.current === null) return
        window.clearTimeout(searchTargetRetryTimerRef.current)
        searchTargetRetryTimerRef.current = null
    }, [])
    const scheduleSearchTargetRetry = useCallback((delay: number) => {
        if (searchTargetRetryTimerRef.current !== null) return
        searchTargetRetryTimerRef.current = window.setTimeout(() => {
            searchTargetRetryTimerRef.current = null
            setSearchTargetRetryVersion((version) => version + 1)
        }, delay)
    }, [])
    const clearSearchTargetMarker = useCallback(() => {
        const markers = Array.from(document.querySelectorAll<HTMLElement>(
            `[${SEARCH_TARGET_MATCH_ATTRIBUTE}="true"]`
        ))
        for (const marker of markers) {
            const parent = marker.parentElement
            if (parent) {
                removeSearchMatchMarker(marker, parent)
            }
        }
        // A message without a text-range match uses a class-only card
        // highlight. It has no marker attribute, so clean it up separately.
        for (const fallback of Array.from(document.querySelectorAll<HTMLElement>(
            `.${SEARCH_TARGET_HIGHLIGHT_CLASS}`
        ))) {
            fallback.classList.remove(SEARCH_TARGET_HIGHLIGHT_CLASS)
        }
    }, [])
    const releaseSearchTargetHistoryLock = useCallback((options?: { preserveScrollTimers?: boolean }) => {
        clearSearchTargetRetryTimer()
        clearSearchTargetMarker()
        if (options?.preserveScrollTimers) {
            // Native smooth scrolling is cancelled when loading the target context
            // reflows the virtual message window. Keep both the viewport lock and
            // correction schedule briefly so late layout cannot reclaim the viewport.
            searchTargetHistoryLockRef.current = true
            if (searchTargetScrollCleanupTimerRef.current !== null) return
            searchTargetScrollCleanupTimerRef.current = window.setTimeout(() => {
                searchTargetHistoryLockRef.current = false
                clearSearchTargetScrollTimers()
                searchTargetScrollCleanupTimerRef.current = null
            }, 1_600)
            return
        }
        searchTargetHistoryLockRef.current = false
        if (searchTargetScrollCleanupTimerRef.current !== null) {
            window.clearTimeout(searchTargetScrollCleanupTimerRef.current)
            searchTargetScrollCleanupTimerRef.current = null
        }
        clearSearchTargetScrollTimers()
    }, [clearSearchTargetMarker, clearSearchTargetRetryTimer, clearSearchTargetScrollTimers])
    const dismissSearchTarget = useCallback(() => {
        releaseSearchTargetHistoryLock()
        setActiveSearchMatchId(null)
        setIsLocatingSearchTarget(false)
        props.onSearchTargetDismissed?.()
    }, [props.onSearchTargetDismissed, releaseSearchTargetHistoryLock])
    const scheduleSearchTargetScroll = useCallback((
        targetMessageId: string,
        query: string | undefined,
        fallbackTarget: HTMLElement
    ) => {
        clearSearchTargetScrollTimers()
        searchTargetScrollTimersRef.current = SEARCH_TARGET_SCROLL_DELAYS_MS.map((delay) => window.setTimeout(() => {
            const targetAnchor = findConversationMessageAnchor(targetMessageId, query) ?? fallbackTarget
            let target = targetAnchor
            if (query) {
                const existingMarker = document.querySelector<HTMLElement>(
                    `[${SEARCH_TARGET_MATCH_ATTRIBUTE}="true"]`
                )
                const markerBelongsToTarget = existingMarker
                    && targetAnchor.contains(existingMarker)
                if (markerBelongsToTarget) {
                    target = existingMarker
                } else {
                    const range = findConversationMessageTextRange(targetAnchor, query)
                    if (range) {
                        target = createSearchMatchMarker(
                            range,
                            targetMessageId
                        ) ?? targetAnchor
                    }
                }
            }
            if (target.isConnected) {
                scrollSearchTargetIntoView(target, viewportRef.current)
            }
        }, delay))
    }, [clearSearchTargetScrollTimers])

    const clearCoverageCheckTimer = useCallback(() => {
        if (coverageCheckTimerRef.current !== null) {
            window.clearTimeout(coverageCheckTimerRef.current)
            coverageCheckTimerRef.current = null
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        if (failureRetryTimerRef.current !== null) {
            window.clearTimeout(failureRetryTimerRef.current)
            failureRetryTimerRef.current = null
        }
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        const resolve = pendingLoadResolveRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        resolve?.(result)
    }, [])

    const cancelActiveHistoryLoad = useCallback((includeConsumer = false) => {
        const state = historyLoaderRef.current
        const hasPendingLoad = pendingLoadPromiseRef.current !== null
        const isActivePhase = state.phase === 'loading'
            || state.phase === 'backoff'
            || state.phase === 'awaiting-render'
        // `awaiting-render` is pre-armed by onBeforeApply and published with an
        // immediate store notification. Invalidate its pending restore when a
        // newer navigation takes over, but only cancel an underlying request
        // while it is still loading or backing off.
        if (
            (state.source === 'consumer' && !includeConsumer)
            || (state.phase === 'awaiting-render' && !includeConsumer)
            || !hasPendingLoad
            || !isActivePhase
        ) {
            return
        }
        if (state.phase === 'loading' || state.phase === 'backoff') {
            onCancelLoadMoreRef.current()
        }
        isLoadingMoreRef.current = false
        pendingScrollRef.current = null
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = {
            ...state,
            runId: state.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: true
        }
        settlePendingLoad('transient-stop')
    }, [clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    const cancelHistoryNavigation = useCallback(() => {
        navigationRunRef.current += 1
        historyNavigationWindowRef.current?.finish(false)
        historyNavigationWindowRef.current = null
        historyNavigationRef.current = false
        navigationInFlightRef.current = false
        setIsNavigationInFlight(false)
        cancelActiveHistoryLoad(true)

        if (conversationStartStatusTimerRef.current !== null) {
            window.clearTimeout(conversationStartStatusTimerRef.current)
            conversationStartStatusTimerRef.current = null
        }
        if (promptNavigationTimerRef.current !== null) {
            window.clearTimeout(promptNavigationTimerRef.current)
            promptNavigationTimerRef.current = null
        }
        setConversationStartStatus('idle')
        setPromptNavigationStatus('idle')
        setLoadingPromptMessageId(null)
    }, [cancelActiveHistoryLoad])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        lastScrollTopRef.current = viewport.scrollTop

        const setAutoScrollMode = (enabled: boolean) => {
            if (autoScrollEnabledRef.current === enabled) {
                return
            }
            autoScrollEnabledRef.current = enabled
        }

        const setAtBottomMode = (atBottom: boolean) => {
            if (shouldHoldHistoryNavigation(historyNavigationRef.current, atBottom)) {
                atBottomRef.current = false
                autoScrollEnabledRef.current = false
                return
            }
            if (atBottom === atBottomRef.current) {
                return
            }
            if (atBottom && searchTargetHistoryLockRef.current) {
                // A clamped/programmatic scroll can look like the bottom was
                // reached while the historical search window is being mounted.
                // Do not let that transient event re-enter tail mode.
                atBottomRef.current = false
                // The window stops short of the head, so this bottom is the
                // end of the loaded context rather than the end of the
                // conversation. Pull the next page forward instead of
                // stranding the reader (tiann/hapi#1598 review).
                requestForwardPageRef.current()
                return
            }
            atBottomRef.current = atBottom
            onViewModeChangeRef.current(atBottom ? 'tail' : 'history')
        }

        let pointerResumeActive = false
        let pointerResumeUntil = 0
        let pointerResumeLatched = false
        let keyboardResumeActive = false
        let lastWheelAt = 0
        let wheelIntentUntil = 0
        let wheelLatched = false

        const cancelSearchRecentering = () => {
            for (const timer of searchTargetScrollTimersRef.current) {
                window.clearTimeout(timer)
            }
            searchTargetScrollTimersRef.current = []
        }

        const hasExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            return intent.isScrollingUp && (
                pointerResumeActive
                || pointerResumeUntil >= Date.now()
                || keyboardResumeActive
                || wheelIntentUntil >= Date.now()
            )
        }

        const consumeExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            if (!hasExplicitUpwardIntent(intent)) {
                return false
            }
            if ((pointerResumeActive || pointerResumeUntil >= Date.now()) && !pointerResumeLatched) {
                pointerResumeLatched = true
                return true
            }
            if (keyboardResumeActive) {
                keyboardResumeActive = false
                return true
            }
            if (wheelIntentUntil >= Date.now() && !wheelLatched) {
                wheelLatched = true
                return true
            }
            return false
        }

        const handleScroll = () => {
            if (viewport.scrollTop > lastScrollTopRef.current) {
                keyboardResumeActive = false
            }
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: lastScrollTopRef.current
            })
            lastScrollTopRef.current = viewport.scrollTop

            // A slow older-page request must not restore the position from
            // when it started after the user has already scrolled elsewhere.
            // Keep the pending baseline aligned with the latest visible row;
            // the eventual prepend will preserve that row instead.
            const pending = pendingScrollRef.current
            if (pending && historyLoaderRef.current.runId === pending.runId) {
                const anchor = captureScrollAnchor(viewport)
                pending.anchor = anchor
                pending.prependFirstCardMetrics = capturePrependFirstCardMetrics(viewport, anchor)
                pending.scrollTop = viewport.scrollTop
                pending.scrollHeight = viewport.scrollHeight
            }

            // Same hazard for a pending forward page: restoring the anchor
            // captured when the request started would drag the user back to
            // where they were before they scrolled away.
            if (pendingForwardAnchorRef.current) {
                pendingForwardAnchorRef.current = captureScrollAnchor(viewport)
            }

            const needsCoverage = needsViewportCoverageRef.current()
            if (!needsCoverage) {
                // Older pages retain the oldest side of the bounded window.
                // Once the user reverses toward newer history, applying this
                // request could evict their new anchor. Invalidate it instead;
                // a later fresh approach can request the page again.
                cancelActiveHistoryLoad()
            }
            // Keep the keyboard/pointer intent armed while the user moves
            // through ordinary history. Consume it only when the viewport
            // actually reaches the preload area.
            const hadExplicitUpwardIntent = hasExplicitUpwardIntent(intent)
            const explicitUpwardIntent = needsCoverage && consumeExplicitUpwardIntent(intent)

            if (isInitialScrollSettling() || isAwaitingInitialTailCommit()) {
                if (shouldCancelInitialScrollSettling(intent, hadExplicitUpwardIntent)) {
                    userCancelledInitialTailRef.current = true
                    if (pending && historyLoaderRef.current.runId === pending.runId) {
                        pending.preserveTail = false
                    }
                    setShowScrollToBottom(shouldShowScrollToBottomButton(intent))
                    initialScrollDeadlineRef.current = 0
                    clearInitialScrollTimers()
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                    if (explicitUpwardIntent) {
                        void requestOlderRef.current('user')
                    }
                } else {
                    setShowScrollToBottom(false)
                    if (
                        autoScrollEnabledRef.current
                        && !searchTargetHistoryLockRef.current
                        && !hasBlockingScrollRestore()
                        && !intent.isNearBottom
                    ) {
                        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                        lastScrollTopRef.current = viewport.scrollTop
                    }
                }
                return
            }

            // Scroll position is the source of truth. The loader controller
            // decides whether this demand may start a request; programmatic
            // scroll events cannot bypass backoff or a paused coverage run.
            if (needsCoverage) {
                // A search jump owns the viewport while its historical window
                // is being displayed. Keep automatic resize/scroll events from
                // changing that window, but preserve an explicit user gesture.
                if (explicitUpwardIntent || !searchTargetHistoryLockRef.current) {
                    void requestOlderRef.current(explicitUpwardIntent ? 'user' : 'coverage')
                }
            }

            // Content growth and viewport resizes (mobile keyboard) move the
            // tail without any user gesture. While tail-follow is active, treat
            // a non-upward scroll as layout churn and re-pin to the newest
            // message instead of silently dropping out of tail mode.
            if (
                autoScrollEnabledRef.current
                && !searchTargetHistoryLockRef.current
                && !intent.isScrollingUp
                && !tailScrollInProgressRef.current
                && !hasBlockingScrollRestore()
            ) {
                setShowScrollToBottom(false)
                setAutoScrollMode(true)
                setAtBottomMode(true)
                if (!intent.isNearBottom) {
                    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                    lastScrollTopRef.current = viewport.scrollTop
                }
                return
            }

            if (intent.isScrollingUp && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX) {
                if (pending && historyLoaderRef.current.runId === pending.runId) {
                    pending.preserveTail = false
                }
                tailScrollInProgressRef.current = false
                setShowScrollToBottom(shouldShowScrollToBottomButton(intent))
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return
            }

            if (intent.isNearBottom) {
                tailScrollInProgressRef.current = false
                setShowScrollToBottom(false)
                setAutoScrollMode(true)
                setAtBottomMode(true)
                return
            }

            // An explicit jump-to-tail uses native smooth scrolling. Its
            // intermediate scroll events are still far from the bottom and
            // must not be mistaken for ordinary history browsing. Keep tail
            // mode armed until the animation arrives or the user reverses it.
            if (tailScrollInProgressRef.current) {
                setShowScrollToBottom(false)
                return
            }

            setShowScrollToBottom((wasVisible) => getScrollToBottomButtonVisibility(wasVisible, intent))
            setAutoScrollMode(false)
            setAtBottomMode(false)
        }

        // Gesture fallback: at scrollTop=0 no further scroll events fire. Give
        // touch users progressive feedback, then load only when they release
        // after crossing the threshold.
        let pullStartY: number | null = null

        const updatePullToLoadState = (state: PullToLoadState) => {
            if (pullToLoadStateRef.current === state) {
                return
            }
            pullToLoadStateRef.current = state
            setPullToLoadState(state)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isNestedScrollEvent(event)) return
            if (!UPWARD_SCROLL_KEYS.has(event.key)) {
                keyboardResumeActive = false
            }
            const target = event.target
            if (
                event.defaultPrevented
                || event.repeat
                || event.altKey
                || event.ctrlKey
                || event.metaKey
                || !UPWARD_SCROLL_KEYS.has(event.key)
                || target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return
            }
            cancelSearchRecentering()
            // Native keyboard scrolling can outlive a fixed intent timeout.
            // Keep this gesture armed until consumed, completed, or cancelled.
            keyboardResumeActive = true
            if (needsViewportCoverageRef.current({ includePreloadMargin: true })) {
                keyboardResumeActive = false
                void requestOlderRef.current('user')
            }
        }

        const armPointerIntent = () => {
            keyboardResumeActive = false
            pointerResumeActive = true
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event) || event.button !== 0) {
                return
            }
            cancelSearchRecentering()
            armPointerIntent()
        }

        const isInsideViewport = (clientX: number, clientY: number) => {
            const rect = viewport.getBoundingClientRect()
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
        }

        // Native scrollbar interaction may bypass the viewport's own event
        // listeners. Capture pointer and mouse input at the window boundary,
        // then scope it back to the chat viewport by coordinates.
        const handleWindowPointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                cancelSearchRecentering()
                armPointerIntent()
            }
        }

        const handleWindowMouseDown = (event: MouseEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                cancelSearchRecentering()
                armPointerIntent()
            }
        }

        const clearPointerIntent = () => {
            pointerResumeActive = false
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerCancel = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            const hadActivePointer = pointerResumeActive
            pointerResumeActive = false
            if (hadActivePointer && (event.pointerType === 'touch' || event.pointerType === 'pen')) {
                // Native panning cancels the pointer before some mobile browsers
                // dispatch the resulting scroll event. Retain that explicit input
                // briefly so initial bottom-settling cannot reclaim the viewport.
                pointerResumeUntil = Date.now() + POINTER_CANCEL_INTENT_WINDOW_MS
                return
            }
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handleWheel = (event: WheelEvent) => {
            if (isNestedScrollEvent(event)) return
            cancelSearchRecentering()
            keyboardResumeActive = false
            if (event.deltaY >= 0) {
                wheelIntentUntil = 0
                return
            }
            // One trigger per gesture: a trackpad swipe is a burst of wheel
            // events. Remember the gesture before the following scroll event
            // so an approach from outside the preload area is also classified
            // as explicit user intent.
            const now = Date.now()
            if (now - lastWheelAt > WHEEL_GESTURE_GAP_MS) {
                wheelLatched = false
            }
            lastWheelAt = now
            wheelIntentUntil = now + WHEEL_GESTURE_GAP_MS
            if (!needsViewportCoverageRef.current({ includePreloadMargin: true }) || wheelLatched) {
                return
            }
            wheelLatched = true
            void requestOlderRef.current('user')
        }

        const handleTouchStart = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            cancelSearchRecentering()
            keyboardResumeActive = false
            updatePullToLoadState('idle')
            pullStartY = (
                viewport.scrollTop <= 0
                && hasMoreMessagesRef.current
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
                && !pendingLoadPromiseRef.current
            )
                ? event.touches[0]?.clientY ?? null
                : null
        }

        const handleTouchMove = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            if (pullStartY === null) {
                return
            }
            if (viewport.scrollTop > 0) {
                pullStartY = null
                updatePullToLoadState('idle')
                return
            }
            const currentY = event.touches[0]?.clientY
            if (currentY !== undefined) {
                updatePullToLoadState(getPullToLoadState(currentY - pullStartY))
            }
        }

        const handleTouchEnd = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            const shouldLoad = pullStartY !== null
                && pullToLoadStateRef.current === 'ready'
                && viewport.scrollTop <= 0
            pullStartY = null
            updatePullToLoadState('idle')
            if (shouldLoad) {
                void requestOlderRef.current('user')
            }
        }

        const handleTouchCancel = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            pullStartY = null
            updatePullToLoadState('idle')
        }

        const clearKeyboardIntent = () => {
            keyboardResumeActive = false
        }
        const handleScrollEnd = (event: Event) => {
            if (event.target !== viewport) return
            // Recheck the final geometry before retiring unconsumed demand.
            if (keyboardResumeActive && needsViewportCoverageRef.current({ includePreloadMargin: true })) {
                void requestOlderRef.current('user')
            }
            clearKeyboardIntent()
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('scrollend', handleScrollEnd)
        viewport.addEventListener('focusout', clearKeyboardIntent)
        viewport.addEventListener('keydown', handleKeyDown)
        viewport.addEventListener('pointerdown', handlePointerDown, { passive: true })
        viewport.addEventListener('wheel', handleWheel, { passive: true })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
        viewport.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true, passive: true })
        window.addEventListener('mousedown', handleWindowMouseDown, { capture: true, passive: true })
        window.addEventListener('pointerup', clearPointerIntent, { passive: true })
        window.addEventListener('mouseup', clearPointerIntent, { passive: true })
        window.addEventListener('pointercancel', handlePointerCancel, { passive: true })
        window.addEventListener('blur', clearPointerIntent)
        window.addEventListener('blur', clearKeyboardIntent)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('scrollend', handleScrollEnd)
            viewport.removeEventListener('focusout', clearKeyboardIntent)
            viewport.removeEventListener('keydown', handleKeyDown)
            viewport.removeEventListener('pointerdown', handlePointerDown)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('touchcancel', handleTouchCancel)
            window.removeEventListener('pointerdown', handleWindowPointerDown, true)
            window.removeEventListener('mousedown', handleWindowMouseDown, true)
            window.removeEventListener('pointerup', clearPointerIntent)
            window.removeEventListener('mouseup', clearPointerIntent)
            window.removeEventListener('pointercancel', handlePointerCancel)
            window.removeEventListener('blur', clearPointerIntent)
            window.removeEventListener('blur', clearKeyboardIntent)
        }
    }, []) // Stable: no dependencies, reads from refs

    const scrollToBottomInstant = useCallback(() => {
        if (historyNavigationRef.current || searchTargetHistoryLockRef.current) return
        const viewport = viewportRef.current
        setShowScrollToBottom(false)
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
            lastScrollTopRef.current = viewport.scrollTop
        }
    }, [])

    const scrollToBottomSmooth = useCallback(() => {
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport) {
            return
        }
        if (content && typeof content.scrollIntoView === 'function') {
            content.scrollIntoView({ block: 'end', behavior: 'smooth' })
        } else {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
    }, [])

    const handleNestedScrollFollowChange = useCallback((followLatest: boolean) => {
        if (!followLatest) {
            clearInitialScrollTimers()
        }
        autoScrollEnabledRef.current = !historyNavigationRef.current
            && followLatest
            && atBottomRef.current
    }, [clearInitialScrollTimers])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        cancelHistoryNavigation()
        userCancelledInitialTailRef.current = false
        if (activeSearchTargetId) {
            dismissSearchTarget()
        } else {
            releaseSearchTargetHistoryLock()
        }
        const viewport = viewportRef.current
        setShowScrollToBottom(false)
        if (viewport) {
            tailScrollInProgressRef.current = true
            // Match outline navigation's native smooth-scroll path. Keep
            // instant tail-following disabled until the smooth animation
            // reaches the bottom, otherwise a resize/state update can snap
            // the viewport there before the animation is visible.
            autoScrollEnabledRef.current = false
            scrollToBottomSmooth()
            lastScrollTopRef.current = viewport.scrollTop
        }
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        if (props.onJumpToTail) {
            // A historical search window can look like it is already at the
            // bottom after a clamped/programmatic scroll. Always use the
            // explicit tail transition so the bounded window is reconciled
            // with the server's latest messages before the next turn renders.
            props.onJumpToTail()
        } else {
            onViewModeChangeRef.current('tail')
        }
    }, [activeSearchTargetId, cancelHistoryNavigation, dismissSearchTarget, props.onJumpToTail, releaseSearchTargetHistoryLock, scrollToBottomSmooth])

    // Reset state when session changes
    useLayoutEffect(() => {
        const hasInitialSearchTarget = Boolean(props.initialTargetMessageId?.trim())
        userCancelledInitialTailRef.current = false
        searchTargetHistoryLockRef.current = false
        navigationRunRef.current += 1
        historyNavigationWindowRef.current?.finish(false)
        historyNavigationWindowRef.current = null
        historyNavigationRef.current = false
        navigationInFlightRef.current = false
        setIsNavigationInFlight(false)
        setConversationStartStatus('idle')
        setPromptNavigationStatus('idle')
        setLoadingPromptMessageId(null)
        setShowScrollToBottom(false)
        autoScrollEnabledRef.current = true
        tailScrollInProgressRef.current = false
        lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
        atBottomRef.current = true
        if (hasInitialSearchTarget) {
            autoScrollEnabledRef.current = false
            atBottomRef.current = false
        } else {
            onViewModeChangeRef.current('tail')
        }
        forceScrollTokenRef.current = props.forceScrollToken
        pendingScrollRef.current = null
        pullToLoadStateRef.current = 'idle'
        setPullToLoadState('idle')
        historyLoaderRef.current = {
            runId: historyLoaderRef.current.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: false
        }
        initialScrollSessionRef.current = null
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        clearSearchTargetMarker()
        clearSearchTargetScrollTimers()
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        clearSearchTargetRetryTimer()
        searchTargetValidatedRequestKeyRef.current = null
        searchTargetQueryRetryCountRef.current = 0
        searchTargetContextRetryCountRef.current = 0
        searchTargetRenderRetryCountRef.current = 0
        settlePendingLoad('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearSearchTargetMarker,
        clearSearchTargetRetryTimer,
        clearSearchTargetScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        settlePendingLoad
    ])

    useLayoutEffect(() => {
        if (
            props.initialTargetMessageId?.trim()
            || searchTargetHistoryLockRef.current
            || initialScrollSessionRef.current === props.sessionId
            || props.isSyncingTail
            || props.rawMessagesCount === 0
            || appliedMessagesVersion !== props.messagesVersion
            || hasBlockingScrollRestore()
        ) {
            return
        }

        initialScrollSessionRef.current = props.sessionId
        if (userCancelledInitialTailRef.current) {
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            return
        }
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        scrollToBottomInstant()

        initialScrollDeadlineRef.current = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialScrollTimersRef.current = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialScrollSessionRef.current !== props.sessionId
                || !autoScrollEnabledRef.current
                || searchTargetHistoryLockRef.current
                || hasBlockingScrollRestore()
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.initialTargetMessageId,
        props.isSyncingTail,
        props.rawMessagesCount,
        props.messagesVersion,
        appliedMessagesVersion,
        scrollToBottomInstant,
        clearInitialScrollTimers,
        hasBlockingScrollRestore
    ])

    useLayoutEffect(() => {
        const targetMessageId = activeSearchTargetId
        if (!targetMessageId) {
            const preserveScrollTimers = preserveSearchTargetScrollOnReleaseRef.current
                || searchTargetScrollCleanupTimerRef.current !== null
            preserveSearchTargetScrollOnReleaseRef.current = false
            releaseSearchTargetHistoryLock({ preserveScrollTimers })
            setIsLocatingSearchTarget(false)
            // The route target is cleared after a successful jump. Reset the
            // per-target phase so selecting the same search result later can
            // start a fresh jump instead of being stuck at `complete`.
            if (searchTargetJumpRef.current !== null) {
                searchTargetJumpRef.current = null
                searchTargetValidatedRequestKeyRef.current = null
                clearSearchTargetRetryTimer()
                searchTargetQueryRetryCountRef.current = 0
                searchTargetContextRetryCountRef.current = 0
                searchTargetRenderRetryCountRef.current = 0
            }
            return
        }
        const searchRequestKey = `${props.sessionId}\u0000${props.searchRequestId ?? 0}\u0000${targetSearchQuery}`
        searchTargetHistoryLockRef.current = true
        autoScrollEnabledRef.current = false
        atBottomRef.current = false
        const previous = searchTargetJumpRef.current
        if (
            previous
            && previous.messageId === targetMessageId
            && previous.messageQuery === targetSearchQuery
            && previous.requestId === props.searchRequestId
            && previous.phase === 'complete'
        ) {
            setIsLocatingSearchTarget(false)
            return
        }
        if (
            previous
            && previous.messageId === targetMessageId
            && previous.messageQuery === targetSearchQuery
            && previous.requestId === props.searchRequestId
            && previous.phase === 'failed'
        ) {
            searchTargetHistoryLockRef.current = false
            setIsLocatingSearchTarget(false)
            return
        }
        if (
            props.isSyncingTail
            || props.isLoadingMoreMessages
            || (!targetMessageId && props.rawMessagesCount === 0)
        ) {
            setIsLocatingSearchTarget(true)
            return
        }

        if (
            !previous
            || previous.messageId !== targetMessageId
            || previous.messageQuery !== targetSearchQuery
            || previous.requestId !== props.searchRequestId
        ) {
            clearSearchTargetRetryTimer()
            clearSearchTargetMarker()
            clearSearchTargetScrollTimers()
            preserveSearchTargetScrollOnReleaseRef.current = false
            searchTargetQueryRetryCountRef.current = 0
            searchTargetContextRetryCountRef.current = 0
            searchTargetRenderRetryCountRef.current = 0
            searchTargetJumpRef.current = {
                messageId: targetMessageId,
                messageQuery: targetSearchQuery,
                requestId: props.searchRequestId,
                phase: 'idle'
            }
        }
        const jump = searchTargetJumpRef.current
        if (!jump) {
            setIsLocatingSearchTarget(false)
            return
        }
        if (jump.phase === 'complete' || jump.phase === 'failed') {
            setIsLocatingSearchTarget(false)
            return
        }
        setIsLocatingSearchTarget(true)
        if (jump.phase === 'loading') {
            return
        }

        // assistant-ui can still have the previous window's DOM mounted for
        // one or more renders after the message store publishes a new window.
        // Do not anchor a search target against that stale DOM: a tail
        // reconciliation can otherwise clear the route target before the
        // historical context is rendered, making the jump appear to work and
        // then snap back to the latest messages.
        if (
            appliedMessagesVersion !== props.messagesVersion
            || appliedHistoryVersion !== props.historyVersion
        ) {
            if (searchTargetRenderRetryCountRef.current >= MAX_SEARCH_TARGET_RENDER_RETRIES) {
                jump.phase = 'failed'
                dismissSearchTarget()
                return
            }
            if (jump.phase !== 'waiting-render') {
                jump.phase = 'waiting-runtime'
            }
            searchTargetRenderRetryCountRef.current += 1
            scheduleSearchTargetRetry(SEARCH_TARGET_QUERY_RETRY_DELAY_MS)
            return
        }

        // Even when a cached window already renders the target row, refresh
        // bounded server context once per search request so offline appends or
        // rewinds update epoch, snapshot head, and forward pagination cursors.
        const hasValidatedServerContext = !props.onLoadMessageContext
            || searchTargetValidatedRequestKeyRef.current === searchRequestKey
        // Pending requests can be synthesized from live agent state without a
        // stored transcript row. SessionChat has already validated that request,
        // so a rendered anchor is authoritative; only missing anchors need the
        // bounded server-context load for unloaded history.
        const canUseRenderedTarget = hasValidatedServerContext
            || props.targetHighlightKind === 'pending-request'
        const target = canUseRenderedTarget
            ? findConversationMessageAnchor(targetMessageId, targetSearchQuery)
            : null
        if (target instanceof HTMLElement) {
            const targetRange = targetSearchQuery
                ? findConversationMessageTextRange(target, targetSearchQuery)
                : null
            if (
                targetSearchQuery
                && !targetRange
                && searchTargetQueryRetryCountRef.current < MAX_SEARCH_TARGET_QUERY_RETRIES
            ) {
                searchTargetQueryRetryCountRef.current += 1
                scheduleSearchTargetRetry(SEARCH_TARGET_QUERY_RETRY_DELAY_MS)
                return
            }

            clearSearchTargetRetryTimer()
            jump.phase = 'complete'
            setIsLocatingSearchTarget(false)
            searchTargetHistoryLockRef.current = true
            clearInitialScrollTimers()
            autoScrollEnabledRef.current = false
            atBottomRef.current = false
            onViewModeChangeRef.current('history')
            const matchMarker = targetRange
                ? createSearchMatchMarker(
                    targetRange,
                    targetMessageId
                )
                : null
            if (target instanceof HTMLElement && props.targetHighlightKind === 'pending-request') {
                let collapsed = target.closest<HTMLDetailsElement>('details')
                while (collapsed) {
                    collapsed.open = true
                    collapsed = collapsed.parentElement?.closest<HTMLDetailsElement>('details') ?? null
                }
            }
            scrollSearchTargetIntoView(matchMarker ?? target, viewportRef.current)
            scheduleSearchTargetScroll(targetMessageId, targetSearchQuery, target)
            if (!matchMarker) {
                if (props.targetHighlightKind === 'pending-request') {
                    for (const previous of Array.from(document.querySelectorAll<HTMLElement>(
                        `.${PENDING_REQUEST_TARGET_HIGHLIGHT_CLASS}`
                    ))) {
                        previous.classList.remove(PENDING_REQUEST_TARGET_HIGHLIGHT_CLASS)
                    }
                    void target.offsetWidth
                    target.classList.add(PENDING_REQUEST_TARGET_HIGHLIGHT_CLASS)
                    if (pendingRequestTargetCleanupTimerRef.current !== null) {
                        window.clearTimeout(pendingRequestTargetCleanupTimerRef.current)
                    }
                    pendingRequestTargetCleanupTimerRef.current = window.setTimeout(() => {
                        target.classList.remove(PENDING_REQUEST_TARGET_HIGHLIGHT_CLASS)
                        pendingRequestTargetCleanupTimerRef.current = null
                    }, 1_800)
                } else {
                    target.classList.add(SEARCH_TARGET_HIGHLIGHT_CLASS)
                }
            }
            preserveSearchTargetScrollOnReleaseRef.current = props.targetHighlightKind === 'pending-request'
            props.onInitialTargetConsumed?.()
            return
        }

        // The context response is committed to the message window before
        // assistant-ui has necessarily rendered its message components. Keep
        // the target alive and wait for a later runtime/version or DOM retry;
        // do not issue a second context request during this hand-off window.
        if (jump.phase === 'waiting-render') {
            if (searchTargetRenderRetryCountRef.current >= MAX_SEARCH_TARGET_RENDER_RETRIES) {
                jump.phase = 'failed'
                dismissSearchTarget()
                return
            }
            searchTargetRenderRetryCountRef.current += 1
            scheduleSearchTargetRetry(SEARCH_TARGET_QUERY_RETRY_DELAY_MS)
            return
        }

        if (!props.onLoadMessageContext) {
            jump.phase = 'failed'
            dismissSearchTarget()
            return
        }

        jump.phase = 'loading'
        setIsLocatingSearchTarget(true)
        const searchRequestId = props.searchRequestId
        void props.onLoadMessageContext(targetMessageId).then((loaded) => {
            const current = searchTargetJumpRef.current
            if (!current || current.messageId !== targetMessageId || current.requestId !== searchRequestId) return
            if (!loaded) {
                // A false result can be a transient busy/invalidated window.
                // Retry a few times while preserving the route target instead
                // of silently consuming it and leaving the user at the tail.
                if (searchTargetContextRetryCountRef.current < MAX_SEARCH_TARGET_CONTEXT_RETRIES) {
                    searchTargetContextRetryCountRef.current += 1
                    current.phase = 'idle'
                    scheduleSearchTargetRetry(SEARCH_TARGET_QUERY_RETRY_DELAY_MS)
                } else {
                    current.phase = 'failed'
                    dismissSearchTarget()
                }
                return
            }
            searchTargetValidatedRequestKeyRef.current = searchRequestKey
            current.phase = 'waiting-render'
            searchTargetRenderRetryCountRef.current = 0
            setSearchTargetRetryVersion((version) => version + 1)
        }).catch(() => {
            const current = searchTargetJumpRef.current
            if (!current || current.messageId !== targetMessageId || current.requestId !== searchRequestId) return
            if (searchTargetContextRetryCountRef.current < MAX_SEARCH_TARGET_CONTEXT_RETRIES) {
                searchTargetContextRetryCountRef.current += 1
                current.phase = 'idle'
                scheduleSearchTargetRetry(SEARCH_TARGET_QUERY_RETRY_DELAY_MS)
            } else {
                current.phase = 'failed'
                dismissSearchTarget()
            }
        })
    }, [
        activeSearchTargetId,
        clearInitialScrollTimers,
        clearSearchTargetMarker,
        clearSearchTargetRetryTimer,
        clearSearchTargetScrollTimers,
        dismissSearchTarget,
        releaseSearchTargetHistoryLock,
        scheduleSearchTargetRetry,
        scheduleSearchTargetScroll,
        appliedHistoryVersion,
        appliedMessagesVersion,
        props.historyVersion,
        props.isLoadingMoreMessages,
        props.isSyncingTail,
        props.messagesVersion,
        props.onInitialTargetConsumed,
        props.onLoadMessageContext,
        props.rawMessagesCount,
        props.searchRequestId,
        searchTargetRetryVersion,
        targetSearchQuery
    ])

    useEffect(() => {
        return () => {
            navigationRunRef.current += 1
            historyNavigationWindowRef.current?.finish(false)
            historyNavigationWindowRef.current = null
            historyNavigationRef.current = false
            navigationInFlightRef.current = false
            historyLoaderRef.current.runId += 1
            clearInitialScrollTimers()
            clearSearchTargetMarker()
            clearSearchTargetScrollTimers()
            clearCoverageCheckTimer()
            clearFailureRetryTimer()
            clearSearchTargetRetryTimer()
            settlePendingLoad('transient-stop')
        }
    }, [
        clearInitialScrollTimers,
        clearSearchTargetMarker,
        clearSearchTargetRetryTimer,
        clearSearchTargetScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        settlePendingLoad
    ])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])

    const needsViewportCoverage = useCallback((options?: { includePreloadMargin?: boolean }): boolean => {
        const viewport = viewportRef.current
        const sentinel = topSentinelRef.current
        if (!viewport || !sentinel || viewport.clientHeight <= 0) {
            return false
        }
        const isPinnedAtTail = autoScrollEnabledRef.current
            && atBottomRef.current
            && !searchTargetHistoryLockRef.current
            && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AUTO_SCROLL_RESUME_THRESHOLD_PX
        const includePreloadMargin = options?.includePreloadMargin ?? !isPinnedAtTail
        if (!includePreloadMargin) {
            return viewport.scrollHeight <= viewport.clientHeight + 1
        }
        const viewportRect = viewport.getBoundingClientRect()
        const sentinelRect = sentinel.getBoundingClientRect()
        return shouldLoadOlderForViewport({
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewportTop: viewportRect.top,
            sentinelTop: sentinelRect.top,
            sentinelBottom: sentinelRect.bottom
        })
    }, [])
    needsViewportCoverageRef.current = needsViewportCoverage

    const scheduleCoverageAfterSettling = useCallback(() => {
        clearCoverageCheckTimer()
        if (historyLoaderRef.current.autoPaused) {
            return
        }
        const delay = getHistoryCoverageRetryDelay(initialScrollDeadlineRef.current, Date.now())
        coverageCheckTimerRef.current = window.setTimeout(() => {
            coverageCheckTimerRef.current = null
            if (
                !searchTargetHistoryLockRef.current
                && isReadyForAutomaticCoverage()
                && needsViewportCoverage()
            ) {
                void requestOlderRef.current('coverage')
            }
        }, delay)
    }, [clearCoverageCheckTimer, isReadyForAutomaticCoverage, needsViewportCoverage])

    const startHistoryLoadAttempt = useCallback((runId: number): void => {
        const state = historyLoaderRef.current
        if (state.runId !== runId || !pendingLoadPromiseRef.current) {
            return
        }
        const finishStoppedAttempt = (
            current: HistoryLoaderState,
            result: Exclude<OlderHistoryLoadResult, 'loaded'>,
            autoPaused = current.autoPaused
        ) => {
            clearFailureRetryTimer()
            pendingScrollRef.current = null
            historyLoaderRef.current = {
                ...current,
                phase: 'idle',
                source: null,
                failureCount: 0,
                autoPaused
            }
            settlePendingLoad(result)
            if (
                result === 'transient-stop'
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
            ) {
                scheduleCoverageAfterSettling()
            }
        }

        if (state.source === 'coverage' && !isReadyForAutomaticCoverage()) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        const includePreloadMargin = state.source === 'user' ? true : undefined
        if (state.source !== 'consumer' && !needsViewportCoverage({ includePreloadMargin })) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (isSyncingTailRef.current || isLoadingMoreRef.current) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (!hasMoreMessagesRef.current) {
            finishStoppedAttempt(state, 'terminal-stop', true)
            return
        }

        const viewport = viewportRef.current
        if (!viewport) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }

        clearFailureRetryTimer()
        const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        const preserveTail = state.source === 'coverage'
            && autoScrollEnabledRef.current
            && atBottomRef.current
            && !searchTargetHistoryLockRef.current
            && distanceFromBottom <= AUTO_SCROLL_RESUME_THRESHOLD_PX
        const anchor = captureScrollAnchor(viewport)
        pendingScrollRef.current = {
            runId,
            anchor,
            prependFirstCardMetrics: capturePrependFirstCardMetrics(viewport, anchor),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            targetHistoryVersion: null,
            preserveTail
        }
        if (!preserveTail) {
            autoScrollEnabledRef.current = false
        }
        historyLoaderRef.current = { ...state, phase: 'loading' }

        void (async () => {
            let outcome: OlderLoadOutcome
            try {
                outcome = await onLoadMoreRef.current((historyVersion) => {
                    const current = historyLoaderRef.current
                    const pending = pendingScrollRef.current
                    if (
                        current.runId !== runId
                        || !pendingLoadPromiseRef.current
                        || !pending
                        || pending.runId !== runId
                    ) {
                        return false
                    }
                    if (
                        current.source !== 'consumer'
                        && !needsViewportCoverage({ includePreloadMargin: current.source === 'user' ? true : undefined })
                    ) {
                        return false
                    }
                    pending.targetHistoryVersion = historyVersion
                    historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                    return true
                })
            } catch (error) {
                outcome = {
                    kind: 'failed',
                    error: error instanceof Error
                        ? error
                        : new Error('Failed to load older messages')
                }
            }

            const current = historyLoaderRef.current
            if (current.runId !== runId || !pendingLoadPromiseRef.current) {
                return
            }

            if (outcome.kind === 'applied') {
                const pending = pendingScrollRef.current
                if (!pending || pending.runId !== runId) {
                    finishStoppedAttempt(current, 'transient-stop')
                    return
                }
                pending.targetHistoryVersion = outcome.historyVersion
                historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                return
            }

            pendingScrollRef.current = null
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    historyLoaderRef.current = {
                        ...current,
                        phase: 'backoff',
                        failureCount
                    }
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    failureRetryTimerRef.current = window.setTimeout(() => {
                        failureRetryTimerRef.current = null
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    }, delay)
                    return
                }
                finishStoppedAttempt(current, 'terminal-stop', true)
                return
            }

            const terminalStop = outcome.reason === 'epoch-reset'
                || outcome.reason === 'exhausted'
                || outcome.reason === 'unavailable'
            finishStoppedAttempt(
                current,
                terminalStop ? 'terminal-stop' : 'transient-stop',
                terminalStop ? true : current.autoPaused
            )
        })()
    }, [
        clearFailureRetryTimer,
        isReadyForAutomaticCoverage,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        settlePendingLoad
    ])
    startHistoryLoadAttemptRef.current = startHistoryLoadAttempt

    const requestOlder = useCallback((source: HistoryLoadSource): Promise<OlderHistoryLoadResult> => {
        const viewport = viewportRef.current
        const movedAwayFromBottom = viewport != null
            && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > AUTO_SCROLL_RESUME_THRESHOLD_PX
        const disableTailFollowingForUser = () => {
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            userCancelledInitialTailRef.current = true
            autoScrollEnabledRef.current = false
            if (pendingScrollRef.current && historyLoaderRef.current.runId === pendingScrollRef.current.runId) {
                pendingScrollRef.current.preserveTail = false
            }
        }

        if (source === 'user' && movedAwayFromBottom) {
            disableTailFollowingForUser()
        }

        if (pendingLoadPromiseRef.current) {
            if (source === 'user') {
                disableTailFollowingForUser()
            }
            return pendingLoadPromiseRef.current
        }

        let state = historyLoaderRef.current
        if (source === 'coverage') {
            if (state.autoPaused) {
                return Promise.resolve('terminal-stop')
            }
            if (
                !isReadyForAutomaticCoverage()
                || (isInitialScrollSettling() && !canBypassInitialSettlingForUncoveredTail())
                || !needsViewportCoverage()
            ) {
                return Promise.resolve('transient-stop')
            }
        } else {
            if (!hasMoreMessagesRef.current) {
                return Promise.resolve('terminal-stop')
            }
            if (source === 'user' && state.autoPaused) {
                state = { ...state, autoPaused: false }
                historyLoaderRef.current = state
            }
        }

        if (
            state.phase !== 'idle'
            || isSyncingTailRef.current
            || isLoadingMoreRef.current
            || !viewport
        ) {
            return Promise.resolve('transient-stop')
        }
        if (!hasMoreMessagesRef.current) {
            return Promise.resolve('terminal-stop')
        }

        if (source !== 'coverage') {
            // Explicit consumers must not be swallowed by the initial
            // scroll-to-bottom settling window once a load actually starts.
            if (source === 'user') {
                disableTailFollowingForUser()
            } else {
                initialScrollDeadlineRef.current = 0
                clearInitialScrollTimers()
            }
        }

        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        const runId = state.runId + 1
        historyLoaderRef.current = {
            runId,
            phase: 'loading',
            source,
            failureCount: 0,
            autoPaused: source === 'user' ? false : state.autoPaused
        }
        const loadPromise = new Promise<OlderHistoryLoadResult>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        startHistoryLoadAttemptRef.current(runId)
        return loadPromise
    }, [
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        clearInitialScrollTimers,
        isInitialScrollSettling,
        canBypassInitialSettlingForUncoveredTail,
        isReadyForAutomaticCoverage,
        needsViewportCoverage
    ])
    requestOlderRef.current = requestOlder

    const loadOlderFromConsumer = useCallback((): Promise<OlderHistoryLoadResult> => {
        return requestOlder('consumer')
    }, [requestOlder])

    const loadOlderForOutline = useCallback(async (): Promise<boolean> => {
        return await loadOlderFromConsumer() === 'loaded'
    }, [loadOlderFromConsumer])

    const loadOlderForNavigation = useCallback(async (): Promise<boolean> => {
        const runId = navigationRunRef.current
        return loadOlderForNavigationWithRetry(loadOlderFromConsumer, {
            isCancelled: () => navigationRunRef.current !== runId
        })
    }, [loadOlderFromConsumer])

    const markExplicitNavigationAwayFromBottom = useCallback(() => {
        autoScrollEnabledRef.current = false
        atBottomRef.current = false
        onViewModeChangeRef.current('history')
    }, [])

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        if (navigationInFlightRef.current) return
        const currentViewport = viewportRef.current
        const renderedTarget = document.getElementById(getConversationMessageAnchorId(item.targetMessageId))
        const preserveTailIfVisible = !hasMoreMessagesRef.current && currentViewport && renderedTarget
            && currentViewport.contains(renderedTarget) && currentViewport.scrollHeight - currentViewport.clientHeight <= 1
        const runId = navigationRunRef.current
        const isCancelled = () => navigationRunRef.current !== runId
        navigationInFlightRef.current = true
        setIsNavigationInFlight(true)
        const enterHistoryMode = () => {
            historyNavigationRef.current = true
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            markExplicitNavigationAwayFromBottom()
        }
        if (!preserveTailIfVisible) enterHistoryMode()
        try {
            const target = await locateOutlineTargetMessage({
                targetMessageId: item.targetMessageId,
                findTarget: (anchorId) => document.getElementById(anchorId),
                hasMoreMessages: () => hasMoreMessagesRef.current,
                loadOlderPreservingScroll: loadOlderForOutline
            })
            if (isCancelled()) return
            props.onOutlineItemClick?.(item)
            props.onOutlineOpenChange(false)
            if (target) {
                // Closing the outline can restore the mobile composer and change
                // the viewport height. Let that layout settle before the final
                // target scroll so the footer does not pull the viewport back to
                // the tail position.
                await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
                if (isCancelled()) return
                const viewport = viewportRef.current
                if (viewport && viewport.contains(target)) {
                    const viewportRect = viewport.getBoundingClientRect()
                    const targetRect = target.getBoundingClientRect()
                    if (preserveTailIfVisible) {
                        if (targetRect.top >= viewportRect.top - 1 && targetRect.bottom <= viewportRect.bottom + 1) return
                        enterHistoryMode()
                    }
                    viewport.scrollTo({
                        top: Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - 16),
                        behavior: 'smooth'
                    })
                } else {
                    target.scrollIntoView({ block: 'start', behavior: 'smooth' })
                }
            }
        } finally {
            if (!isCancelled()) {
                historyNavigationRef.current = false
                navigationInFlightRef.current = false
                setIsNavigationInFlight(false)
            }
        }
    }, [loadOlderForOutline, markExplicitNavigationAwayFromBottom, props.onOutlineItemClick, props.onOutlineOpenChange])

    const clearConversationStartFeedback = useCallback(() => {
        if (conversationStartStatusTimerRef.current !== null) {
            window.clearTimeout(conversationStartStatusTimerRef.current)
            conversationStartStatusTimerRef.current = null
        }
        setConversationStartStatus('idle')
    }, [])
    const clearPromptNavigationFeedback = useCallback(() => {
        if (promptNavigationTimerRef.current !== null) {
            window.clearTimeout(promptNavigationTimerRef.current)
            promptNavigationTimerRef.current = null
        }
        setLoadingPromptMessageId(null)
        setPromptNavigationStatus('idle')
    }, [])
    const scrollToPromptForMessage = useCallback(async (
        messageId: string,
        replyToMessageId: string | undefined,
        assistantAnchorState: PromptAnchorState,
        isCancelled: () => boolean,
        focusTarget: boolean,
        heldWindow: HistoryNavigationWindow | null
    ): Promise<boolean> => {
        if (promptNavigationTimerRef.current !== null) {
            window.clearTimeout(promptNavigationTimerRef.current)
            promptNavigationTimerRef.current = null
        }
        setLoadingPromptMessageId(messageId)
        setPromptNavigationStatus('loading')
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        markExplicitNavigationAwayFromBottom()

        const viewport = viewportRef.current
        try {
            if (isCancelled()) return false
            if (!viewport) throw new Error('Chat viewport is unavailable')
            let loadedOlderHistory = false
            const findTarget = () => {
                const target = findPromptTarget(viewport, messageId, assistantAnchorState, replyToMessageId)
                if (target || assistantAnchorState.blockedBySystemTurn || !assistantAnchorState.rawBoundary) return target
                const window = getMessageWindowState(sessionIdRef.current)
                // Don't advance the boundary using raw rows the runtime has
                // not rendered yet, even when they may all be hidden.
                return appliedMessagesVersionRef.current === window.messagesVersion
                    ? findPromptBeforeRawOverlap(viewport, assistantAnchorState, window)
                    : null
            }
            const locatePrompt = async () => {
                let prompt = await findPreviousUserMessageAfterRender(findTarget, assistantAnchorState)
                while (!isCancelled() && !prompt && !assistantAnchorState.blockedBySystemTurn && hasMoreMessagesRef.current) {
                    const loaded = await loadOlderForNavigation()
                    if (isCancelled()) return null
                    if (!loaded) throw new Error('Could not load older messages')
                    loadedOlderHistory = true
                    prompt = await findPreviousUserMessageAfterRender(findTarget, assistantAnchorState)
                }
                return prompt
            }
            for (let attempt = 0; ; attempt += 1) {
                const target = await locatePrompt()
                if (isCancelled()) return false
                if (assistantAnchorState.blockedBySystemTurn) {
                    setPromptNavigationStatus('idle')
                    return false
                }
                if (!target) throw new Error('No preceding user message found')
                if (focusTarget) target.focus({ preventScroll: true })
                target.scrollIntoView({ block: 'start', behavior: 'smooth' })
                const settled = await waitForPromptScrollSettlement(viewport, target, isCancelled)
                if (heldWindow && !await heldWindow.verify()) {
                    if (isCancelled()) return false
                    throw new Error('Could not verify prompt history')
                }
                if (isCancelled()) return false
                // The reconnect may have marked the current node as a steer
                // without removing it. Let the updated assistant runtime commit
                // before checking that this is still the reply's input.
                if (heldWindow) {
                    const version = getMessageWindowState(sessionIdRef.current).messagesVersion
                    const deadline = Date.now() + 1500
                    while (!isCancelled() && appliedMessagesVersionRef.current < version && Date.now() < deadline) {
                        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
                    }
                    if (!isCancelled() && appliedMessagesVersionRef.current < version) {
                        throw new Error('Prompt history refresh did not render')
                    }
                }
                if (isCancelled()) return false
                const current = findTarget()
                if (settled && current === target && target.isConnected) break
                if (attempt >= 2 || (current === target && !settled)) throw new Error('Prompt scroll did not settle')
            }
            const completionStatus = getPromptNavigationCompletionStatus(loadedOlderHistory)
            setPromptNavigationStatus(completionStatus)
            if (completionStatus === 'success') {
                promptNavigationTimerRef.current = window.setTimeout(() => setPromptNavigationStatus('idle'), 1400)
            }
            return true
        } catch (error) {
            if (isCancelled()) return false
            console.error('Failed to locate assistant prompt:', error)
            setPromptNavigationStatus('error')
            promptNavigationTimerRef.current = window.setTimeout(() => setPromptNavigationStatus('idle'), 3000)
            return false
        } finally {
            if (!isCancelled()) {
                setLoadingPromptMessageId(null)
            }
        }
    }, [clearInitialScrollTimers, loadOlderForNavigation, markExplicitNavigationAwayFromBottom])

    const jumpToPrompt = useCallback(async (messageId: string, replyToMessageId?: string, focusTarget = false): Promise<boolean> => {
        if (navigationInFlightRef.current) return false
        const wasTailFollowing = autoScrollEnabledRef.current && atBottomRef.current
        // A cached re-entry's late initial-scroll effect must not reclaim
        // a viewport the reader already asked to navigate explicitly.
        userCancelledInitialTailRef.current = true
        const runId = navigationRunRef.current
        const heldWindow = holdHistoryNavigationWindow(props.sessionId, props.api)
        historyNavigationWindowRef.current = heldWindow
        const runCancelled = () => navigationRunRef.current !== runId
        const isCancelled = () => runCancelled() || heldWindow?.isCurrent() === false
        let reachedPrompt = false
        navigationInFlightRef.current = true
        historyNavigationRef.current = true
        setIsNavigationInFlight(true)
        clearConversationStartFeedback()
        releaseSearchTargetHistoryLock()
        try {
            const assistantAnchorState = capturePromptAnchorState(viewportRef.current, messageId, replyToMessageId)
            const messageWindow = getMessageWindowState(props.sessionId)
            if (messageWindow.epoch !== null && assistantAnchorState.sourceMessageIds?.length) {
                const ids = new Set(assistantAnchorState.sourceMessageIds)
                const replyRow = messageWindow.messages.find(row => typeof row.seq === 'number' && ids.has(row.id))
                if (replyRow) assistantAnchorState.rawBoundary = { epoch: messageWindow.epoch, rowId: replyRow.id }
            }
            // Resolve the prompt through the history-aware path even when its
            // message anchor is already rendered. A direct scroll to the
            // replyToMessageId can race assistant-ui's tail restoration and
            // leave the viewport at its previous position.
            reachedPrompt = await runAfterPendingHistoryLoad(
                pendingLoadPromiseRef.current,
                () => {
                    if (isCancelled()) return false
                    return scrollToPromptForMessage(messageId, replyToMessageId, assistantAnchorState, isCancelled, focusTarget, heldWindow)
                },
                () => {
                    if (promptNavigationTimerRef.current !== null) {
                        window.clearTimeout(promptNavigationTimerRef.current)
                        promptNavigationTimerRef.current = null
                    }
                    setLoadingPromptMessageId(messageId)
                    setPromptNavigationStatus('loading')
                }
            )
            return reachedPrompt
        } finally {
            const invalidated = heldWindow?.isCurrent() === false
            heldWindow?.finish(reachedPrompt)
            if (!runCancelled()) {
                if (invalidated) clearPromptNavigationFeedback()
                historyNavigationRef.current = false
                navigationInFlightRef.current = false
                setIsNavigationInFlight(false)
                const viewport = viewportRef.current
                const hasDisconnectedTail = getMessageWindowState(props.sessionId).requiresLatestReset
                if (wasTailFollowing && !hasMoreNewerRef.current && !hasDisconnectedTail && viewport && (reachedPrompt
                    ? !hasMoreMessagesRef.current && viewport.scrollHeight - viewport.clientHeight <= 1
                    : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AUTO_SCROLL_RESUME_THRESHOLD_PX)) {
                    autoScrollEnabledRef.current = true
                    atBottomRef.current = true
                    onViewModeChangeRef.current('tail')
                }
                scheduleCoverageAfterSettling()
            }
        }
    }, [clearConversationStartFeedback, clearPromptNavigationFeedback, props.api, props.sessionId, releaseSearchTargetHistoryLock, scheduleCoverageAfterSettling, scrollToPromptForMessage])

    const scrollToConversationStart = useCallback(async (focusTarget = false): Promise<boolean> => {
        if (navigationInFlightRef.current) return false
        const currentViewport = viewportRef.current
        releaseSearchTargetHistoryLock()
        const wasTailFollowing = autoScrollEnabledRef.current && atBottomRef.current
        // A short, fully loaded conversation is already at both ends. There
        // is no scroll event to restore tail follow if we enter history mode.
        if (!isSyncingTailRef.current && !getMessageWindowState(props.sessionId).preferLatestOnActivation
            && !hasMoreMessagesRef.current && currentViewport
            && currentViewport.scrollTop <= 1
            && currentViewport.scrollHeight - currentViewport.clientHeight <= 1) {
            if (focusTarget) focusFirstConversationMessage(currentViewport)
            clearPromptNavigationFeedback()
            if (conversationStartStatusTimerRef.current !== null) {
                window.clearTimeout(conversationStartStatusTimerRef.current)
            }
            setConversationStartStatus('success')
            conversationStartStatusTimerRef.current = window.setTimeout(() => setConversationStartStatus('idle'), 1400)
            return true
        }
        // A cached re-entry's late initial-scroll effect must not reclaim
        // a viewport the reader already asked to navigate explicitly.
        userCancelledInitialTailRef.current = true
        const runId = navigationRunRef.current
        const heldWindow = holdHistoryNavigationWindow(props.sessionId, props.api)
        historyNavigationWindowRef.current = heldWindow
        const runCancelled = () => navigationRunRef.current !== runId
        const isCancelled = () => runCancelled() || heldWindow?.isCurrent() === false
        let reachedStart = false
        navigationInFlightRef.current = true
        setIsNavigationInFlight(true)
        historyNavigationRef.current = true
        clearPromptNavigationFeedback()
        if (conversationStartStatusTimerRef.current !== null) {
            window.clearTimeout(conversationStartStatusTimerRef.current)
            conversationStartStatusTimerRef.current = null
        }
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        setConversationStartStatus('loading')
        markExplicitNavigationAwayFromBottom()
        try {
            const loadedAll = await loadAllOlderMessages({
                hasMoreMessages: () => hasMoreMessagesRef.current,
                loadOlderPreservingScroll: loadOlderForNavigation,
                isCancelled
            })
            if (isCancelled()) return false
            if (!loadedAll) {
                setConversationStartStatus('error')
                conversationStartStatusTimerRef.current = window.setTimeout(() => setConversationStartStatus('idle'), 3000)
                return false
            }
            const viewport = viewportRef.current
            if (isCancelled()) return false
            if (!viewport) {
                setConversationStartStatus('error')
                conversationStartStatusTimerRef.current = window.setTimeout(() => setConversationStartStatus('idle'), 3000)
                return false
            }
            // Preserve the pre-jump baseline so the first smooth-scroll frames
            // still count as upward movement. Zeroing this first makes an early
            // near-bottom frame look non-upward and can flip view mode back to
            // tail, compacting the history we just loaded.
            const firstAnchor = viewport.querySelector(MESSAGE_ANCHOR_SELECTOR)
            lastScrollTopRef.current = viewport.scrollTop
            viewport.scrollTo({ top: 0, behavior: 'smooth' })
            if (!await waitForViewportTop(viewport, 2500, isCancelled)) {
                if (isCancelled()) return false
                // Some browsers keep a long smooth scroll alive while the
                // message list is being resized. The navigation contract is
                // a deterministic jump, so cancel that animation rather than
                // allowing a late frame to re-enter tail mode.
                viewport.scrollTo({ top: 0, behavior: 'instant' })
                await waitForViewportTop(viewport, 250, isCancelled)
            }
            if (isCancelled()) return false
            const verified = await heldWindow?.verifyStart() ?? true
            if (isCancelled()) return false
            if (!verified || viewport.querySelector(MESSAGE_ANCHOR_SELECTOR) !== firstAnchor || viewport.scrollTop > 1) {
                throw new Error('Could not reach conversation start')
            }
            if (focusTarget) focusFirstConversationMessage(viewport)
            reachedStart = true
            lastScrollTopRef.current = viewport.scrollTop
            setConversationStartStatus('success')
            conversationStartStatusTimerRef.current = window.setTimeout(() => setConversationStartStatus('idle'), 1400)
            return true
        } catch (error) {
            if (isCancelled()) return false
            console.error('Failed to load conversation start:', error)
            setConversationStartStatus('error')
            conversationStartStatusTimerRef.current = window.setTimeout(() => setConversationStartStatus('idle'), 3000)
            return false
        } finally {
            heldWindow?.finish(reachedStart)
            if (!runCancelled()) {
                if (heldWindow?.isCurrent() === false && !reachedStart) {
                    setConversationStartStatus(status => status === 'loading' ? 'idle' : status)
                }
                const hasDisconnectedTail = getMessageWindowState(props.sessionId).requiresLatestReset
                const restoreTail = wasTailFollowing && !hasMoreNewerRef.current && !hasDisconnectedTail && currentViewport && (reachedStart
                    ? !hasMoreMessagesRef.current && currentViewport.scrollHeight - currentViewport.clientHeight <= 1
                    : currentViewport.scrollHeight - currentViewport.scrollTop - currentViewport.clientHeight <= AUTO_SCROLL_RESUME_THRESHOLD_PX)
                historyNavigationRef.current = false
                autoScrollEnabledRef.current = Boolean(restoreTail)
                atBottomRef.current = Boolean(restoreTail)
                if (restoreTail) onViewModeChangeRef.current('tail')
                navigationInFlightRef.current = false
                setIsNavigationInFlight(false)
            }
        }
    }, [
        clearInitialScrollTimers,
        clearPromptNavigationFeedback,
        loadOlderForNavigation,
        markExplicitNavigationAwayFromBottom,
        props.api,
        props.sessionId,
        releaseSearchTargetHistoryLock
    ])

    useEffect(() => () => {
        if (conversationStartStatusTimerRef.current !== null) {
            window.clearTimeout(conversationStartStatusTimerRef.current)
        }
        if (promptNavigationTimerRef.current !== null) {
            window.clearTimeout(promptNavigationTimerRef.current)
        }
    }, [])


    useEffect(() => {
        if (searchTargetHistoryLockRef.current) {
            clearCoverageCheckTimer()
            return
        }
        if (
            !props.hasMoreMessages
            || props.isSyncingTail
            || props.isLoadingMoreMessages
            || appliedMessagesVersion !== props.messagesVersion
            || (props.rawMessagesCount > 0 && isAwaitingInitialTailCommit())
        ) {
            clearCoverageCheckTimer()
            return
        }
        if (!needsViewportCoverage()) {
            return
        }
        if (isInitialScrollSettling() && !canBypassInitialSettlingForUncoveredTail()) {
            scheduleCoverageAfterSettling()
            return
        }
        void requestOlderRef.current('coverage')
    }, [
        props.hasMoreMessages,
        props.isSyncingTail,
        props.isLoadingMoreMessages,
        props.rawMessagesCount,
        props.messagesVersion,
        appliedMessagesVersion,
        isAwaitingInitialTailCommit,
        isInitialScrollSettling,
        canBypassInitialSettlingForUncoveredTail,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        clearCoverageCheckTimer
    ])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep a smooth tail jump aligned with the
            // newest content until it reaches the bottom; otherwise the
            // browser's original smooth-scroll target can become stale.
            if (tailScrollInProgressRef.current && !hasBlockingScrollRestore()) {
                scrollToBottomSmooth()
            } else if (
                autoScrollEnabledRef.current
                && atBottomRef.current
                && !searchTargetHistoryLockRef.current
                && !hasBlockingScrollRestore()
            ) {
                scrollToBottomInstant()
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (
                !searchTargetHistoryLockRef.current
                && !hasBlockingScrollRestore()
                && isReadyForAutomaticCoverage()
                && needsViewportCoverage()
            ) {
                if (isInitialScrollSettling() && !canBypassInitialSettlingForUncoveredTail()) {
                    scheduleCoverageAfterSettling()
                } else {
                    void requestOlderRef.current('coverage')
                }
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [
        scrollToBottomInstant,
        scrollToBottomSmooth,
        isInitialScrollSettling,
        canBypassInitialSettlingForUncoveredTail,
        hasBlockingScrollRestore,
        isReadyForAutomaticCoverage,
        needsViewportCoverage,
        scheduleCoverageAfterSettling
    ])

    useLayoutEffect(() => {
        const forwardAnchor = pendingForwardAnchorRef.current
        if (forwardAnchor) {
            const forwardViewport = viewportRef.current
            if (forwardViewport && restoreScrollAnchor(forwardViewport, forwardAnchor)) {
                lastScrollTopRef.current = forwardViewport.scrollTop
            }
            pendingForwardAnchorRef.current = null
        }
    }, [appliedHistoryVersion])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            if (
                pending.targetHistoryVersion === null
                || appliedHistoryVersion < pending.targetHistoryVersion
            ) {
                return
            }
            const shouldPreserveTail = pending.preserveTail
                && autoScrollEnabledRef.current
                && atBottomRef.current
                && !searchTargetHistoryLockRef.current
            if (shouldPreserveTail) {
                scrollToBottomInstant()
            } else {
                let restoredByAnchor = false
                if (pending.anchor) {
                    const target = document.getElementById(pending.anchor.id)
                    if (target && viewport.contains(target)) {
                        const metrics = pending.prependFirstCardMetrics
                        if (metrics && metrics.height > 0) {
                            const viewportRect = viewport.getBoundingClientRect()
                            const targetRect = target.getBoundingClientRect()
                            if (targetRect.height > metrics.height + 1) {
                                viewport.scrollTop += targetRect.bottom - viewportRect.top - metrics.bottomOffset
                                restoredByAnchor = true
                            }
                        }
                        if (!restoredByAnchor) {
                            restoredByAnchor = restoreScrollAnchor(viewport, pending.anchor)
                        }
                    }
                }
                if (!restoredByAnchor) {
                    const delta = viewport.scrollHeight - pending.scrollHeight
                    viewport.scrollTop = pending.scrollTop + delta
                }
            }
            const loaderState = historyLoaderRef.current
            if (loaderState.runId !== pending.runId || loaderState.phase !== 'awaiting-render') {
                pendingScrollRef.current = null
                return
            }
            lastScrollTopRef.current = viewport.scrollTop
            pendingScrollRef.current = null
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...loaderState,
                phase: 'idle',
                source: null,
                failureCount: 0,
                // A completed page always consumes automatic demand. The next
                // page requires renewed wheel/touch/keyboard/scrollbar intent;
                // render, resize, and scroll-restoration events cannot chain it.
                autoPaused: true
            }
            settlePendingLoad('loaded')
            return
        }
        if (
            !searchTargetHistoryLockRef.current
            && atBottomRef.current
            && autoScrollEnabledRef.current
            && !hasBlockingScrollRestore()
        ) {
            scrollToBottomInstant()
        }
    }, [
        appliedMessagesVersion,
        appliedHistoryVersion,
        scrollToBottomInstant,
        hasBlockingScrollRestore,
        settlePendingLoad,
        clearFailureRetryTimer
    ])

    const showSkeleton = props.isSyncingTail && props.rawMessagesCount === 0
    const handleShareTurn = useCallback((
        messageTarget: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: ShareTurnSnapshot
    ) => {
        const content = contentRef.current
        if (!content) return
        const messageContainer = content.querySelector<HTMLElement>('.happy-thread-messages')
        const sourceContentWidth = messageContainer?.getBoundingClientRect().width
            ?? content.getBoundingClientRect().width

        let target: HTMLElement | null = typeof messageTarget === 'string'
            ? document.getElementById(messageTarget)
            : messageTarget
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            target = findNearestMessageElement(content, clientY)
        }
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            setShareTurn({
                id: ++shareTurnIdRef.current,
                snapshots: fallbackSnapshot ? [fallbackSnapshot] : [],
                sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
            })
            return
        }

        let start: Element | null = target
        while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
            start = start.previousElementSibling
        }
        if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
            start = target
        }

        const snapshots: ShareTurnSnapshot[] = []
        let current: Element | null = start
        while (current instanceof HTMLElement) {
            if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
                break
            }
            const role = current.getAttribute('data-hapi-message-role')
            if (role === 'user' || role === 'assistant') {
                snapshots.push({
                    html: current.outerHTML,
                    text: (current.innerText || current.textContent || '').trim()
                })
            }
            current = current.nextElementSibling
        }

        if (snapshots.length === 0 && target instanceof HTMLElement) {
            snapshots.push({
                html: target.outerHTML,
                text: (target.innerText || target.textContent || '').trim()
            })
        }
        if (snapshots.length === 0 && fallbackSnapshot) {
            snapshots.push(fallbackSnapshot)
        }
        const completeSnapshots = prependMissingUserSnapshot(snapshots, fallbackSnapshot)

        setShareTurn({
            id: ++shareTurnIdRef.current,
            snapshots: completeSnapshots,
            sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
        })
    }, [props.session])

    const hasNavigationStatus = conversationStartStatus !== 'idle' || promptNavigationStatus !== 'idle'
    const navigationFeedback = getNavigationFeedback(conversationStartStatus, promptNavigationStatus)

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            terminalToolDisplayMode,
            showSessionSummaryInChat,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            codexPlanProposalId: props.session.active && props.session.metadata?.capabilities?.concurrentClients
                ? props.session.agentState?.codexPlanProposalId : null,
            onContinuePlan: props.onContinuePlan,
            onRetryMessage: props.onRetryMessage,
            historyActionPending: props.historyActionPending,
            allowInactiveFork: props.allowInactiveFork,
            onBranchConversation: props.onBranchConversation,
            onForkConversation: props.onForkConversation,
            onRewindConversation: props.onRewindConversation,
            isLatestCompletedBoundary: props.isLatestCompletedBoundary,
            assistantForkPoints: props.assistantForkPoints,
            onShareTurn: handleShareTurn,
            hasMoreMessages: props.hasMoreMessages,
            isSyncingTail: props.isSyncingTail,
            isLoadingMoreMessages: props.isLoadingMoreMessages,
            onNestedScrollFollowChange: handleNestedScrollFollowChange,
            loadOlderMessagesPreservingScroll: loadOlderFromConsumer,
            jumpToPrompt,
            loadingPromptMessageId,
            scrollToConversationStart,
            isLoadingConversationStart,
            isNavigationInFlight
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {hasSearchTarget ? (
                    <div
                        data-testid="search-match-navigation"
                        role="group"
                        aria-label={t('misc.searchMatchNavigation')}
                        className="pointer-events-auto absolute left-3 right-3 top-3 z-20 flex justify-center"
                    >
                        <div className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/95 px-1.5 py-1 text-xs text-[var(--app-fg)] shadow-sm backdrop-blur">
                            <span className="min-w-0 max-w-[10rem] truncate px-1.5 text-[var(--app-hint)]" title={targetSearchQuery}>
                                “{targetSearchQuery}”
                            </span>
                            <span className="shrink-0 tabular-nums text-[var(--app-hint)]">
                                {t('misc.searchMatches', {
                                    current: searchMatchCurrentLabel,
                                    total: searchMatchTotalLabel
                                })}
                            </span>
                            <button
                                type="button"
                                aria-label={t('misc.previousSearchMatch')}
                                disabled={searchMatches.length === 0}
                                onClick={() => navigateSearchMatch(-1)}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm leading-none text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:cursor-default disabled:opacity-35"
                            >
                                <span aria-hidden="true">↑</span>
                            </button>
                            <button
                                type="button"
                                aria-label={t('misc.nextSearchMatch')}
                                disabled={searchMatches.length === 0}
                                onClick={() => navigateSearchMatch(1)}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm leading-none text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:cursor-default disabled:opacity-35"
                            >
                                <span aria-hidden="true">↓</span>
                            </button>
                            <button
                                type="button"
                                aria-label={t('misc.closeSearch')}
                                onClick={dismissSearchTarget}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            >
                                <CloseIcon className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                ) : null}
                {isLocatingSearchTarget ? (
                    <div
                        data-testid="search-target-status"
                        role="status"
                        aria-live="polite"
                        className={`pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur ${hasSearchTarget ? 'top-12' : 'top-3'}`}
                    >
                        <Spinner size="sm" label={null} className="text-current" />
                        <span>{t('misc.locatingMessage')}</span>
                    </div>
                ) : !hasNavigationStatus && props.isCatchingUpFromCache && props.rawMessagesCount > 0 ? (
                    <div
                        data-testid="tail-sync-status"
                        role="status"
                        aria-live="polite"
                        className={`pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur ${hasSearchTarget ? 'top-12' : 'top-3'}`}
                    >
                        <Spinner size="sm" label={null} className="text-current" />
                        <span>{t('misc.syncingLatest')}</span>
                    </div>
                ) : !props.isSyncingTail && !hasNavigationStatus && (
                    props.isLoadingMoreMessages || pullToLoadState !== 'idle'
                ) ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className={`pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur ${hasSearchTarget ? 'top-12' : 'top-3'}`}
                    >
                        {props.isLoadingMoreMessages ? (
                            <Spinner size="sm" label={null} className="text-current" />
                        ) : null}
                        <span>
                            {props.isLoadingMoreMessages
                                ? t('misc.loading')
                                : pullToLoadState === 'ready'
                                    ? t('misc.releaseToLoadOlder')
                                    : t('misc.pullToLoadOlder')}
                        </span>
                    </div>
                ) : null}
                <ConversationStartStatus
                    status={navigationFeedback.status}
                    kind={navigationFeedback.kind}
                    belowSearchToolbar={hasSearchTarget}
                />
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div
                        ref={viewportRef}
                        className="app-scroll-y chat-scroll-y scrollbar-auto-hide min-h-0 flex-1 overflow-x-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
                        tabIndex={0}
                    >
                        <div ref={contentRef} className="chat-scroll-content mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadMessagesById components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={props.unseenCount} onClick={scrollToBottom} />
                {shouldRenderScrollToBottomButton(showScrollToBottom, props.unseenCount) ? (
                    <ScrollToBottomButton onClick={scrollToBottom} />
                ) : null}
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        <ConversationOutlinePanel
                            items={props.outlineItems}
                            hasMoreMessages={props.hasMoreMessages}
                            isLoadingMoreMessages={props.isLoadingMoreMessages}
                            onLoadMore={() => {
                                void loadOlderFromConsumer()
                            }}
                            onSelect={handleOutlineSelect}
                            onClose={() => props.onOutlineOpenChange(false)}
                        />
                    </>
                ) : null}
                <ShareTurnDialog
                    key={shareTurn?.id ?? 'closed'}
                    isOpen={shareTurn !== null}
                    title={shareTitle}
                    metadataItems={shareMetadataItems}
                    sourceSnapshots={shareTurn?.snapshots ?? []}
                    sourceContentWidth={shareTurn?.sourceContentWidth ?? null}
                    getGeneratedMediaBlob={getGeneratedMediaBlob}
                    onClose={() => setShareTurn(null)}
                />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
