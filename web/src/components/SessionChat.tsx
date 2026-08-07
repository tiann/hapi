import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
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
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import {
    createScratchlistAttachmentAdapter,
    type ScratchlistAttachmentAdapter,
} from '@/lib/scratchlistAttachmentAdapter'
import {
    attachmentsNeedScratchlistMigration,
    finalizeMigratedScratchlistParkCleanup,
    prepareScratchlistParkAttachments,
    rehydrateScratchlistAttachmentsToComposer,
    stageScratchlistAttachmentsForComposeSend,
    type PendingParkAttachment,
    type ScratchlistParkResult,
} from '@/lib/scratchlistAttachmentFlow'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import { isHubScratchlistAttachmentPath } from '@hapi/protocol'
import { consumeSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, getShareTransfer } from '@/lib/shareTransfer'
import { getDraft } from '@/lib/composer-drafts'
import { useTranslation } from '@/lib/use-translation'
import type { SendMessageAcceptance, SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
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

function isUninvokedScheduledMessage(message: DecryptedMessage): boolean {
    return message.invokedAt == null && message.scheduledAt != null
}

/**
 * Consumes a pending Web Share Target transfer once the assistant runtime
 * is mounted and the session is active enough to accept attachments.
 *
 * Lifecycle:
 *  - A mount effect reads the transfer id out of sessionStorage *once*
 *    via consumeSharePendingTransfer() (not during render — StrictMode
 *    would consume on the discarded pass). The id is stashed in a ref.
 *  - The actual seed (composer.setText + composer.addAttachment per file)
 *    runs once `props.sessionActive` is true. Inactive sessions disable
 *    the attachmentAdapter, so writing attachments while inactive would
 *    no-op and leak Blobs in IDB. The seed waits in a re-renderable
 *    effect for the active flip.
 *  - `consumedRef` gates the effect to a single seed per component
 *    instance — refs survive a StrictMode mount/cleanup/remount pair, so
 *    the second invoke early-returns and the first invoke's async chain
 *    completes naturally (we deliberately don't cancel on cleanup; the
 *    upload is idempotent and the only side effects on the composer are
 *    no-ops once the runtime is unmounted).
 *  - The IDB row is deleted after the seed completes so a back-button
 *    refresh of /sessions/:id doesn't re-attach the same payload.
 */
function ShareSeedConsumer(props: { sessionId: string; sessionActive: boolean }) {
    const assistantApi = useAui()
    const composerText = useAuiState((s) => s.composer.text)
    const composerTextRef = useRef(composerText)
    const initRef = useRef(false)
    const transferIdRef = useRef<string | null>(null)
    const consumedRef = useRef(false)
    const [transferReady, setTransferReady] = useState(false)

    useEffect(() => {
        composerTextRef.current = composerText
    }, [composerText])

    // Consume in an effect, not during render — React.StrictMode double-
    // invokes render functions in dev; a render-time consume deletes the
    // sessionStorage key on the discarded pass and the committed render
    // then sees no transfer.
    useEffect(() => {
        if (initRef.current) return
        initRef.current = true
        transferIdRef.current = consumeSharePendingTransfer()
        setTransferReady(true)
    }, [])

    useEffect(() => {
        if (!transferReady) return
        if (consumedRef.current) return
        const transferId = transferIdRef.current
        if (!transferId) return
        if (!props.sessionActive) return
        consumedRef.current = true

        void (async () => {
            try {
                const payload = await getShareTransfer(transferId)
                if (!payload) return
                const seedText = [payload.title, payload.text, payload.url]
                    .filter((part) => typeof part === 'string' && part.length > 0)
                    .join('\n')
                    .trim()
                if (seedText.length > 0) {
                    const existingText = composerTextRef.current.trim().length > 0
                        ? composerTextRef.current
                        : getDraft(props.sessionId)
                    const nextText = [existingText.trim(), seedText]
                        .filter((part) => part.length > 0)
                        .join('\n\n')
                    if (nextText.length > 0) {
                        assistantApi.composer().setText(nextText)
                    }
                }
                for (const file of payload.files) {
                    const reconstructed = new File([file.blob], file.name, { type: file.type })
                    try {
                        await assistantApi.composer().addAttachment(reconstructed)
                    } catch (err) {
                        console.error('share-seed addAttachment failed', err)
                    }
                }
                await deleteShareTransfer(transferId).catch(() => {})
            } catch (err) {
                console.error('share-seed pull failed', err)
            }
        })()
    }, [transferReady, props.sessionActive, props.sessionId, assistantApi])

    return null
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
    onMove: ReturnType<typeof useHubScratchlist>['move']
    onDelete: ReturnType<typeof useHubScratchlist>['remove']
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<boolean | SendMessageAcceptance>
    onExitScratchlistMode: () => void
    disabled?: boolean
}) {
    const assistantApi = useAui()
    const handlePromoteToComposer = useCallback(async (entry: ScratchlistEntry) => {
        if (props.disabled) return
        assistantApi.composer().setText(entry.text)
        // Exit scratchlist mode before rehydrating attachments so addAttachment
        // uses the normal chat upload adapter (not the scratchlist hub adapter).
        flushSync(() => {
            props.onExitScratchlistMode()
        })
        if (entry.attachments && entry.attachments.length > 0) {
            await rehydrateScratchlistAttachmentsToComposer(
                props.api,
                props.sessionId,
                entry.attachments,
                assistantApi.composer()
            )
        }
    }, [assistantApi, props.api, props.disabled, props.onExitScratchlistMode, props.sessionId])
    const handlePromoteToQueue = useCallback(async (entry: ScratchlistEntry) => {
        if (props.disabled) return false
        let attachments: AttachmentMetadata[] | undefined
        if (entry.attachments && entry.attachments.length > 0) {
            attachments = await stageScratchlistAttachmentsForComposeSend(
                props.api,
                props.sessionId,
                entry.attachments
            )
        }
        // This action is explicitly labelled “Send to queue”. It must retain
        // that contract even when the Pi session is actively thinking.
        const accepted = await props.onSend(entry.text, attachments, undefined, 'queue')
        if (accepted) {
            props.onExitScratchlistMode()
        }
        return Boolean(accepted)
    }, [props.api, props.disabled, props.onSend, props.onExitScratchlistMode, props.sessionId])
    return (
        <ScratchlistDrawer
            entries={props.entries}
            sessionId={props.sessionId}
            api={props.api}
            onMove={props.onMove}
            onDelete={props.onDelete}
            onPromoteToComposer={handlePromoteToComposer}
            onPromoteToQueue={handlePromoteToQueue}
            disabled={props.disabled}
        />
    )
}

