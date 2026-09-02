import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { AssistantRuntimeProvider, useAui, useAuiState } from '@assistant-ui/react'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import type { ApiClient } from '@/api/client'
import type {
    AttachmentMetadata,
    CodexCollaborationMode,
    CopilotAgentMode,
    DecryptedMessage,
    PermissionMode,
    Session,
    PiModelSummary,
    SlashCommand
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildConversationOutline } from '@/chat/outline'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import { useUnseenBlockCount } from '@/hooks/useUnseenBlockCount'
import { useCodexExplorationCollapse } from '@/hooks/useCodexExplorationCollapse'
import { isQueuedForInvocation } from '@/lib/messages'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import {
    getCodexModelReasoningEfforts,
    supportsCodexReasoningEffort
} from '@/lib/codexModelCapabilities'
import { createSerialAsyncQueue } from '@/lib/serialAsyncQueue'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { codexModelAdvertisesFastTier, getEffectiveCodexServiceTier } from '@/components/AssistantChat/codexFastMode'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { resolvePendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { QueuedMessagesBar } from '@/components/AssistantChat/QueuedMessagesBar'
import { ScratchlistDrawer } from '@/components/AssistantChat/ScratchlistPanel'
import { useHubScratchlist } from '@/lib/use-hub-scratchlist'
import { useSessions } from '@/hooks/queries/useSessions'
import { getSessionTitle } from '@/lib/sessionTitle'
import { formatSessionMentionTooltip } from '@/lib/sessionReference'
import { classifySessionAttention, getSessionAttentionLabelKey } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { ScratchlistMigrationBanner } from '@/components/AssistantChat/ScratchlistMigrationBanner'
import { findLatestCompletedBoundaryId, useHappyRuntime } from '@/lib/assistant-runtime'
import {
    getRestoredComposerSendIntent,
    resolveMessageDeliveryMode,
    type ComposerSendIntent,
} from '@/lib/messageDelivery'
import {
    isHubScratchlistAttachmentPath,
    stripPreviewUrls,
    isSteeringSupportedForSession,
    type MessageDeliveryMode,
} from '@hapi/protocol'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { ShareSeedConsumer } from '@/components/ShareSeedConsumer'
import {
    createScratchlistAttachmentAdapter,
    type ScratchlistAttachmentAdapter,
} from '@/lib/scratchlistAttachmentAdapter'
import {
    attachmentsNeedScratchlistMigration,
    finalizeMigratedScratchlistParkCleanup,
    prepareScratchlistParkAttachments,
    stageScratchlistAttachmentsForComposeSend,
    type PendingParkAttachment,
    type ScratchlistParkResult,
} from '@/lib/scratchlistAttachmentFlow'
import {
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'
import { useTranslation } from '@/lib/use-translation'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { SendMessageAcceptance, SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { handoffComposerDraft, transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { SessionHeader } from '@/components/SessionHeader'
import { CursorMigrationBanner } from '@/components/CursorMigrationBanner'
import { TeamPanel } from '@/components/TeamPanel'
import { SessionStatusPanel } from '@/components/SessionStatusPanel'
import { buildSessionStatusData } from '@/chat/sessionStatus'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useCursorModels } from '@/hooks/queries/useCursorModels'
import { useCursorModelsForMachine } from '@/hooks/queries/useCursorModelsForMachine'
import {
    mergeCursorCliModelSkus,
    resolveCursorBaseFromWire
} from '@/lib/cursorPickerState'
import {
    buildSessionCursorPickerState,
    isSessionCursorCatalogAwaitingSkus,
    isSessionCursorCatalogPendingWithTimeout,
    SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS,
    resolveSessionCursorBaseSelectValue,
    resolveSessionCursorModelChange,
    resolveSessionCursorVariantSelectValue
} from '@/lib/sessionChatCursorModel'
import { buildCursorEffortPickerOptionsWithDefaultFirst } from '@/lib/cursorModelOptions'
import { useOpencodeModels } from '@/hooks/queries/useOpencodeModels'
import { useGrokModels } from '@/hooks/queries/useGrokModels'
import { useCopilotModels } from '@/hooks/queries/useCopilotModels'
import { useGrokReasoningEffortOptions } from '@/hooks/queries/useGrokReasoningEffortOptions'
import { usePiModels } from '@/hooks/queries/usePiModels'
import { useOpencodeReasoningEffortOptions } from '@/hooks/queries/useOpencodeReasoningEffortOptions'
import { useVoiceOptional } from '@/lib/voice-context'
import { AgentTerminalView } from '@/components/AgentTerminal/AgentTerminalView'
import { VoiceBackendSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'

type SessionModelSelection = { provider: string; modelId: string } | string | null

export function resolvePiContextWindow(
    models: PiModelSummary[] | undefined,
    selectedModel: { provider: string; modelId: string } | null | undefined,
    legacyModelId: string
): number | undefined {
    const model = selectedModel
        ? models?.find((candidate) => (
            candidate.provider === selectedModel.provider
            && candidate.modelId === selectedModel.modelId
        ))
        : models?.find((candidate) => candidate.modelId === legacyModelId)

    return model?.contextWindow
}

export async function applyModelChangeWithReasoningRollback(args: {
    model: SessionModelSelection
    previousModelReasoningEffort: string | null
    shouldClearReasoningEffort: boolean
    setModel: (model: SessionModelSelection) => Promise<void>
    setModelReasoningEffort: (effort: string | null) => Promise<void>
}): Promise<void> {
    let clearedReasoningEffort = false

    try {
        if (args.shouldClearReasoningEffort) {
            await args.setModelReasoningEffort(null)
            clearedReasoningEffort = true
        }
        await args.setModel(args.model)
    } catch (error) {
        if (clearedReasoningEffort && args.previousModelReasoningEffort) {
            await args.setModelReasoningEffort(args.previousModelReasoningEffort).catch((restoreError) => {
                console.error('Failed to restore model reasoning effort:', restoreError)
            })
        }
        throw error
    }
}

/**
 * Returns whether a PendingSchedule should trigger an auto-clear timer.
 *
 * Only 'absolute' schedules expire (the chosen instant passes).
 * 'preset' schedules are relative to send time and have no fixed expiry.
 *
 * Used both by the auto-clear useEffect and by unit tests, so a future
 * variant of PendingSchedule only needs to update this single helper.
 */
export function shouldAutoClearPendingSchedule(pending: PendingSchedule | null): boolean {
    return pending !== null && pending.type === 'absolute'
}

/**
 * True if the keystroke matches the scratchlist-mode toggle shortcut
 * (Ctrl/Cmd + Shift + S, no Alt). Pure / exported for unit tests.
 *
 * Convention: matches the v1 always-visible panel's shortcut so muscle
 * memory carries over. Sibling globals follow the same modifier shape
 * (Ctrl/Cmd-m cycles agent model in HappyComposer).
 */
export function isScratchlistToggleHotkey(e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    key: string
}): boolean {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (!e.shiftKey) return false
    if (e.altKey) return false
    return e.key === 'S' || e.key === 's'
}

/**
 * True when the global scratchlist hotkey should be SKIPPED for the
 * given event target. Window-level shortcuts that fire regardless of
 * focus can quietly toggle modes "behind" modal dialogs (rename,
 * schedule picker, FUE callout) and that's the kind of UX bug the bot
 * caught on PR #798.
 *
 * Block targets:
 *   - any descendant of an open dialog (Radix UI's DialogContent renders
 *     role="dialog", as do FueCallout / ScheduleTimePicker / ImagePreview)
 *   - HTMLInputElement (single-line inputs)
 *   - HTMLSelectElement
 *   - any contentEditable host
 *
 * NOT blocked:
 *   - HTMLTextAreaElement (the composer textarea is the normal focus
 *     target when the operator presses the hotkey - blocking it would
 *     defeat the shortcut)
 *   - the document body / unfocused targets
 *
 * Pure / exported for unit tests.
 */
export function isScratchlistHotkeyBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLSelectElement) return true
    // isContentEditable is the authoritative check in real browsers but
    // jsdom doesn't implement it; the attribute fallback covers both.
    if (target.isContentEditable === true) return true
    return target.getAttribute('contenteditable') === 'true'
}

/**
 * True when a global select-all shortcut (Ctrl/Cmd+A) should be left to
 * the browser default: focus is inside the rich composer
 * (contentEditable), a textarea (the fallback composer), a single-line
 * input/select, or a modal dialog. In every other case the app takes
 * over the shortcut because Chromium's SelectAll collapses to an empty
 * caret when the page contains a contenteditable (the rich composer)
 * but focus is outside it — plain Ctrl+A would select nothing and
 * Ctrl+C would copy nothing (see applyGlobalSelectAll).
 *
 * Deliberately differs from isScratchlistHotkeyBlockedTarget: textareas
 * are blocked here (textarea select-all works natively) while the
 * scratchlist hotkey must keep firing from the composer textarea.
 *
 * Pure / exported for unit tests.
 */
export function isSelectAllTargetBlocked(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLTextAreaElement) return true
    if (target instanceof HTMLSelectElement) return true
    // isContentEditable is the authoritative check in real browsers but
    // jsdom doesn't implement it; the attribute fallback also covers
    // `plaintext-only` composers, which is what the rich composer uses
    // on modern Chromium.
    if (target.isContentEditable === true) return true
    const contenteditable = target.getAttribute('contenteditable')
    return contenteditable !== null && contenteditable !== 'false'
}

