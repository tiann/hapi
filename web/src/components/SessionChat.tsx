import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AssistantRuntimeProvider, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import type { ApiClient } from '@/api/client'
import type {
    AttachmentMetadata,
    CodexCollaborationMode,
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
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import {
    getCodexModelReasoningEfforts,
    supportsCodexReasoningEffort
} from '@/lib/codexModelCapabilities'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { codexModelAdvertisesFastTier } from '@/components/AssistantChat/codexFastMode'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { resolvePendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { QueuedMessagesBar } from '@/components/AssistantChat/QueuedMessagesBar'
import { ScratchlistDrawer } from '@/components/AssistantChat/ScratchlistPanel'
import { useScratchlist } from '@/lib/use-scratchlist'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { consumeSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, getShareTransfer } from '@/lib/shareTransfer'
import { getDraft } from '@/lib/composer-drafts'
import { useTranslation } from '@/lib/use-translation'
import { SessionHeader } from '@/components/SessionHeader'
import { CursorMigrationBanner } from '@/components/CursorMigrationBanner'
import { TeamPanel } from '@/components/TeamPanel'
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
import { buildCursorEffortPickerOptions, resolveCursorVariantOptions } from '@/lib/cursorModelOptions'
import { useOpencodeModels } from '@/hooks/queries/useOpencodeModels'
import { useGrokModels } from '@/hooks/queries/useGrokModels'
import { useGrokReasoningEffortOptions } from '@/hooks/queries/useGrokReasoningEffortOptions'
import { usePiModels } from '@/hooks/queries/usePiModels'
import { useOpencodeReasoningEffortOptions } from '@/hooks/queries/useOpencodeReasoningEffortOptions'
import { useVoiceOptional } from '@/lib/voice-context'
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
 * or to the regular chat send. Scratchlist entries are pure text - they
 * don't carry attachments or schedules - so any submit that includes
 * either of those MUST fall through to the normal chat path even if the
 * scratchlist toggle is on. Otherwise the wrapper would silently drop
 * attachments / scheduled-send metadata while telling the composer the
 * submission succeeded (which then clears the composer state, losing
 * the user's data).
 *
 * Per upstream review on PR #798 (github-actions[bot] [Major]).
 *
 * Pure / exported so it can be unit tested without mounting SessionChat.
 */
export function shouldRouteToScratchlist(
    scratchlistMode: boolean,
    attachments: AttachmentMetadata[] | undefined,
    scheduledAt: number | null | undefined,
): boolean {
    if (!scratchlistMode) return false
    if (attachments && attachments.length > 0) return false
    if (scheduledAt != null) return false
    return true
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
    const assistantApi = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
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
    entries: ReturnType<typeof useScratchlist>['entries']
    onMove: ReturnType<typeof useScratchlist>['move']
    onDelete: ReturnType<typeof useScratchlist>['remove']
    onSend: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    /**
     * Called when the operator promotes an entry to the composer.
     *
     * Promoting means "I want to send this for real now" - so the host
     * MUST exit scratchlist mode, otherwise the next composer submit
     * routes back to scratchlist (per the v1.1 modal-mode contract) and
     * the user re-adds the same text instead of sending it to chat.
     * Per upstream review on PR #798 (HAPI Bot, v6 follow-up).
     */
    onExitScratchlistMode: () => void
}) {
    const assistantApi = useAssistantApi()
    const handlePromoteToComposer = useCallback((text: string) => {
        assistantApi.composer().setText(text)
        props.onExitScratchlistMode()
    }, [assistantApi, props.onExitScratchlistMode])
    const handlePromoteToQueue = useCallback(async (text: string) => {
        // Promote-to-queue bypasses the scratchlist-mode wrapper by
        // calling props.onSend directly (the chat send), so the queue
        // entry lands in the conversation regardless of scratchlist
        // mode. Mode itself stays on - the operator may still be
        // capturing related notes.
        return await props.onSend(text)
    }, [props.onSend])
    return (
        <ScratchlistDrawer
            entries={props.entries}
            onMove={props.onMove}
            onDelete={props.onDelete}
            onPromoteToComposer={handlePromoteToComposer}
            onPromoteToQueue={handlePromoteToQueue}
        />
    )
}

export function buildGoalStateMessages(
    messages: DecryptedMessage[],
    pendingMessages: DecryptedMessage[] = []
): DecryptedMessage[] {
    const eligibleMessages = messages.filter((message) => !isUninvokedScheduledMessage(message))
    const eligiblePendingMessages = pendingMessages.filter((message) => !isUninvokedScheduledMessage(message))
    return eligiblePendingMessages.length > 0
        ? mergeMessages(eligibleMessages, eligiblePendingMessages)
        : eligibleMessages
}

function getOutlineTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        return session.metadata.path
    }
    return session.id.slice(0, 8)
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
    messages: DecryptedMessage[]
    pendingMessages?: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    // Resolves true when the send was accepted by the underlying mutation, false when
    // pre-mutation guards (no-api / no-session / pending) rejected the call OR async
    // inactive-session resume failed. Composer state that should only be cleared on
    // actual send (pendingSchedule) must await this — see handleSend below.
    onSend: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
    // The latest send the hub rejected (4xx/5xx/network).  When set, the
    // composer is asked to restore the typed text and surface an inline
    // error -- see HappyComposer.  Cleared by `onClearSendError` once the
    // user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    initialOutlineOpen?: boolean
    onInitialOutlineConsumed?: () => void
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
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const inactiveCanResume = inactiveSessionCanResume(props.session, props.messages.length)
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const [outlineOpen, setOutlineOpen] = useState(props.initialOutlineOpen ?? false)
    useEffect(() => {
        if (!props.initialOutlineOpen) {
            return
        }
        setOutlineOpen(true)
        props.onInitialOutlineConsumed?.()
    }, [props.initialOutlineOpen, props.onInitialOutlineConsumed])

    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    const lastSyncedCursorModelRef = useRef<string | null | undefined>(undefined)
    const scratchlist = useScratchlist(props.session.id)
    const [scratchlistMode, setScratchlistMode] = useState(false)
    // Mode resets across sessions implicitly: SessionChat is keyed by
    // session.id at the public-export boundary, so a session switch
    // remounts SessionChatInner from scratch and `scratchlistMode`
    // initializes to false again. (Previous effect-based reset was
    // racy on first paint - see public-export comment for context.)
    const handleScratchlistToggle = useCallback(() => {
        setScratchlistMode((m) => !m)
    }, [])
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
            if (!isScratchlistToggleHotkey(e)) return
            if (isScratchlistHotkeyBlockedTarget(e.target)) return
            e.preventDefault()
            setScratchlistMode((m) => !m)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])
    /**
     * onSend wrapper: when scratchlist mode is on AND the submission is
     * pure text (no attachments, no scheduledAt), the operator's submit
     * is treated as "add to scratchlist" instead of "send to chat".
     *
     * If the submission carries attachments or a scheduledAt value,
     * scratchlist can't represent it (entries are text-only), so we
     * fall through to the normal chat send. Silently dropping
     * attachments / schedule while reporting success to the composer
     * caused PR #798 review's [Major] data-loss finding.
     *
     * The composer (HappyComposer) uses the boolean return value to
     * decide whether to clear text/attachments/schedule, so we resolve
     * true on a successful add - the operator's text gets cleared and
     * they can keep adding entries while sticky-mode is on. If add()
     * returns false (empty after trim, at-cap), we resolve false so
     * the composer keeps its text and the operator can fix it.
     */
    const onSendForComposer = useCallback(
        async (
            text: string,
            attachments?: AttachmentMetadata[],
            scheduledAt?: number | null,
        ): Promise<boolean> => {
            if (shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)) {
                return scratchlist.add(text)
            }
            return props.onSend(text, attachments, scheduledAt)
        },
        [props.onSend, scratchlist, scratchlistMode],
    )
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'codex' && props.session.active && !controlledByUser
    })
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
        agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
            ? resolveSessionCursorBaseSelectValue(cursorPicker, cursorSelectedBase)
            : undefined
    ), [agentFlavor, cursorPicker, cursorSelectedBase])

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
        return buildCursorEffortPickerOptions(resolveCursorVariantOptions(baseKey ?? null, cursorPicker.catalog))
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
        () => buildGoalStateMessages(props.messages, props.pendingMessages ?? []),
        [props.messages, props.pendingMessages]
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
            previousGroups: visibleGroupsRef.current
        }),
        [reconciled.blocks, props.hasMoreMessages]
    )

    useEffect(() => {
        visibleGroupsRef.current = visibleBlocks.filter(isToolGroupBlock)
    }, [visibleBlocks])

    const outlineItems = useMemo(
        () => buildConversationOutline(reconciled.blocks),
        [reconciled.blocks]
    )

    const outlineTitle = useMemo(
        () => getOutlineTitle(props.session),
        [props.session]
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
            await handleModelChange(baseKey)
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
            await handleModelChange(plan.wireId)
        }
    }, [cursorPicker, cursorSelectedBase, handleModelChange, props.session.model])

    const handleCursorEffortChange = useCallback(async (wireId: string | null) => {
        if (!cursorPicker) {
            await handleModelChange(wireId)
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
        await handleModelChange(plan.wireId)
    }, [cursorPicker, cursorSelectedBase, handleModelChange, props.session.model])

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
    const pendingScheduleRef = useRef<PendingSchedule | null>(null)
    // Keep render ref in sync so onNew can snapshot at send time
    pendingScheduleRef.current = pendingSchedule

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
            setPendingSchedule(null)
            return
        }
        const timer = setTimeout(() => setPendingSchedule(null), remaining)
        return () => clearTimeout(timer)
    }, [pendingSchedule])

    const handleSend = useCallback(async (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => {
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
        const accepted = await onSendForComposer(text, attachments, scheduledAt)
        if (!accepted) return
        if (!routedToScratchlist) {
            // Clear pendingSchedule only after the mutation is actually
            // accepted - covers both pre-mutation guards AND async
            // inactive-session resume failure. SessionChat is the single
            // owner of schedule clear (HappyComposer no longer clears on
            // its own send path). Schedule clear / forced scroll only
            // matter for chat sends; scratchlist adds don't have a
            // schedule and shouldn't move the chat viewport.
            setPendingSchedule(null)
            setForceScrollToken((token) => token + 1)
        }
    }, [onSendForComposer, scratchlistMode])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: visibleBlocks,
        isSending: props.isSending,
        isRunning: props.session.thinking || hasRunningChildAgent,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef
    })

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onToggleFiles={props.session.metadata?.path ? handleToggleFiles : undefined}
                filesActive={false}
                onToggleOutline={handleToggleOutline}
                outlineActive={outlineOpen}
                api={props.api}
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

            {props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        {inactiveCanResume
                            ? t('session.inactive.autoResume')
                            : t('session.inactive.cannotResume')}
                    </div>
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <ShareSeedConsumer sessionId={props.session.id} sessionActive={props.session.active} />
                <DragDropZone disabled={sessionInactive || props.isSending || pendingSchedule != null}>

                    <HappyThread
                        // Key with prefix: different components under the same session
                        // (thread, scratchlist, composer) must have distinct keys to avoid
                        // React reconciliation issues when switching sessions rapidly.
                        // Without prefixes, React may reuse the wrong component's DOM/localStorage.
                        key={`thread-${props.session.id}`}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={visibleMessages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                        outlineOpen={outlineOpen}
                        outlineTitle={outlineTitle}
                        outlineItems={outlineItems}
                        onOutlineOpenChange={setOutlineOpen}
                    />

                    {codexCollaborationModeSupported && codexModelsState.error ? (
                        <div className="px-3 pb-2">
                            <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-red-600">
                                {t('session.codexModelsLoadFailed')}: {codexModelsState.error}
                            </div>
                        </div>
                    ) : null}

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
                                entries={scratchlist.entries}
                                onMove={scratchlist.move}
                                onDelete={scratchlist.remove}
                                onSend={props.onSend}
                                onExitScratchlistMode={() => setScratchlistMode(false)}
                            />
                        ) : null}
                        <QueuedMessagesBar
                            sessionId={props.session.id}
                            api={props.api}
                            onEdit={({ pendingSchedule: restored }) => {
                                // Restore the schedule so the clock button re-activates
                                setPendingSchedule(restored)
                            }}
                        />
                    </div>

                    <HappyComposer
                        key={`composer-${props.session.id}`}
                        sessionId={props.session.id}
                        disabled={props.isSending}
                        pendingSchedule={pendingSchedule}
                        onSchedule={setPendingSchedule}
                        onClearSchedule={() => setPendingSchedule(null)}
                        permissionMode={props.session.permissionMode}
                        collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                        threadGoal={reduced.latestGoal}
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
                        controlledByUser={controlledByUser}
                        onCollaborationModeChange={
                            codexCollaborationModeSupported && props.session.active && !controlledByUser
                                ? handleCollaborationModeChange
                                : undefined
                        }
                        onPermissionModeChange={handlePermissionModeChange}
                        selectedModelBase={
                            agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
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
                        serviceTier={agentFlavor === 'codex' ? props.session.serviceTier : undefined}
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
                        scratchlistMode={scratchlistMode}
                        scratchlistCount={scratchlist.entries.length}
                        onScratchlistToggle={handleScratchlistToggle}
                        sendError={props.sendError ?? null}
                        onClearSendError={props.onClearSendError}
                    />
                </DragDropZone>
            </AssistantRuntimeProvider>

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