export function buildGoalStateMessages(
    messages: DecryptedMessage[]
): DecryptedMessage[] {
    return messages.filter((message) => !isUninvokedScheduledMessage(message))
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
    session: Session
    cursorChatOnDisk?: boolean
    reopenDisabledReason?: string
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
            await navigate({ to: '/sessions/$sessionId', params: { sessionId: result.sessionId } })
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
    const [forceScrollToken, setForceScrollToken] = useState(0)
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
            // it off before send, pending items still carry hub paths. Stage
            // those through the normal CLI upload dir before chat send.
            const list = attachments ?? []
            const hubItems = list.filter((att) => isHubScratchlistAttachmentPath(att.path))
            if (hubItems.length > 0) {
                const normalItems = list.filter((att) => !isHubScratchlistAttachmentPath(att.path))
                const staged = await stageScratchlistAttachmentsForComposeSend(
                    props.api,
                    props.session.id,
                    hubItems,
                )
                const accepted = await props.onSend(
                    text,
                    [...normalItems, ...staged],
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
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
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
    const latestCompletedBoundaryId = useMemo(() => {
        if (props.viewMode !== 'tail') return null
        return findLatestCompletedBoundaryId(
            visibleBlocks,
            props.session.thinking,
            props.session.activeTurnStartedAt ?? null
        )
    }, [props.viewMode, props.session.activeTurnStartedAt, props.session.thinking, visibleBlocks])

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
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleToggleOutline = useCallback(() => {
        setOutlineOpen((open) => !open)
    }, [])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
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
        if (!props.session.active) {
            scratchlistAdapterRef.current = null
            return undefined
        }
        if (scratchlistMode) {
            const adapter = createScratchlistAttachmentAdapter(props.api, props.session.id)
            scratchlistAdapterRef.current = adapter
            return adapter
        }
        scratchlistAdapterRef.current = null
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active, scratchlistMode])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: visibleBlocks,
        messagesVersion: props.messagesVersion,
        historyVersion: props.historyVersion,
        isSending: props.isSending,
        isRunning: props.session.thinking || hasRunningChildAgent,
        onSendMessage: handleSend,
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
                canReopen={inactiveCanResume}
                reopenDisabledReason={props.reopenDisabledReason}
                onSessionDeleted={props.onBack}
                onSessionReopened={(newSessionId) => {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: newSessionId },
                        replace: true
                    })
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
                <DragDropZone disabled={sessionInactive || props.isSending || pendingSchedule != null || isScratchlistParking}>
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
                                    onMove={scratchlist.move}
                                    onDelete={scratchlist.remove}
                                    onSend={props.onSend}
                                    onExitScratchlistMode={() => setScratchlistMode(false)}
                                    disabled={props.isSending || isScratchlistParking}
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
                            />
                        </div>

                        <HappyComposer
                        key={`composer-${props.session.id}`}
                        sessionId={props.session.id}
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
                                        // Pi uses its own provider-qualified picker (piModels prop).
                                        // Feeding piModelOptions here would make the generic Ctrl/Cmd+M
                                        // cycler (getNextModelForFlavor) post a bare modelId string,
                                        // which loses the provider and can pick the wrong cached
                                        // match or throw in runPi. undefined makes the shortcut a no-op
                                        // so Pi model changes go through the dedicated picker only.
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