/**
 * Chromium quirk: when a page contains a contenteditable element (the
 * rich composer), Ctrl/Cmd+A with focus OUTSIDE the editable collapses
 * to an empty caret instead of selecting the page — Ctrl+C then copies
 * nothing. Reproduced in headless and headed Chrome with both
 * `contenteditable="true"` and `"plaintext-only"`; the bare presence of
 * the editable root is what breaks SelectAll, while focus inside it
 * selects the composer text correctly.
 *
 * This takes over Ctrl/Cmd+A whenever focus is outside the composer
 * (see isSelectAllTargetBlocked) and selects the message thread
 * manually, so select-all + copy restores the expected
 * "select the conversation" behavior.
 *
 * Returns true when the keystroke was handled (preventDefault + range
 * selection). Pure / exported for unit tests and the Playwright fixture.
 */
export function applyGlobalSelectAll(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.repeat) return false
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false
    if (e.key !== 'a' && e.key !== 'A') return false
    if (isSelectAllTargetBlocked(e.target)) return false
    // The thread container is rendered by HappyThread; its class is the
    // stable handle between the page-level shortcut and the message DOM.
    const thread = document.querySelector<HTMLElement>('.happy-thread-messages')
    if (!thread || !thread.textContent) return false
    e.preventDefault()
    const range = document.createRange()
    range.selectNodeContents(thread)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return true
}

/**
 * Decide whether a submit should be routed to the per-session scratchlist
 * or to the regular chat send. Scratchlist entries support text and hub-
 * stored attachments; scheduled sends still fall through to chat.
 *
 * Chat-path chips attached before scratchlist mode are migrated in the
 * park-before-clear path (`prepareScratchlistParkAttachments`, #1226).
 * This predicate still rejects non-hub paths as a fail-closed backstop
 * for any leftover composer.send() route.
 *
 * Pure / exported so it can be unit tested without mounting SessionChat.
 */
export function shouldRouteToScratchlist(
    scratchlistMode: boolean,
    attachments: AttachmentMetadata[] | undefined,
    scheduledAt: number | null | undefined,
): boolean {
    if (!scratchlistMode) return false
    if (scheduledAt != null) return false
    // Only park when every attachment is already hub-resident. Composer
    // uploads made before scratchlist mode was enabled still have normal
    // CLI paths; the hub rejects those as scratchlist metadata.
    return (attachments ?? []).every((att) => isHubScratchlistAttachmentPath(att.path))
}

/**
 * Hub-backed composer attachments can be staged into the normal CLI upload
 * directory for immediate sends. Scheduled sends must preserve their Hub
 * paths so the Hub can materialize them when the schedule matures.
 */
export function shouldStageScratchlistAttachmentsForComposeSend(
    attachments: AttachmentMetadata[] | undefined,
    scheduledAt: number | null | undefined,
): boolean {
    return scheduledAt == null
        && (attachments ?? []).some((attachment) => isHubScratchlistAttachmentPath(attachment.path))
}

export function mergeStagedAttachmentsInOrder(
    attachments: readonly AttachmentMetadata[],
    staged: readonly AttachmentMetadata[],
): AttachmentMetadata[] {
    const stagedById = new Map(staged.map((attachment) => [attachment.id, attachment]))
    return attachments.map((attachment) => stagedById.get(attachment.id) ?? attachment)
}

function isUninvokedScheduledMessage(message: DecryptedMessage): boolean {
    return message.invokedAt == null && message.scheduledAt != null
}

/**
 * Watches for incoming `abort-restore` events (emitted by the PTY launcher
 * when the user aborts a running turn) and surfaces the aborted prompt text —
 * carried on the event itself — via the existing sendError path
 * (onAbortRestore prop). Acts only when no user message has been sent after the
 * abort-restore event, so we never replay a prompt the user already resubmitted.
 */
function AbortRestoreConsumer(props: {
    messages: NormalizedMessage[]
    onAbortRestore: (text: string) => void
}) {
    const lastHandledIdRef = useRef<string | null>(null)

    useEffect(() => {
        // Walk backwards: find an abort-restore event with no user message after it.
        // If a user message comes after the abort-restore, the restore was already
        // acted on — treat it as consumed regardless of page reload.
        let abortRestore: { id: string; text: string } | null = null
        for (let i = props.messages.length - 1; i >= 0; i--) {
            const msg = props.messages[i]
            if (!msg) continue
            if (msg.role === 'user') break  // user message after abort-restore → stale
            if (msg.role !== 'event') continue
            if (msg.content.type === 'abort-restore') {
                // The exact in-flight prompt rides on the event; no need to guess
                // it by scanning historical user turns.
                const text = typeof msg.content.text === 'string' ? msg.content.text : ''
                abortRestore = { id: msg.id, text }
                break
            }
        }
        if (!abortRestore) return
        if (lastHandledIdRef.current === abortRestore.id) return
        lastHandledIdRef.current = abortRestore.id

        // Surface it via the sendError path so HappyComposer restores it the
        // same way it handles a failed send.
        if (abortRestore.text.length > 0) {
            props.onAbortRestore(abortRestore.text)
        }
    }, [props.messages, props.onAbortRestore])

    return null
}

/**
 * Mounts the per-session scratchlist DRAWER (composer-controlled).
 *
 * The drawer renders only when the operator toggles into "scratchlist
 * mode" via the notepad icon in the composer toolbar. While in that mode:
 * - drawer (this component) is visible above the composer
 * - composer's send button repaints amber (handled in ComposerButtons)
 * - SessionChat's wrapped onSend routes adds into the scratchlist
 *
 * Entries state is owned by SessionChat's useScratchlist() so the
 * composer-toolbar counter and the drawer share one source of truth.
 */
export function ScratchlistDrawerHost(props: {
    sessionId: string
    api: ApiClient
    entries: ReturnType<typeof useHubScratchlist>['entries']
    onUpdate: ReturnType<typeof useHubScratchlist>['update']
    onReorder: ReturnType<typeof useHubScratchlist>['reorder']
    onDelete: ReturnType<typeof useHubScratchlist>['remove']
    onSend?: (entry: ScratchlistEntry) => Promise<boolean>
    onSchedule?: (entry: ScratchlistEntry, pending: PendingSchedule) => Promise<boolean>
    disabled?: boolean
}) {
    return (
        <ScratchlistDrawer
            entries={props.entries}
            sessionId={props.sessionId}
            api={props.api}
            onUpdate={props.onUpdate}
            onReorder={props.onReorder}
            onDelete={props.onDelete}
            onSend={props.onSend}
            onSchedule={props.onSchedule}
            disabled={props.disabled}
        />
    )
}

export function buildGoalStateMessages(
    messages: DecryptedMessage[]
): DecryptedMessage[] {
    return messages.filter((message) => !isUninvokedScheduledMessage(message))
}

/**
 * Keep the latest completed fork boundary available while reading history.
 * The history window can no longer contain the tail after older pages are
 * loaded, so recomputing a boundary from that window would either hide the
 * current Fork action or incorrectly mark an older message as current.
 * A live tail revision invalidates the remembered boundary until tail view
 * observes the authoritative current boundary again.
 */
export function resolveLatestCompletedBoundaryIdForView(
    viewMode: 'tail' | 'history',
    currentTailBoundaryId: string | null,
    rememberedTailBoundary: { id: string | null; tailRevision: number } | null,
    currentTailRevision: number
): string | null {
    if (viewMode === 'tail') return currentTailBoundaryId
    if (!rememberedTailBoundary || rememberedTailBoundary.tailRevision !== currentTailRevision) {
        return null
    }
    return rememberedTailBoundary.id
}

function hasAbortableAgentRun(blocks: readonly ChatBlock[]): boolean {
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            if (
                block.tool.name === 'CodexAgent'
                && (block.tool.state === 'running' || block.tool.state === 'pending')
            ) {
                return true
            }
            if (hasAbortableAgentRun(block.children)) {
                return true
            }
        }
    }
    return false
}

type SessionChatProps = {
    api: ApiClient
    titleSuggestionAvailable?: boolean
    session: Session
    cursorChatOnDisk?: boolean
    reopenDisabledReason?: string
    reopenHint?: string
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    sendSettlement: SendMessageSettlement | null
    viewMode: 'tail' | 'history'
    messagesVersion: number
    historyVersion: number
    tailRevision: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    // Returns the accepted mutation's attempt id, or false when
    // pre-mutation guards (no-api / no-session / pending) rejected the call OR async
    // inactive-session resume failed. Composer state that should only be cleared on
    // actual send (pendingSchedule) must await this — see handleSend below.
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | false>
    onScratchlistSendAccepted: (
        attemptId: string,
        sessionId: string,
        entryId: string,
        expectedUpdatedAt: number,
    ) => void
    resolveSessionIdForUpload?: (sessionId: string) => Promise<string>
    onUploadSessionResolved?: (sessionId: string) => void
    onViewModeChange: (mode: 'tail' | 'history') => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
    // The latest send the hub rejected (4xx/5xx/network).  When set, the
    // composer is asked to restore the typed text and surface an inline
    // error -- see HappyComposer.  Cleared by `onClearSendError` once the
    // user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    initialOutlineOpen?: boolean
    onInitialOutlineConsumed?: () => void
    // Called when an `abort-restore` event arrives and the composer is not empty,
    // so the caller can surface the aborted text via the existing sendError path.
    onAbortRestore?: (text: string) => void
}

type ScratchlistSendTracker = (
    attemptId: string,
    sessionId: string,
    entryId: string,
    expectedUpdatedAt: number,
) => void

const MAX_SCRATCHLIST_CLEANUP_RETRIES = 3
const SCRATCHLIST_CLEANUP_RETRY_BASE_MS = 1000

type ScratchlistSendCleanupRegistry = {
    track: ScratchlistSendTracker
    observeSettlement: (settlement: SendMessageSettlement | null) => void
}

const ScratchlistSendCleanupContext = createContext<ScratchlistSendCleanupRegistry | null>(null)

function useScratchlistSendCleanupRegistry(
    api: Pick<ApiClient, 'deleteScratchlistEntryIfUnchanged'>,
): ScratchlistSendCleanupRegistry {
    const pendingSendsRef = useRef(new Map<string, {
        sessionId: string
        entryId: string
        expectedUpdatedAt: number
    }>())
    const successfulAttemptsRef = useRef(new Set<string>())
    const settlingSendsRef = useRef(new Set<string>())
    const cleanupRetriesRef = useRef(new Map<string, number>())
    const cleanupRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
    const clearCleanupRetry = useCallback((attemptId: string) => {
        cleanupRetriesRef.current.delete(attemptId)
        const timer = cleanupRetryTimersRef.current.get(attemptId)
        if (timer !== undefined) {
            clearTimeout(timer)
            cleanupRetryTimersRef.current.delete(attemptId)
        }
    }, [])
    const settlePendingSend = useCallback((attemptId: string) => {
        const pending = pendingSendsRef.current.get(attemptId)
        if (!pending || !successfulAttemptsRef.current.has(attemptId)) return
        // Keep the source draft association through retryable failures. A
        // retry reuses the same local id, so deleting it here would make a
        // later successful retry unable to clean up the original draft.
        if (
            settlingSendsRef.current.has(attemptId)
            || cleanupRetryTimersRef.current.has(attemptId)
        ) return
        settlingSendsRef.current.add(attemptId)
        void api.deleteScratchlistEntryIfUnchanged(
            pending.sessionId,
            pending.entryId,
            pending.expectedUpdatedAt,
        ).then(() => {
            // A false result is an intentional no-op when another client has
            // edited or deleted the draft; in either case this send is settled.
            pendingSendsRef.current.delete(attemptId)
            successfulAttemptsRef.current.delete(attemptId)
            clearCleanupRetry(attemptId)
        }).catch(() => {
            // Keep the association if the cleanup request itself failed and
            // retry transient failures without making the send visible again.
            const retries = cleanupRetriesRef.current.get(attemptId) ?? 0
            if (retries >= MAX_SCRATCHLIST_CLEANUP_RETRIES) {
                // The draft remains available for manual recovery, but do
                // not retain an unbounded in-memory association forever.
                pendingSendsRef.current.delete(attemptId)
                successfulAttemptsRef.current.delete(attemptId)
                cleanupRetriesRef.current.delete(attemptId)
                return
            }
            const nextRetry = retries + 1
            cleanupRetriesRef.current.set(attemptId, nextRetry)
            const timer = setTimeout(() => {
                cleanupRetryTimersRef.current.delete(attemptId)
                settlePendingSend(attemptId)
            }, SCRATCHLIST_CLEANUP_RETRY_BASE_MS * 2 ** (nextRetry - 1))
            cleanupRetryTimersRef.current.set(attemptId, timer)
        }).finally(() => {
            settlingSendsRef.current.delete(attemptId)
        })
    }, [api, clearCleanupRetry])
    const observeSettlement = useCallback((settlement: SendMessageSettlement | null) => {
        if (settlement?.status !== 'success') return
        // The observer also receives ordinary composer sends. Only retain a
        // success for an attempt that was registered by the scratchlist
        // sender, otherwise every successful chat message would accumulate in
        // this long-lived provider's in-memory set.
        if (!pendingSendsRef.current.has(settlement.attemptId)) return
        successfulAttemptsRef.current.add(settlement.attemptId)
        settlePendingSend(settlement.attemptId)
    }, [settlePendingSend])
    const track = useCallback((
        attemptId: string,
        sessionId: string,
        entryId: string,
        expectedUpdatedAt: number,
    ) => {
        pendingSendsRef.current.set(attemptId, { sessionId, entryId, expectedUpdatedAt })
        settlePendingSend(attemptId)
    }, [settlePendingSend])
    useEffect(() => () => {
        for (const timer of cleanupRetryTimersRef.current.values()) {
            clearTimeout(timer)
        }
        cleanupRetryTimersRef.current.clear()
    }, [])
    return useMemo(() => ({ track, observeSettlement }), [observeSettlement, track])
}

export function ScratchlistSendCleanupProvider(props: {
    api: Pick<ApiClient, 'deleteScratchlistEntryIfUnchanged'>
    children: ReactNode
}) {
    const registry = useScratchlistSendCleanupRegistry(props.api)
    return (
        <ScratchlistSendCleanupContext.Provider value={registry}>
            {props.children}
        </ScratchlistSendCleanupContext.Provider>
    )
}

export function useScratchlistSendSettlementObserver(): (settlement: SendMessageSettlement) => void {
    const registry = useContext(ScratchlistSendCleanupContext)
    return registry?.observeSettlement ?? (() => {})
}

export function usePendingScratchlistSendCleanup(
    api: Pick<ApiClient, 'deleteScratchlistEntryIfUnchanged'>,
    sendSettlement: SendMessageSettlement | null,
): ScratchlistSendTracker {
    const contextRegistry = useContext(ScratchlistSendCleanupContext)
    const localRegistry = useScratchlistSendCleanupRegistry(api)
    const registry = contextRegistry ?? localRegistry
    useEffect(() => {
        // A provider-backed registry receives settlement events directly from
        // useSendMessage, including after this chat route unmounts. The local
        // fallback keeps this hook independently testable and backwards
        // compatible for callers outside the sessions route.
        if (!contextRegistry) registry.observeSettlement(sendSettlement)
    }, [contextRegistry, registry, sendSettlement])
    return registry.track
}

/**
 * Public entry point. Thin wrapper around `SessionChatInner` keyed by
 * the session id so that ALL inner state - including the scratchlist
 * (entries + mode) and the assistant-ui runtime - resets atomically
 * when the operator navigates between sessions on the same route
 * (e.g. /sessions/A -> /sessions/B).
 *
 * Without the key, React reuses the same component instance, and
 * effects run AFTER the first paint of the new session. That window
 * briefly renders the new session with the previous session's
 * scratchlist entries / drawer-open state, which is the bot finding
 * on PR #798 (PRRT_kwDOQuQOSc6HHOsa). The keyed wrapper is the
 * canonical React pattern for "fully reset state on prop change"; it
 * supersedes the effect-based mode-reset that previously lived in
 * SessionChatInner.
 */
export function SessionChat(props: SessionChatProps) {
    return <SessionChatInner key={props.session.id} {...props} />
}

function SessionChatInner(props: SessionChatProps) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const { codexExplorationCollapsed } = useCodexExplorationCollapse()
    const navigate = useNavigate()
    const [historyActionPending, setHistoryActionPending] = useState(false)

    const onForkConversation = useCallback(async (messageLocalId?: string) => {
        setHistoryActionPending(true)
        try {
            const result = await props.api.forkConversation(props.session.id, messageLocalId)
            await navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: result.sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        } finally {
            setHistoryActionPending(false)
        }
    }, [navigate, props.api, props.session.id])

    const onRewindConversation = useCallback(async (messageLocalId: string) => {
        setHistoryActionPending(true)
        try {
            await props.api.rewindConversation(props.session.id, messageLocalId)
            props.onRefresh()
        } finally {
            setHistoryActionPending(false)
        }
    }, [props.api, props.onRefresh, props.session.id])
    const sessionInactive = !props.session.active
    const inactiveCanResume = inactiveSessionCanResume(
        props.session,
        props.messages.length,
        props.cursorChatOnDisk
    )
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    // Offer the agent terminal only for an ACTIVE PTY session: a 'remote'/SDK
    // session has no agent PTY, and an archived/inactive one has no live PTY (and
    // no buffer once the runner exits), so its terminal would just be an empty,
    // misleadingly "connected" view. Matches the composer terminal button, which
    // is likewise gated on `session.active`.
    const canViewAgentTerminal =
        props.session.metadata?.startingMode === 'pty' && props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])
    const [rememberedTailBoundary, setRememberedTailBoundary] = useState<{
        id: string | null
        tailRevision: number
    } | null>(null)
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const uploadDraftSnapshotRef = useRef<{ text: string; attachments: AttachmentDraftInput[] }>({
        text: '',
        attachments: [],
    })
    const [outlineOpen, setOutlineOpen] = useState(props.initialOutlineOpen ?? false)
    const [terminalVisible, setTerminalVisible] = useState(false)
    useEffect(() => {
        if (!props.initialOutlineOpen) {
            return
        }
        setOutlineOpen(true)
        props.onInitialOutlineConsumed?.()
    }, [props.initialOutlineOpen, props.onInitialOutlineConsumed])
    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    // Serialize Cursor setModel RPCs so drill-down default apply cannot finish
    // after a later explicit variant click and overwrite it.
    const enqueueCursorModelApply = useMemo(() => createSerialAsyncQueue(), [])
    const lastSyncedCursorModelRef = useRef<string | null | undefined>(undefined)
    const scratchlist = useHubScratchlist(props.session.id, props.api)
    const { sessions: allSessions } = useSessions(props.api)
    const resolveSessionMentionTooltip = useCallback((id: string, title: string) => {
        const hit = allSessions.find((s) => s.id === id) ?? null
        if (!hit) {
            return {
                model: formatSessionMentionTooltip(null, title, id),
                session: null,
            }
        }
        const attention = classifySessionAttention(hit, {
            selected: false,
            lastSeenAt: getSessionLastSeenAt(hit.id),
        })
        const attentionLabel = attention
            ? t(getSessionAttentionLabelKey(attention))
            : null
        return {
            model: formatSessionMentionTooltip(
                {
                    id: hit.id,
                    title: getSessionTitle(hit),
                    active: hit.active,
                    lifecycleState: hit.metadata?.lifecycleState ?? null,
                    path: hit.metadata?.path ?? null,
                    worktreePath: hit.metadata?.worktree?.worktreePath ?? null,
                    relativeTime: formatRelativeTime(hit.updatedAt, t),
                    thinking: hit.thinking,
                    attentionLabel,
                },
                title,
                id
            ),
            session: hit,
        }
    }, [allSessions, t])
    const [scratchlistMode, setScratchlistMode] = useState(false)
    const [isScratchlistParking, setIsScratchlistParking] = useState(false)
    // Mode resets across sessions implicitly: SessionChat is keyed by
    // session.id at the public-export boundary, so a session switch
    // remounts SessionChatInner from scratch and `scratchlistMode`
    // initializes to false again. (Previous effect-based reset was
    // racy on first paint - see public-export comment for context.)
    const handleScratchlistToggle = useCallback(() => {
        if (isScratchlistParking) return
        setScratchlistMode((m) => !m)
    }, [isScratchlistParking])
    /**
     * Global keyboard shortcut: Ctrl/Cmd + Shift + S toggles scratchlist
     * mode (open/close drawer + flip composer routing).
     *
     * Convention matches the v1 always-visible panel's shortcut so muscle
     * memory carries over. Other composer-adjacent globals in the app use
     * the same modifier shape: Ctrl/Cmd-m cycles agent model in
     * HappyComposer. Ctrl/Cmd-Shift-S is unreserved by Chrome / Firefox /
     * Safari at the app level (browser Save As is Ctrl-S / Cmd-S, no
     * Shift), so requiring Shift keeps the user's save-page muscle memory
     * working. Bound at SessionChat scope (not the drawer) because the
     * drawer is unmounted while mode is off — a drawer-scoped listener
     * couldn't reopen it.
     *
     * Skipped when focus is inside an open dialog or single-line input
     * (see isScratchlistHotkeyBlockedTarget). Otherwise fires for any
     * focus target - composer textarea is the expected case so it's
     * deliberately allowed. Window-level shortcut without target
     * filtering would silently toggle mode "behind" modal dialogs
     * (rename, schedule picker, FUE callout); the bot caught this on
     * PR #798.
     */
    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if (isScratchlistParking) return
            if (!isScratchlistToggleHotkey(e)) return
            if (isScratchlistHotkeyBlockedTarget(e.target)) return
            e.preventDefault()
            setScratchlistMode((m) => !m)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [isScratchlistParking])
    /**
     * Global select-all takeover: see applyGlobalSelectAll. Bound at
     * window scope because the broken case is focus on the page body /
     * message thread, which never routes keydown through the composer or
     * the thread viewport.
     */
    useEffect(() => {
        window.addEventListener('keydown', applyGlobalSelectAll)
        return () => window.removeEventListener('keydown', applyGlobalSelectAll)
    }, [])
    /**
     * onSend wrapper: when scratchlist mode is on AND the submission is
     * not scheduled, route to scratchlist (text and/or hub attachments).
     *
     * The composer (HappyComposer) uses the boolean return value to
     * decide whether to clear text/attachments/schedule, so we resolve
     * true on a successful add - the operator's text gets cleared and
     * they can keep adding entries while sticky-mode is on. If add()
     * returns false (empty after trim, at-cap), we resolve false so
     * the composer keeps its text and the operator can fix it.
     *
     * Chat-path chips attached before scratchlist mode are migrated in
     * the scratchlist attachment adapter's send() (#1226). If any
     * non-hub path still reaches this wrapper, fail closed — never park
     * text-only and clear chips.
     */
    // Stable handle so HappyComposer can release parked chips without
    // deleting hub blobs when clearAttachments() calls adapter.remove().
    const scratchlistAdapterRef = useRef<ScratchlistAttachmentAdapter | null>(null)

    /**
     * Park from a live composer snapshot *before* assistant-ui's
     * `composer.send()` empties text/chips. Returning false leaves the
     * composer intact for retry (at-cap / hub error).
     */
    const onParkScratchlist = useCallback(
        async (
            text: string,
            pending: readonly PendingParkAttachment[],
        ): Promise<ScratchlistParkResult> => {
            let prepared
            try {
                prepared = await prepareScratchlistParkAttachments(
                    props.api,
                    props.session.id,
                    pending,
                )
            } catch {
                return false
            }
            let aborted = false
            const abort = async () => {
                if (aborted) return
                aborted = true
                await finalizeMigratedScratchlistParkCleanup(
                    props.api,
                    props.session.id,
                    prepared,
                    false,
                )
            }
            return {
                abort,
                commit: async () => {
                    const accepted = await scratchlist.add(text, prepared)
                    if (!accepted) {
                        await abort()
                        return false
                    }
                    return true
                },
                beforeClear: async () => {
                    await finalizeMigratedScratchlistParkCleanup(
                        props.api,
                        props.session.id,
                        prepared,
                        true,
                    )
                    scratchlistAdapterRef.current?.releaseWithoutDelete(
                        pending.map((chip) => chip.id),
                    )
                },
            }
        },
        [props.api, props.session.id, scratchlist],
    )

    const onSendForComposer = useCallback(
        async (
            text: string,
            attachments?: AttachmentMetadata[],
            scheduledAt?: number | null,
            deliveryMode: MessageDeliveryMode = 'queue',
        ): Promise<{ attemptId: string | null } | false> => {
            if (
                scratchlistMode
                && scheduledAt == null
                && attachmentsNeedScratchlistMigration(attachments)
            ) {
                return false
            }
            if (shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)) {
                // Legacy path if something still calls composer.send() while
                // scratchlist mode is on. Prefer onParkScratchlist (clears
                // only after accept).
                const accepted = await scratchlist.add(text, attachments)
                await finalizeMigratedScratchlistParkCleanup(
                    props.api,
                    props.session.id,
                    attachments,
                    accepted,
                )
                return accepted ? { attemptId: null } : false
            }
            // If the user uploaded while scratchlist mode was on, then toggled
            // it off before an immediate send, pending items still carry Hub
            // paths. Stage those through the normal CLI upload dir. Scheduled
            // sends must keep Hub paths so the Hub can materialize them at the
            // scheduled time.
            const list = attachments ?? []
            const hubItems = list.filter((att) => isHubScratchlistAttachmentPath(att.path))
            if (hubItems.length > 0 && shouldStageScratchlistAttachmentsForComposeSend(list, scheduledAt)) {
                const staged = await stageScratchlistAttachmentsForComposeSend(
                    props.api,
                    props.session.id,
                    hubItems,
                )
                const ordered = mergeStagedAttachmentsInOrder(list, staged)
                const accepted = await props.onSend(
                    text,
                    ordered,
                    scheduledAt,
                    deliveryMode,
                )
                if (accepted) {
                    // Hub blobs were copied into the normal upload dir; drop the
                    // scratchlist copies so they stop counting against the session cap.
                    await Promise.allSettled(
                        hubItems.map((att) => props.api.deleteScratchlistAttachment(props.session.id, att.id))
                    )
                }
                return accepted
            }
            return props.onSend(text, attachments, scheduledAt, deliveryMode)
        },
        [props.onSend, props.api, props.session.id, scratchlist, scratchlistMode],
    )

    const sendScratchlistEntry = useCallback(async (
        entry: ScratchlistEntry,
        scheduledAt: number | null,
    ): Promise<boolean> => {
        const attachments = stripPreviewUrls(entry.attachments ?? [])
        const hubItems = attachments.filter((attachment) => isHubScratchlistAttachmentPath(attachment.path))
        let sendAttachments = attachments
        let staged: AttachmentMetadata[] = []
        if (hubItems.length > 0 && scheduledAt == null) {
            const normalItems = attachments.filter((attachment) => !isHubScratchlistAttachmentPath(attachment.path))
            try {
                staged = await stageScratchlistAttachmentsForComposeSend(
                    props.api,
                    props.session.id,
                    hubItems,
                )
            } catch {
                return false
            }
            sendAttachments = [...normalItems, ...staged]
        }

        const accepted = await props.onSend(
            entry.text,
            sendAttachments.length > 0 ? sendAttachments : undefined,
            scheduledAt,
            'queue',
        )
        if (!accepted) {
            await Promise.allSettled(staged.map((attachment) => props.api.deleteUploadFile(
                props.session.id,
                attachment.path,
            )))
            return false
        }

        // Keep the durable draft and its Hub attachments until the matching
        // mutation settles successfully. The tracker removes the row after
        // success, allowing the Hub to delete its attachments safely; a send
        // failure therefore leaves the draft available for retry.
        props.onScratchlistSendAccepted(
            accepted.attemptId,
            accepted.sessionId,
            entry.id,
            entry.updatedAt ?? entry.createdAt,
        )
        return true
    }, [props.api, props.onSend, props.onScratchlistSendAccepted, props.session.id])

    const handleSendScratchlistEntry = useCallback(
        (entry: ScratchlistEntry) => sendScratchlistEntry(entry, null),
        [sendScratchlistEntry],
    )

    const handleScheduleScratchlistEntry = useCallback(
        (entry: ScratchlistEntry, pending: PendingSchedule) => (
            sendScratchlistEntry(entry, resolvePendingSchedule(pending, Date.now()))
        ),
        [sendScratchlistEntry],
    )

    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.session.id,
        machineId: props.session.metadata?.machineId ?? null,
        enabled: agentFlavor === 'codex' && props.session.active && !controlledByUser
    })
    const effectiveCodexServiceTier = agentFlavor === 'codex'
        ? getEffectiveCodexServiceTier(
            props.session.serviceTier,
            props.session.model,
            codexModelsState.models
        )
        : undefined
    const codexModelOptions = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return undefined
        }

        const options: Array<{ value: string | null; label: string }> = []
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        return options
    }, [agentFlavor, codexModelsState.models])
    const codexSupportedReasoningEfforts = useMemo(
        () => agentFlavor === 'codex'
            ? getCodexModelReasoningEfforts(codexModelsState.models, props.session.model)
            : undefined,
        [agentFlavor, codexModelsState.models, props.session.model]
    )
    const codexReasoningEffortOptions = useMemo(
        () => codexSupportedReasoningEfforts?.map((value) => ({ value })),
        [codexSupportedReasoningEfforts]
    )
    const opencodeModelsState = useOpencodeModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeReasoningEffortState = useOpencodeReasoningEffortOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeModelOptions = useMemo(() => {
        if (agentFlavor !== 'opencode') {
            return undefined
        }

        return opencodeModelsState.availableModels.map((opencodeModel) => ({
            value: opencodeModel.modelId,
            label: opencodeModel.name ?? opencodeModel.modelId
        }))
    }, [agentFlavor, opencodeModelsState.availableModels])
    const grokModelsState = useGrokModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'grok' && props.session.active && !controlledByUser
    })
    const grokEffortState = useGrokReasoningEffortOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'grok' && props.session.active && !controlledByUser
    })
    const grokModelOptions = useMemo(() => (
        agentFlavor === 'grok'
            ? [
                { value: null, label: 'Default' },
                ...grokModelsState.availableModels.map((model) => ({
                    value: model.modelId,
                    label: model.name ?? model.modelId
                }))
            ]
            : undefined
    ), [agentFlavor, grokModelsState.availableModels])
    const copilotModelsState = useCopilotModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'copilot' && props.session.active && !controlledByUser
    })
    const copilotModelOptions = useMemo(() => (
        agentFlavor === 'copilot'
            ? [
                { value: null, label: 'Auto' },
                ...copilotModelsState.availableModels
                    .filter((model) => model.modelId !== 'auto')
                    .map((model) => ({
                        value: model.modelId,
                        label: model.name ?? model.modelId
                    }))
            ]
            : undefined
    ), [agentFlavor, copilotModelsState.availableModels])
    const cursorModelsState = useCursorModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'cursor' && props.session.active
    })
    const sessionMachineId = props.session.metadata?.machineId ?? null
    const machineCursorModelsState = useCursorModelsForMachine({
        api: props.api,
        machineId: sessionMachineId,
        enabled: agentFlavor === 'cursor' && props.session.active && Boolean(sessionMachineId)
    })
    const sessionCliModelSkus = useMemo(() => (
        mergeCursorCliModelSkus(
            machineCursorModelsState.cliModelSkus,
            cursorModelsState.cliModelSkus
        )
    ), [cursorModelsState.cliModelSkus, machineCursorModelsState.cliModelSkus])
    const cursorPicker = useMemo(() => {
        if (agentFlavor !== 'cursor') {
            return null
        }

        return buildSessionCursorPickerState({
            sessionModels: cursorModelsState.availableModels,
            machineModels: machineCursorModelsState.availableModels,
            cliModelSkus: sessionCliModelSkus,
            sessionModel: props.session.model,
            sessionCurrentModelId: cursorModelsState.currentModelId
        })
    }, [
        agentFlavor,
        cursorModelsState.availableModels,
        cursorModelsState.currentModelId,
        machineCursorModelsState.availableModels,
        sessionCliModelSkus,
        props.session.model
    ])
    const piModelsState = usePiModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'pi' && props.session.active
    })
    // Fallback to cached models from metadata when session is inactive
    const piMetadata = props.session.metadata as Record<string, unknown> | null
    const piCachedModels = piMetadata?.piAvailableModels as PiModelSummary[] | undefined ?? []
    // Provider-qualified selected model — disambiguates when two providers
    // share a modelId (hub persists this alongside the legacy modelId string).
    const piSelectedModel = piMetadata?.piSelectedModel as { provider: string; modelId: string } | null | undefined
    const piModels = agentFlavor === 'pi' ? (piModelsState.availableModels.length > 0 ? piModelsState.availableModels : piCachedModels) : undefined
    const piContextWindow = useMemo(() => {
        if (agentFlavor !== 'pi' || !props.session.model) return undefined
        return resolvePiContextWindow(piModels, piSelectedModel, props.session.model)
    }, [agentFlavor, piModels, piSelectedModel, props.session.model])
    const cursorCatalogReadinessArgs = useMemo(() => ({
        sessionLoading: cursorModelsState.isLoading,
        machineLoading: machineCursorModelsState.isLoading,
        hasMachineId: Boolean(sessionMachineId),
        sessionError: cursorModelsState.error,
        machineError: machineCursorModelsState.error,
        mergedSkus: sessionCliModelSkus,
        picker: cursorPicker
    }), [
        cursorModelsState.isLoading,
        cursorModelsState.error,
        machineCursorModelsState.isLoading,
        machineCursorModelsState.error,
        sessionMachineId,
        sessionCliModelSkus,
        cursorPicker
    ])
    const cursorCatalogAwaitingSkus = useMemo(
        () => isSessionCursorCatalogAwaitingSkus(cursorCatalogReadinessArgs),
        [cursorCatalogReadinessArgs]
    )
    const [cursorSkuAwaitingSince, setCursorSkuAwaitingSince] = useState<number | null>(null)
    const [cursorCatalogNowMs, setCursorCatalogNowMs] = useState(() => Date.now())
    useEffect(() => {
        if (cursorCatalogAwaitingSkus) {
            setCursorSkuAwaitingSince((previous) => previous ?? Date.now())
            const timer = setTimeout(
                () => setCursorCatalogNowMs(Date.now()),
                SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS
            )
            return () => clearTimeout(timer)
        }
        setCursorSkuAwaitingSince(null)
        setCursorCatalogNowMs(Date.now())
        return undefined
    }, [cursorCatalogAwaitingSkus])
    const cursorCatalogPending = isSessionCursorCatalogPendingWithTimeout({
        ...cursorCatalogReadinessArgs,
        awaitingStartedAtMs: cursorSkuAwaitingSince,
        nowMs: cursorCatalogNowMs
    })

    useEffect(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            lastSyncedCursorModelRef.current = undefined
            return
        }
        const sessionModel = props.session.model ?? null
        const baseFromSession = sessionModel
            ? resolveCursorBaseFromWire(sessionModel, cursorPicker.catalog)
            : 'auto'
        if (lastSyncedCursorModelRef.current === sessionModel) {
            if (!sessionModel) {
                return
            }
            setCursorSelectedBase((prev) => (prev === 'auto' ? baseFromSession : prev))
            return
        }
        lastSyncedCursorModelRef.current = sessionModel
        setCursorSelectedBase(baseFromSession)
    }, [agentFlavor, props.session.model, cursorPicker])

    const cursorSelectedBaseValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorPicker
            ? resolveSessionCursorBaseSelectValue(cursorPicker, cursorSelectedBase)
            : undefined
    ), [agentFlavor, cursorPicker, cursorSelectedBase])

    const resolveCursorVariantsForBase = useCallback((baseKey: string) => {
        if (!cursorPicker) {
            return []
        }
        return buildCursorEffortPickerOptionsWithDefaultFirst(baseKey, cursorPicker.catalog)
    }, [cursorPicker])

    const cursorModelEffortOptions = useMemo(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            return undefined
        }
        if (cursorPicker.mode !== 'dual') {
            return cursorPicker.effortOptions
        }
        const baseKey = cursorSelectedBaseValue && cursorSelectedBaseValue !== 'auto'
            ? cursorSelectedBaseValue
            : cursorPicker.baseKey
        if (!baseKey || baseKey === 'auto') {
            return undefined
        }
        return buildCursorEffortPickerOptionsWithDefaultFirst(baseKey, cursorPicker.catalog)
    }, [agentFlavor, cursorPicker, cursorSelectedBaseValue])

    const cursorVariantSelectValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorModelEffortOptions
            ? resolveSessionCursorVariantSelectValue(props.session.model, cursorModelEffortOptions)
            : null
    ), [agentFlavor, cursorModelEffortOptions, props.session.model])
    const {
        abortSession,
        switchSession,
        setPermissionMode,
        setCollaborationMode,
        setCopilotAgentMode,
        setModel,
        setModelReasoningEffort,
        setEffort,
        setServiceTier
    } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor,
        codexCollaborationModeSupported
    )

    // Voice assistant integration
    const voice = useVoiceOptional()
    const [voiceBackendReady, setVoiceBackendReady] = useState(false)

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(props.session.id)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
        visibleGroupsRef.current = []
        setOutlineOpen(false)
    }, [props.session.id])

    // Exclude user messages that haven't been invoked yet — those appear in the
    // QueuedMessagesBar above the composer, not in the thread timeline. The
    // `isQueuedForInvocation` predicate is shared with the window store and the
    // floating bar so the three views never disagree about queued state.
    const visibleMessages = useMemo(
        () => props.messages.filter((m) => !isQueuedForInvocation(m)),
        [props.messages]
    )

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
            visibleGroupsRef.current = []
        }
        prevSessionIdRef.current = props.session.id

        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of visibleMessages) {
            if (seen.has(message.id)) {
                continue
            }
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [visibleMessages])

    const goalStateSourceMessages = useMemo(
        () => buildGoalStateMessages(props.messages),
        [props.messages]
    )

    const normalizedGoalStateMessages: NormalizedMessage[] = useMemo(() => {
        const normalized: NormalizedMessage[] = []
        for (const message of goalStateSourceMessages) {
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [goalStateSourceMessages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState, {
            goalStateMessages: normalizedGoalStateMessages
        }),
        [normalizedMessages, normalizedGoalStateMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    const sessionStatus = useMemo(
        () => buildSessionStatusData({
            goal: reduced.latestGoal,
            tasks: props.session.todos,
            blocks: reconciled.blocks,
            messages: normalizedMessages,
            backgroundTaskCount: props.session.backgroundTaskCount
        }),
        [
            reduced.latestGoal,
            props.session.todos,
            props.session.backgroundTaskCount,
            reconciled.blocks,
            normalizedMessages
        ]
    )
    const hasRunningChildAgent = useMemo(
        () => hasAbortableAgentRun(reduced.blocks),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, {
            hasMoreMessages: props.hasMoreMessages,
            previousGroups: visibleGroupsRef.current,
            codexExplorationCollapsed
        }),
        [reconciled.blocks, props.hasMoreMessages, codexExplorationCollapsed]
    )

    // Fork-current must compare against assistant-ui message ids (`kind:id`),
    // not raw hub message ids — MessageActions receive the rendered card id,
    // and adjacent assistant blocks join under the first block's id.
    //
    // Calculate the boundary from the tail window, then remember it while the
    // operator reads history. Otherwise changing viewMode to `history` hides
    // a valid current Fork action, and loading older pages can make the last
    // visible historical message look like the current fork boundary.
    const currentTailBoundaryId = useMemo(() => {
        if (props.viewMode !== 'tail') return null
        return findLatestCompletedBoundaryId(
            visibleBlocks,
            props.session.thinking,
            props.session.activeTurnStartedAt ?? null
        )
    }, [props.viewMode, props.session.activeTurnStartedAt, props.session.thinking, visibleBlocks])

    useEffect(() => {
        if (props.viewMode !== 'tail') return
        setRememberedTailBoundary((previous) => (
            previous?.id === currentTailBoundaryId && previous.tailRevision === props.tailRevision
                ? previous
                : { id: currentTailBoundaryId, tailRevision: props.tailRevision }
        ))
    }, [currentTailBoundaryId, props.tailRevision, props.viewMode])

    const latestCompletedBoundaryId = resolveLatestCompletedBoundaryIdForView(
        props.viewMode,
        currentTailBoundaryId,
        rememberedTailBoundary,
        props.tailRevision
    )

    const isLatestCompletedBoundary = useCallback((messageId: string) => {
        return latestCompletedBoundaryId === messageId
    }, [latestCompletedBoundaryId])

    useEffect(() => {
        visibleGroupsRef.current = visibleBlocks.filter(isToolGroupBlock)
    }, [visibleBlocks])

    // "N new messages" counts rendered blocks, not raw messages: a subagent run
    // is dozens of sidechain messages but a single Task card, and a tool_use +
    // tool_result pair is one card.
    const unseenCount = useUnseenBlockCount(props.viewMode, visibleBlocks)

    const outlineItems = useMemo(
        () => buildConversationOutline(reconciled.blocks),
        [reconciled.blocks]
    )

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleCollaborationModeChange = useCallback(async (mode: CodexCollaborationMode) => {
        try {
            await setCollaborationMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set collaboration mode:', e)
        }
    }, [setCollaborationMode, props.onRefresh, haptic])

    const handleCopilotAgentModeChange = useCallback(async (mode: CopilotAgentMode) => {
        try {
            await setCopilotAgentMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set Copilot agent mode:', e)
        }
    }, [setCopilotAgentMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelChange = useCallback(async (model: SessionModelSelection) => {
        const previousModelReasoningEffort = props.session.modelReasoningEffort
        const shouldClearReasoningEffort = agentFlavor === 'codex'
            && Boolean(previousModelReasoningEffort)
            && supportsCodexReasoningEffort(
                codexModelsState.models,
                model,
                previousModelReasoningEffort
            ) === false

        try {
            await applyModelChangeWithReasoningRollback({
                model,
                previousModelReasoningEffort,
                shouldClearReasoningEffort,
                setModel,
                setModelReasoningEffort
            })
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model:', e)
        }
    }, [
        agentFlavor,
        codexModelsState.models,
        props.session.modelReasoningEffort,
        setModelReasoningEffort,
        setModel,
        props.onRefresh,
        haptic
    ])

    const handleCursorBaseModelChange = useCallback(async (baseKey: string | null) => {
        if (!cursorPicker) {
            await enqueueCursorModelApply(() => handleModelChange(baseKey))
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: cursorPicker.mode === 'flat' ? 'flat' : 'base',
            value: baseKey
        })
        if (!plan.ok) {
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        if (plan.shouldApply) {
            await enqueueCursorModelApply(() => handleModelChange(plan.wireId))
        }
    }, [cursorPicker, cursorSelectedBase, enqueueCursorModelApply, handleModelChange, props.session.model])

    const handleCursorEffortChange = useCallback(async (wireId: string | null) => {
        if (!cursorPicker) {
            await enqueueCursorModelApply(() => handleModelChange(wireId))
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: 'effort',
            value: wireId
        })
        if (!plan.ok) {
            console.error(plan.reason)
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        await enqueueCursorModelApply(() => handleModelChange(plan.wireId))
    }, [cursorPicker, cursorSelectedBase, enqueueCursorModelApply, handleModelChange, props.session.model])

    const handleModelReasoningEffortChange = useCallback(async (modelReasoningEffort: string | null) => {
        try {
            await setModelReasoningEffort(modelReasoningEffort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model reasoning effort:', e)
        }
    }, [setModelReasoningEffort, props.onRefresh, haptic])

    const handleEffortChange = useCallback(async (effort: string | null) => {
        try {
            await setEffort(effort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort:', e)
        }
    }, [setEffort, props.onRefresh, haptic])

    const handleServiceTierChange = useCallback(async (serviceTier: string | null) => {
        try {
            await setServiceTier(serviceTier)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set service tier:', e)
        }
    }, [setServiceTier, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleToggleFiles = useCallback(() => {
        setOutlineOpen(false)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, props.session.id])

    const handleToggleOutline = useCallback(() => {
        setOutlineOpen((open) => !open)
    }, [])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, props.session.id])

    // Scheduled message state — lifted here so useHappyRuntime can read the ref.
    //
    // pendingSchedule holds what the user selected (preset or absolute ms).
    // The ref is read at send time; resolvePendingSchedule converts it to an
    // absolute epoch-ms using Date.now() at that moment (send-time base for presets).
    const [pendingSchedule, setPendingSchedule] = useState<PendingSchedule | null>(null)
    const [pendingScheduleRevision, setPendingScheduleRevision] = useState(0)
    const [sendAcceptance, setSendAcceptance] = useState<{ attemptId: string | null } | null>(null)
    const updatePendingSchedule = useCallback((next: PendingSchedule | null) => {
        setPendingSchedule(next)
        setPendingScheduleRevision((revision) => revision + 1)
    }, [])
    const pendingScheduleRef = useRef<PendingSchedule | null>(null)
    // Keep render ref in sync so onNew can snapshot at send time
    pendingScheduleRef.current = pendingSchedule
    // The single, shared intent ref travels HappyComposer -> useHappyRuntime
    // -> handleSend. The runtime consumes and resets it in the same submit
    // turn, so explicit or retry-safe queue intents never stick to later
    // ordinary sends.
    const pendingSendIntentRef = useRef<ComposerSendIntent>('default')
    const attachmentOrderRef = useRef<string[]>([])
    const restoredSendErrorIdRef = useRef<number | null>(null)

    useEffect(() => {
        const error = props.sendError
        if (!error) {
            restoredSendErrorIdRef.current = null
            return
        }
        if (restoredSendErrorIdRef.current === error.id) return
        // A retry cannot carry the original Pi streaming generation. Preserve
        // queue, but deliberately downgrade a failed turn-scoped steer to the
        // HAPI queue so a later active turn is never steered by stale text.
        pendingSendIntentRef.current = getRestoredComposerSendIntent(error.deliveryMode)
        restoredSendErrorIdRef.current = error.id
    }, [props.sendError])

    const handleClearSendError = useCallback(() => {
        pendingSendIntentRef.current = 'default'
        props.onClearSendError?.()
    }, [props.onClearSendError])

    // Auto-clear absolute-type pendingSchedule when the chosen time expires so
    // the composer clock button doesn't stay active past the scheduled instant.
    // Preset-type schedules are relative so they don't expire until send — the
    // shouldAutoClearPendingSchedule predicate is the single source of truth so
    // adding a new PendingSchedule variant only needs to update that helper.
    useEffect(() => {
        if (!shouldAutoClearPendingSchedule(pendingSchedule)) return
        // Narrowed to 'absolute' by the predicate above.
        const ms = (pendingSchedule as Extract<PendingSchedule, { type: 'absolute' }>).ms
        const remaining = ms - Date.now()
        if (remaining <= 0) {
            updatePendingSchedule(null)
            return
        }
        const timer = setTimeout(() => updatePendingSchedule(null), remaining)
        return () => clearTimeout(timer)
    }, [pendingSchedule, updatePendingSchedule])

    const handleSend = useCallback(async (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        intent: ComposerSendIntent = 'default',
    ) => {
        // Route through the scratchlist-aware wrapper. When scratchlistMode
        // is on AND the payload is pure text, this turns into
        // addScratchlistEntry; otherwise it goes to props.onSend (the chat
        // send path). The wrapper resolves true on success either way so
        // the composer-clear is shared, but the schedule-clear / scroll
        // dance below must gate on the actual route taken (not just
        // scratchlistMode), or a scheduled chat send made while the
        // scratchlist toggle is on will leave pendingSchedule sticky and
        // the next normal send would reuse the same schedule. (Per
        // upstream review on PR #798: [Major] "Clear accepted scheduled
        // chat sends after scratchlist fallback".)
        const routedToScratchlist = shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)
        const deliveryMode = resolveMessageDeliveryMode({
            agentFlavor,
            // Do not use assistant-ui's broader `isRunning` here: a
            // child-agent run is not the Pi main session's steer target.
            isSessionThinking: props.session.thinking,
            intent,
            scheduledAt,
            routesToScratchlist: routedToScratchlist,
        })
        const accepted = await onSendForComposer(text, attachments, scheduledAt, deliveryMode)
        if (!accepted) return
        setSendAcceptance({ attemptId: accepted.attemptId })
        if (!routedToScratchlist) {
            // Clear pendingSchedule only after the mutation is actually
            // accepted - covers both pre-mutation guards AND async
            // inactive-session resume failure. SessionChat is the single
            // owner of schedule clear (HappyComposer no longer clears on
            // its own send path). Schedule clear / forced scroll only
            // matter for chat sends; scratchlist adds don't have a
            // schedule and shouldn't move the chat viewport.
            updatePendingSchedule(null)
            setForceScrollToken((token) => token + 1)
        }
    }, [agentFlavor, onSendForComposer, props.session.thinking, scratchlistMode, updatePendingSchedule])

    const attachmentAdapter = useMemo(() => {
        if (props.session.active && scratchlistMode) {
            const adapter = createScratchlistAttachmentAdapter(props.api, props.session.id)
            scratchlistAdapterRef.current = adapter
            return adapter
        }
        scratchlistAdapterRef.current = null
        if (props.session.active) {
            return createAttachmentAdapter(props.api, props.session.id)
        }
        // Only offer attachments on inactive sessions that can actually resume;
        // otherwise file picks become stuck error attachments that cannot send.
        if (!inactiveCanResume || !props.resolveSessionIdForUpload) {
            return undefined
        }
        // Keep one resume promise for every generator created by this adapter
        // instance. Preview generation can outlive navigation; a remount clears
        // the router cache, so a second file must reuse this closure's promise
        // instead of starting a fresh resume against the retired source id.
        let uploadResolution: Promise<string> | undefined
        const resolveUploadSession = () => {
            uploadResolution ??= props.resolveSessionIdForUpload!(props.session.id).catch((error) => {
                uploadResolution = undefined
                throw error
            })
            return uploadResolution
        }
        return createAttachmentAdapter(
            props.api,
            props.session.id,
            resolveUploadSession,
            async (resolvedSessionId, pending) => {
                // Include the in-flight file and coalesce multi-file drops into
                // one transfer + navigation before the source composer unmounts.
                // isCancelled is sampled at save time so a mid-handoff remove
                // still drops the file (and any prior inactive persist of it).
                await handoffComposerDraft(
                    props.session.id,
                    resolvedSessionId,
                    pending,
                    async (targetSessionId) => {
                        props.onUploadSessionResolved?.(targetSessionId)
                    },
                )
            },
        )
    }, [props.api, props.session.id, props.session.active, props.resolveSessionIdForUpload, scratchlistMode, inactiveCanResume])


    const runtime = useHappyRuntime({
        session: props.session,
        blocks: visibleBlocks,
        messagesVersion: props.messagesVersion,
        historyVersion: props.historyVersion,
        viewMode: props.viewMode,
        isSyncingTail: props.isSyncingTail,
        isLoadingMore: props.isLoadingMoreMessages,
        isSending: props.isSending,
        isRunning: props.session.thinking || hasRunningChildAgent,
        onSendMessage: handleSend,
        attachmentOrderRef,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef,
        pendingSendIntentRef,
    })

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={props.session}
                serviceTier={effectiveCodexServiceTier}
                onBack={props.onBack}
                onToggleFiles={props.session.metadata?.path ? handleToggleFiles : undefined}
                filesActive={false}
                onToggleOutline={handleToggleOutline}
                outlineActive={outlineOpen}
                onToggleTerminal={canViewAgentTerminal ? () => setTerminalVisible(v => !v) : undefined}
                terminalActive={terminalVisible}
                api={props.api}
                titleSuggestionAvailable={props.titleSuggestionAvailable}
                canReopen={inactiveCanResume}
                reopenDisabledReason={props.reopenDisabledReason}
                reopenHint={props.reopenHint}
                onSessionDeleted={props.onBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        props.session.id,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: newSessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />

            <CursorMigrationBanner metadata={props.session.metadata} />

            {sessionStatus ? <SessionStatusPanel data={sessionStatus} /> : null}

            <div className="flex flex-col min-h-0 flex-1">
            {props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {sessionInactive ? (
                <div className="mx-auto w-full max-w-content bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    {inactiveCanResume
                        ? t('session.inactive.autoResume')
                        : t('session.inactive.cannotResume')}
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <ShareSeedConsumer sessionId={props.session.id} sessionActive={props.session.active} />
                <AbortRestoreConsumer messages={normalizedMessages} onAbortRestore={props.onAbortRestore ?? (() => {})} />
                <DragDropZone disabled={(!props.session.active && !inactiveCanResume) || props.isSending || pendingSchedule != null || isScratchlistParking}>
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        {canViewAgentTerminal && (
                            // SessionChatInner is keyed by session.id, so switching sessions remounts this subtree.
                            <AgentTerminalView
                                sessionId={props.session.id}
                                visible={terminalVisible}
                                className={terminalVisible ? 'flex-1 min-h-0' : 'hidden'}
                            />
                        )}
                        <div className={(terminalVisible && canViewAgentTerminal) ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>

                    <HappyThread
                        // Key with prefix: different components under the same session
                        // (thread, scratchlist, composer) must have distinct keys to avoid
                        // React reconciliation issues when switching sessions rapidly.
                        // Without prefixes, React may reuse the wrong component's DOM/localStorage.
                        key={`thread-${props.session.id}`}
                        api={props.api}
                        session={props.session}
                        serviceTier={effectiveCodexServiceTier}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        historyActionPending={historyActionPending}
                        onForkConversation={controlledByUser ? undefined : onForkConversation}
                        onRewindConversation={controlledByUser ? undefined : onRewindConversation}
                        isLatestCompletedBoundary={isLatestCompletedBoundary}
                        onViewModeChange={props.onViewModeChange}
                        isSyncingTail={props.isSyncingTail}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        onCancelLoadMore={props.onCancelLoadMore}
                        unseenCount={unseenCount}
                        rawMessagesCount={visibleMessages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        historyVersion={props.historyVersion}
                        forceScrollToken={forceScrollToken}
                        outlineOpen={outlineOpen}
                        outlineItems={outlineItems}
                        onOutlineOpenChange={setOutlineOpen}
                    />
                    </div>

                    <div className={outlineOpen ? 'max-sm:hidden' : undefined}>
                        {codexCollaborationModeSupported && codexModelsState.error ? (
                            <div className="px-3 pb-2">
                                <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-red-600">
                                    {t('session.codexModelsLoadFailed')}: {codexModelsState.error}
                                </div>
                            </div>
                        ) : null}

                        {/*
                         * tiann/hapi#893: one-time banner shown on first
                         * v2-load when localStorage entries got migrated to
                         * the hub. Sits above the drawer so the operator
                         * sees it whether or not the drawer is open.
                         * Auto-renders nothing unless `migrationStatus ===
                         * 'completed'`.
                         */}
                        <ScratchlistMigrationBanner
                            migrationStatus={scratchlist.migrationStatus}
                            onDismiss={scratchlist.dismissMigrationBanner}
                        />

                        <div className="px-3">
                            {/*
                             * Scratchlist drawer - composer-controlled. Only
                             * mounted when the operator clicks the notepad icon
                             * in the composer toolbar. State lives in the
                             * useScratchlist hook above (so the toolbar counter
                             * and the drawer share one source of truth).
                             */}
                            {scratchlistMode ? (
                                <ScratchlistDrawerHost
                                    sessionId={props.session.id}
                                    api={props.api}
                                    entries={scratchlist.entries}
                                    onUpdate={scratchlist.update}
                                    onReorder={scratchlist.reorder}
                                    onDelete={scratchlist.remove}
                                    // An inactive source session can be resumed
                                    // by the generic composer flow, but these
                                    // Hub-backed attachments are already owned
                                    // by the source session. Hide actions here
                                    // until the drawer is rendered for the
                                    // resolved active session instead of
                                    // starting a send that cannot re-stage them.
                                    onSend={props.session.active ? handleSendScratchlistEntry : undefined}
                                    onSchedule={props.session.active ? handleScheduleScratchlistEntry : undefined}
                                    disabled={props.isSending || isScratchlistParking || scratchlist.isUpdating}
                                />
                            ) : null}
                            <QueuedMessagesBar
                                sessionId={props.session.id}
                                api={props.api}
                                pendingSchedule={pendingSchedule}
                                pendingScheduleRevision={pendingScheduleRevision}
                                onEdit={({ pendingSchedule: restored }) => {
                                    // Restore the schedule so the clock button re-activates
                                    updatePendingSchedule(restored)
                                }}
                                canSteer={isSteeringSupportedForSession(props.session.metadata)
                                    && (agentFlavor === 'pi'
                                        ? props.session.thinking
                                        : props.session.agentState?.steeringActive === true)
                                    && !controlledByUser}
                            />
                        </div>

                        <HappyComposer
                        key={`composer-${props.session.id}`}
                        sessionId={props.session.id}
                        canRestoreAttachments={props.session.active}
                        onUploadDraftSnapshot={(text, attachments) => {
                            uploadDraftSnapshotRef.current = { text, attachments }
                        }}
                        attachmentOrderRef={attachmentOrderRef}
                        resolveSessionMentionTooltip={resolveSessionMentionTooltip}
                        disabled={props.isSending}
                        pendingSchedule={pendingSchedule}
                        sendAcceptance={sendAcceptance}
                        sendSettlement={props.sendSettlement}
                        onSchedule={updatePendingSchedule}
                        onClearSchedule={() => updatePendingSchedule(null)}
                        permissionMode={props.session.permissionMode}
                        collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                        copilotAgentMode={agentFlavor === 'copilot' ? props.session.copilotAgentMode : undefined}
                        model={props.session.model}
                        modelReasoningEffort={agentFlavor === 'codex' || agentFlavor === 'opencode' ? props.session.modelReasoningEffort : undefined}
                        effort={props.session.effort}
                        agentFlavor={agentFlavor}
                        availableModelOptions={
                            agentFlavor === 'codex'
                                ? codexModelOptions
                                : agentFlavor === 'cursor'
                                    ? (
                                        cursorCatalogPending
                                        || !cursorPicker
                                        || cursorPicker.modelOptions.length === 0
                                            ? undefined
                                            : cursorPicker.modelOptions
                                    )
                                    : agentFlavor === 'opencode'
                                        ? opencodeModelOptions
                                        : agentFlavor === 'grok'
                                            ? grokModelOptions
                                        : agentFlavor === 'copilot'
                                            ? copilotModelOptions
                                        // Pi gets its provider-qualified model list from the piModels prop;
                                        // feeding piModelOptions here would make the generic Ctrl/Cmd+M
                                        // cycler (getNextModelForFlavor) post a bare modelId string,
                                        // which loses the provider and can pick the wrong cached
                                        // match or throw in runPi. undefined makes the shortcut a no-op
                                        // so Pi model changes go through the settings sheet only.
                                        : undefined
                        }
                        piModels={piModels}
                        piSelectedModel={agentFlavor === 'pi' ? piSelectedModel : undefined}
                        availableModelReasoningEffortOptions={
                            agentFlavor === 'codex'
                                ? codexReasoningEffortOptions
                                : agentFlavor === 'opencode' && opencodeReasoningEffortState.options.length > 0
                                    ? opencodeReasoningEffortState.options
                                    : undefined
                        }
                        availableEffortOptions={
                            agentFlavor === 'grok' && grokEffortState.options.length > 0
                                ? grokEffortState.options
                                : undefined
                        }
                        active={props.session.active}
                        allowSendWhenInactive
                        onResumeStoredDraft={() => handleSend('', undefined, null)}
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        backgroundTaskCount={props.session.backgroundTaskCount}
                        contextSize={reduced.latestUsage?.contextSize}
                        contextCacheRead={reduced.latestUsage?.cacheRead}
                        contextWindow={reduced.latestUsage?.contextWindow ?? piContextWindow}
                        contextModel={reduced.latestUsage?.model ?? props.session.model}
                        controlledByUser={controlledByUser}
                        onCollaborationModeChange={
                            codexCollaborationModeSupported && props.session.active && !controlledByUser
                                ? handleCollaborationModeChange
                                : undefined
                        }
                        onCopilotAgentModeChange={
                            agentFlavor === 'copilot' && props.session.active && !controlledByUser
                                ? handleCopilotAgentModeChange
                                : undefined
                        }
                        onPermissionModeChange={
                            agentFlavor === 'copilot' && controlledByUser
                                ? undefined
                                : handlePermissionModeChange
                        }
                        selectedModelBase={
                            agentFlavor === 'cursor' && cursorPicker
                                ? cursorSelectedBaseValue
                                : undefined
                        }
                        selectedModelVariant={
                            agentFlavor === 'cursor' && !cursorCatalogPending
                                ? cursorVariantSelectValue
                                : undefined
                        }
                        modelEffortOptions={
                            agentFlavor === 'cursor'
                                && !cursorCatalogPending
                                && cursorPicker?.mode === 'dual'
                                && cursorModelEffortOptions
                                && cursorModelEffortOptions.length > 1
                                ? cursorModelEffortOptions
                                : undefined
                        }
                        resolveModelVariantsForBase={
                            agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
                                ? resolveCursorVariantsForBase
                                : undefined
                        }
                        onModelChange={
                            agentFlavor === 'codex'
                                ? (props.session.active && !controlledByUser && !codexModelsState.error ? handleModelChange : undefined)
                                : agentFlavor === 'cursor'
                                    ? (props.session.active
                                        && !controlledByUser
                                        && !cursorCatalogPending
                                        && !cursorModelsState.error
                                        && cursorPicker
                                        && cursorPicker.modelOptions.length > 0
                                        ? ((model) => handleCursorBaseModelChange(typeof model === 'string' ? model : model?.modelId ?? null))
                                        : undefined)
                                    : agentFlavor === 'pi'
                                        ? (props.session.active && !piModelsState.error ? handleModelChange : undefined)
                                        : agentFlavor === 'grok'
                                            ? (props.session.active && !controlledByUser && !grokModelsState.error
                                                ? handleModelChange
                                                : undefined)
                                        : agentFlavor === 'copilot'
                                            ? (props.session.active && !controlledByUser
                                                ? handleModelChange
                                                : undefined)
                                        : handleModelChange
                        }
                        onModelEffortChange={
                            agentFlavor === 'cursor'
                                && props.session.active
                                && !controlledByUser
                                && !cursorCatalogPending
                                && !cursorModelsState.error
                                ? handleCursorEffortChange
                                : undefined
                        }
                        onModelReasoningEffortChange={
                            (agentFlavor === 'codex' || agentFlavor === 'opencode')
                                && props.session.active
                                && !controlledByUser
                                && (agentFlavor !== 'opencode' || opencodeReasoningEffortState.options.length > 0)
                                ? handleModelReasoningEffortChange
                                : undefined
                        }
                        onEffortChange={
                            agentFlavor === 'grok'
                                ? (props.session.active && !controlledByUser && grokEffortState.options.length > 0
                                    ? handleEffortChange
                                    : undefined)
                                : handleEffortChange
                        }
                        serviceTier={effectiveCodexServiceTier}
                        onServiceTierChange={
                            agentFlavor === 'codex'
                                && props.session.active
                                && !controlledByUser
                                && !codexModelsState.error
                                && codexModelAdvertisesFastTier(props.session.model, codexModelsState.models)
                                ? handleServiceTierChange
                                : undefined
                        }
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active && terminalSupported ? handleViewTerminal : undefined}
                        terminalUnsupported={props.session.active && !terminalSupported}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice && voiceBackendReady ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice && voiceBackendReady ? handleVoiceMicToggle : undefined}
                        voiceTranscriptionApi={props.api}
                        scratchlistMode={scratchlistMode}
                        scratchlistCount={scratchlist.entries.length}
                        onScratchlistToggle={handleScratchlistToggle}
                        onParkScratchlist={onParkScratchlist}
                        onScratchlistParkingChange={setIsScratchlistParking}
                        sendError={props.sendError ?? null}
                        onClearSendError={handleClearSendError}
                        onSuppressSendErrorRestore={props.onSuppressSendErrorRestore}
                        pendingSendIntentRef={pendingSendIntentRef}
                        />
                    </div>
                    </div>
                </DragDropZone>
            </AssistantRuntimeProvider>
            </div>

            {/* Voice session component - renders nothing but initializes voice backend */}
            {voice && (
                <VoiceBackendSession
                    api={props.api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                    onReadyChange={setVoiceBackendReady}
                />
            )}
        </div>
    )
}
