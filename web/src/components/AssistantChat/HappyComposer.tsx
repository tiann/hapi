import {
    getCodexCollaborationModeOptions,
    getCopilotAgentModeOptions,
    getPermissionModeOptionsForFlavor,
    type CopilotAgentMode
} from '@hapi/protocol'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { flushTapSync } from '@assistant-ui/tap'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type MutableRefObject,
    type SyntheticEvent as ReactSyntheticEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import { isRichComposerMentionsEnabled, resolveComposerPlaceholderKey } from '@/lib/composerSegments'
import type { SessionMentionResolveResult } from '@/components/AssistantChat/RichComposerInput'
import {
    RichComposerInput,
    type RichComposerInputHandle,
} from '@/components/AssistantChat/RichComposerInput'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'
import type { AgentState, CodexCollaborationMode, PermissionMode, PiModelSummary } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ConversationStatus } from '@/realtime/types'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { supportsEffort, supportsModelChange, PI_THINKING_LEVEL_LABELS } from '@hapi/protocol'
import type { PiThinkingLevel } from '@hapi/protocol'
import { markSkillUsed } from '@/lib/recent-skills'
import { useComposerDraft } from '@/hooks/useComposerDraft'
import { useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { ComposerParkingContext } from '@/components/AssistantChat/composerParkingContext'
import type { ScratchlistParkResult } from '@/lib/scratchlistAttachmentFlow'
import { useTranslation } from '@/lib/use-translation'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'
import { getDisplayedCodexServiceTier } from './codexFastMode'
import { getPiThinkingLevelOptions, getHighestThinkingLevel, isThinkingLevelSupported } from './piThinkingLevelOptions'
import { groupModelsByProvider } from './piModelGroups'
import { PiModelPanel } from './PiModelPanel'
import { PiThinkingLevelPanel } from './PiThinkingLevelPanel'
import type { ApiClient } from '@/api/client'
import { useVoiceInputPreferences } from '@/hooks/useVoiceInputPreferences'
import { useDictation } from '@/hooks/useDictation'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { MessageDeliveryMode } from '@hapi/protocol'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

export function getComposerEscapeAction(input: {
    hasSuggestions: boolean
    threadIsRunning: boolean
    isExpanded: boolean
}): 'clearSuggestions' | 'abort' | 'collapse' | null {
    if (input.hasSuggestions) return 'clearSuggestions'
    if (input.threadIsRunning) return 'abort'
    if (input.isExpanded) return 'collapse'
    return null
}

/**
 * One rejected send.  `id` is bumped per failure so two failures with the
 * same `text` still trigger a fresh restore (the dedupe key is the id, not
 * the text).
 *
 * - `text` is the original input that should be put back into the composer.
 * - `message` is the user-facing error string we render inline.
 * - `scheduledAt` is the absolute epoch-ms the rejected send was bound for,
 *   or null for an immediate send.  When non-null, the composer also
 *   restores the schedule via `onSchedule` so the operator can edit and
 *   retry without silently downgrading a scheduled send to immediate.
 * - `action` is an optional recovery affordance rendered as a button next
 *   to the message.  Used by the inactive-session branch (#918) to expose
 *   a one-click Reopen.  Other failure modes (5xx, network, generic 4xx)
 *   leave this null and only render the message.
 *
 * Owned by the route component (`router.tsx`); the composer is a pure
 * consumer that:
 *  1. restores the text once per `id` via `api.composer().setText`,
 *  2. restores the schedule (if any) via `onSchedule`, and
 *  3. shows a red ring + inline message until the user types or sends.
 */
export type ComposerSendError = {
    id: number
    text: string
    message: string
    scheduledAt: number | null
    /** False for guards that reject before the underlying message mutation starts. */
    mutationStarted: boolean
    /** Wire mode retained for retry/error provenance; composer rendering is mode-agnostic. */
    deliveryMode?: MessageDeliveryMode
    /** True once the user has retried; retain UI but never restore this id again. */
    restoreSuppressed: boolean
    action?: {
        label: string
        onClick: () => void
        pending?: boolean
    } | null
}

type RichComposerBridgeApi = {
    composer: () => {
        setText: (text: string) => void
    }
}

/**
 * The custom rich contenteditable must follow ComposerPrimitive.Input's
 * synchronous composer-write contract. Kept separate so its callback identity
 * is stable across unrelated HappyComposer renders and directly testable.
 */
export function useRichComposerBridge(
    api: RichComposerBridgeApi,
    setInputState: (state: TextInputState) => void,
    sendError: ComposerSendError | null,
    onClearSendError?: () => void,
    onUserEdit?: () => void,
) {
    const onValueChange = useCallback((text: string) => {
        flushTapSync(() => {
            api.composer().setText(text)
        })
    }, [api])

    const onMirrorChange = useCallback((state: TextInputState) => {
        setInputState(state)
    }, [setInputState])

    const onEdit = useCallback(() => {
        onUserEdit?.()
        if (sendError && onClearSendError) onClearSendError()
    }, [sendError, onClearSendError, onUserEdit])

    return { onValueChange, onMirrorChange, onEdit }
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

/** True when composer text/attachment ids match a pre-park snapshot. */
export function composerParkSnapshotUnchanged(
    snapshot: { text: string; attachments: readonly { id: string }[] },
    current: { text: string; attachments: readonly { id: string }[] },
): boolean {
    return current.text === snapshot.text
        && current.attachments.length === snapshot.attachments.length
        && current.attachments.every(
            (attachment, index) => attachment.id === snapshot.attachments[index]?.id,
        )
}

/**
 * Prefer session `selectedModelVariant` only when it is still among the rows
 * currently shown. After a multi-variant base switch, session state can lag
 * while `cursorDrillDownDefaultVariant` already points at the new base's
 * default — stale variants must not win highlight.
 */
export function resolveVisibleModelEffortSelectedValue(args: {
    options: ReadonlyArray<{ value: string }> | null | undefined
    selectedModelVariant?: string | null
    cursorDrillDownDefaultVariant?: string | null
    model?: string | null
}): string | null | undefined {
    const {
        options,
        selectedModelVariant,
        cursorDrillDownDefaultVariant,
        model
    } = args
    const selectedVisibleVariant = options?.some((option) => option.value === selectedModelVariant)
        ? selectedModelVariant
        : null
    return selectedVisibleVariant ?? cursorDrillDownDefaultVariant ?? model
}

export function ModelEffortSettingsSection(props: {
    agentFlavor?: string | null
    options: Array<{ value: string; label: string }>
    selectedValue: string | null | undefined
    controlsDisabled: boolean
    onChange: (value: string) => void
    /** Override the section title (e.g. Cursor base id during nested drill-down). */
    title?: string | null
    /** When set, show a back control above the title (Cursor nested variant drill-down). */
    onBack?: () => void
    backLabel?: string
}) {
    const { t } = useTranslation()
    const {
        agentFlavor,
        options,
        selectedValue,
        controlsDisabled,
        onChange,
        title,
        onBack,
        backLabel
    } = props

    const heading = title
        ?? (agentFlavor === 'cursor' ? t('misc.variant') : t('misc.effort'))

    return (
        <div className="py-2">
            {onBack ? (
                <button
                    type="button"
                    disabled={controlsDisabled}
                    className={`flex w-full items-center px-3 pb-1 text-left text-xs text-[var(--app-hint)] transition-colors ${
                        controlsDisabled
                            ? 'cursor-not-allowed opacity-50'
                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]'
                    }`}
                    onClick={onBack}
                    onMouseDown={(e) => e.preventDefault()}
                    aria-label={backLabel ?? t('misc.backToModelList')}
                >
                    {backLabel ?? t('misc.backToModelList')}
                </button>
            ) : null}
            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                {heading}
            </div>
            {options.map((option) => {
                const isSelected = selectedValue === option.value
                return (
                    <button
                        key={option.value}
                        type="button"
                        disabled={controlsDisabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            controlsDisabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => onChange(option.value)}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                isSelected
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {isSelected && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
                            {option.label}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

export function HappyComposer(props: {
    sessionId?: string
    disabled?: boolean
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    active?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    /** Model for the context-window heuristic; see StatusBar.contextModel. */
    contextModel?: string | null
    controlledByUser?: boolean
    agentFlavor?: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    /** Full Pi model data with thinkingLevelMap for provider grouping + thinking level filtering */
    piModels?: PiModelSummary[]
    /** Pi: provider-qualified selected model from metadata (survives reload;
     *  disambiguates when two providers share a modelId). */
    piSelectedModel?: { provider: string; modelId: string } | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    availableEffortOptions?: Array<{ value: string; name?: string }>
    /** Cursor: selected base model key (not wire id). */
    selectedModelBase?: string | null
    /** Cursor: selected variant sku/wire for highlight when session stores an ACP wire id. */
    selectedModelVariant?: string | null
    /** Cursor: effort/variant wire ids for the selected base model. */
    modelEffortOptions?: Array<{ value: string; label: string }>
    /** Cursor: variant rows for a base key (used for in-place drill-down before parent re-renders). */
    resolveModelVariantsForBase?: (baseKey: string) => readonly { value: string; label: string }[]
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    onCopilotAgentModeChange?: (mode: CopilotAgentMode) => void
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelChange?: (model: { provider: string; modelId: string } | string | null) => void
    /** Cursor: effort/variant wire id (separate from base model change). */
    onModelEffortChange?: (wireId: string | null) => void
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => void
    onEffortChange?: (effort: string | null) => void
    /** Codex Fast mode (service tier): current value ('fast' or null/standard). */
    serviceTier?: string | null
    /** When provided, a Fast-mode toggle renders (Codex GPT-5.5 / GPT-5.4 only). */
    onServiceTierChange?: (serviceTier: string | null) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    // Voice assistant props
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle?: () => void
    onVoiceMicToggle?: () => void
    voiceTranscriptionApi?: ApiClient
    // Schedule props (lifted from internal state when provided)
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    // Scratchlist drawer props - SessionChat owns the state. Threaded
    // straight through to ComposerButtons. When undefined, the toggle
    // button doesn't render (back-compat for any other consumer).
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    /**
     * Prepare a scratchlist park (migrate only). Caller validates the
     * composer snapshot, then commit()/abort()/beforeClear().
     */
    onParkScratchlist?: (
        text: string,
        pending: readonly import('@assistant-ui/react').Attachment[],
    ) => Promise<ScratchlistParkResult>
    /** Parent disables DragDropZone / scratchlist promote while park is in flight. */
    onScratchlistParkingChange?: (parking: boolean) => void
    // Set when the most recent send failed (4xx/5xx/network).  The composer
    // restores the original text once per `sendError.id` and renders an
    // inline error affordance until the user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    /** Emitted by SessionChat after a send is accepted. Null attempt ids are settled scratchlist sends. */
    sendAcceptance?: { attemptId: string | null } | null
    /** Terminal result for a chat mutation, including attachment-bearing failures. */
    sendSettlement?: { attemptId: string; status: 'success' | 'error' } | null
    /**
     * One-shot intent bridge consumed by useHappyRuntime's onNew callback.
     * SessionChat owns this ref so the composer never retains an explicit
     * queue request after a scratchlist/scheduled/failed early path.
     */
    pendingSendIntentRef?: MutableRefObject<ComposerSendIntent>
    /** Chip hover / aria-label resolver (SessionChat → useSessions). */
    resolveSessionMentionTooltip?: (id: string, title: string) => SessionMentionResolveResult
}) {
    const { t } = useTranslation()
    const {
        sessionId,
        disabled = false,
        permissionMode: rawPermissionMode,
        collaborationMode: rawCollaborationMode,
        copilotAgentMode: rawCopilotAgentMode,
        model: rawModel,
        modelReasoningEffort: rawModelReasoningEffort,
        effort: rawEffort,
        active = true,
        allowSendWhenInactive = false,
        thinking = false,
        agentState,
        backgroundTaskCount,
        contextSize,
        contextCacheRead,
        contextWindow,
        contextModel,
        controlledByUser = false,
        agentFlavor,
        availableModelOptions,
        piModels,
        piSelectedModel,
        availableModelReasoningEffortOptions,
        availableEffortOptions,
        selectedModelBase,
        selectedModelVariant,
        modelEffortOptions,
        resolveModelVariantsForBase,
        onCollaborationModeChange,
        onCopilotAgentModeChange,
        onPermissionModeChange,
        onModelChange,
        onModelEffortChange,
        onModelReasoningEffortChange,
        onEffortChange,
        serviceTier: rawServiceTier,
        onServiceTierChange,
        onSwitchToRemote,
        onTerminal,
        terminalUnsupported = false,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
        voiceStatus = 'disconnected',
        voiceMicMuted = false,
        onVoiceToggle,
        onVoiceMicToggle,
        pendingSchedule: pendingScheduleProp,
        onSchedule: onScheduleProp,
        onClearSchedule: onClearScheduleProp,
        sendError = null,
        onClearSendError,
        onSuppressSendErrorRestore,
        pendingSendIntentRef,
        resolveSessionMentionTooltip,
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const collaborationMode = rawCollaborationMode ?? 'default'
    const copilotAgentMode = rawCopilotAgentMode ?? 'interactive'
    const model = rawModel ?? null
    const modelReasoningEffort = rawModelReasoningEffort ?? null
    const effort = rawEffort ?? null
    const serviceTier = rawServiceTier ?? null
    const displayedServiceTier = getDisplayedCodexServiceTier(serviceTier)

    const api = useAui()
    const { composerEnterBehavior } = useComposerEnterBehavior()
    const composerText = useAuiState((s) => s.composer.text)
    const attachments = useAuiState((s) => s.composer.attachments)
    const threadIsRunning = useAuiState((s) => s.thread.isRunning)
    const threadIsDisabled = useAuiState((s) => s.thread.isDisabled)
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const getCurrentComposerText = useCallback(() => composerTextRef.current, [])
    const setComposerText = useCallback((text: string) => api.composer().setText(text), [api])
    const voiceInput = useVoiceInputPreferences(props.voiceTranscriptionApi ?? null)
    const dictationConfig = useMemo(() => ({
        api: props.voiceTranscriptionApi ?? null,
        provider: voiceInput.provider,
        mode: voiceInput.transcriptionMode,
        getCurrentText: getCurrentComposerText,
        onTextChange: setComposerText
    }), [
        props.voiceTranscriptionApi,
        voiceInput.provider,
        voiceInput.transcriptionMode,
        getCurrentComposerText,
        setComposerText
    ])
    const dictation = useDictation(dictationConfig)
    const dictationActive = voiceInput.voiceMode === 'dictation'
    const effectiveVoiceStatus = dictationActive ? dictation.status : voiceStatus
    const effectiveVoiceToggle = dictationActive
        ? (dictation.supported ? dictation.toggle : undefined)
        : onVoiceToggle
    const previousVoiceModeRef = useRef(voiceInput.voiceMode)
    useEffect(() => {
        if (previousVoiceModeRef.current === voiceInput.voiceMode) return
        previousVoiceModeRef.current = voiceInput.voiceMode
        if (dictationActive && (voiceStatus === 'connected' || voiceStatus === 'connecting')) {
            onVoiceToggle?.()
        } else if (!dictationActive && (dictation.status === 'connected' || dictation.status === 'connecting')) {
            void dictation.toggle()
        }
    }, [dictationActive, voiceInput.voiceMode, voiceStatus, onVoiceToggle, dictation.status, dictation.toggle])

    const [isParkingScratchlist, setIsParkingScratchlist] = useState(false)
    const parkInFlightRef = useRef(false)
    const onScratchlistParkingChange = props.onScratchlistParkingChange

    useEffect(() => {
        onScratchlistParkingChange?.(isParkingScratchlist)
    }, [isParkingScratchlist, onScratchlistParkingChange])

    const controlsDisabled = disabled || (!active && !allowSendWhenInactive) || threadIsDisabled || isParkingScratchlist
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasAttachments = attachments.length > 0
    const attachmentsReady = !hasAttachments || attachments.every((attachment) => {
        if (attachment.status.type === 'complete') {
            return true
        }
        if (attachment.status.type !== 'requires-action') {
            return false
        }
        const path = (attachment as { path?: string }).path
        return typeof path === 'string' && path.length > 0
    })
    const canSend = (hasText || hasAttachments) && attachmentsReady && !controlsDisabled

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [isExpanded, setIsExpanded] = useState(false)
    const lastSendAcceptanceRef = useRef(props.sendAcceptance)
    const pendingSendAttemptIdRef = useRef<string | null>(null)
    const [showSettings, setShowSettings] = useState(false)
    const [showPiModelPanel, setShowPiModelPanel] = useState(false)
    const [showPiThinkingPanel, setShowPiThinkingPanel] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    // pendingSchedule is controlled externally when onSchedule prop is provided; otherwise local state
    const [pendingScheduleLocal, setPendingScheduleLocal] = useState<PendingSchedule | null>(null)
    const isControlled = onScheduleProp !== undefined
    const pendingSchedule = isControlled ? (pendingScheduleProp ?? null) : pendingScheduleLocal
    const setPendingSchedule = isControlled ? onScheduleProp : setPendingScheduleLocal

    useEffect(() => {
        const acceptance = props.sendAcceptance
        if (!acceptance || acceptance === lastSendAcceptanceRef.current) return
        lastSendAcceptanceRef.current = acceptance
        if (acceptance.attemptId === null) {
            pendingSendAttemptIdRef.current = null
            setIsExpanded(false)
            return
        }
        pendingSendAttemptIdRef.current = acceptance.attemptId
        const settlement = props.sendSettlement
        if (!settlement || settlement.attemptId !== acceptance.attemptId) return
        pendingSendAttemptIdRef.current = null
        if (settlement.status === 'success') setIsExpanded(false)
    }, [props.sendAcceptance, props.sendSettlement])

    // Match the terminal mutation result to the exact accepted attempt. Text
    // failures also expose sendError for draft restoration, while attachment
    // failures intentionally do not, so settlement must be the outcome source.
    useEffect(() => {
        const settlement = props.sendSettlement
        if (!settlement || settlement.attemptId !== pendingSendAttemptIdRef.current) return
        pendingSendAttemptIdRef.current = null
        if (settlement.status === 'success') setIsExpanded(false)
    }, [props.sendSettlement])

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const richInputRef = useRef<RichComposerInputHandle>(null)
    const richComposerFueAnchorRef = useRef<HTMLDivElement>(null)
    // `composer.text === ''` alone is not enough to identify the empty state
    // created by a send. A user can type and delete a fresh draft before the
    // failed mutation reports back. Keep monotonic interaction generations so
    // history still wins over a visually identical empty composer.
    const userEditGenerationRef = useRef(0)
    const userScheduleGenerationRef = useRef(0)
    const userAttachmentGenerationRef = useRef(0)
    const observedAttachmentIdsRef = useRef(new Set(attachments.map((attachment) => attachment.id)))
    const sendRestoreGuardRef = useRef<{
        userEditGeneration: number
        userScheduleGeneration: number
        userAttachmentGeneration: number
    } | null>(null)
    // Kill-switch only (?richMentions=0 / localStorage=0 / VITE=false). Mount-time
    // read — hard reload required, so no per-keystroke localStorage/URL parse.
    const [richMentionsEnabled] = useState(() => isRichComposerMentionsEnabled())
    const {
        status: richComposerFueStatus,
        engage: engageRichComposerFue,
        dismiss: dismissRichComposerFue,
    } = useFue('rich-composer-mentions')
    const prevControlledByUser = useRef(controlledByUser)

    // Composer itself is the affordance: open the FUE callout once the rich
    // path is live. Relying on DOM focus alone is flaky (programmatic
    // autofocus / Playwright headless often skip the focus event).
    useEffect(() => {
        if (!richMentionsEnabled) return
        engageRichComposerFue()
    }, [richMentionsEnabled, engageRichComposerFue])

    const recordUserEdit = useCallback(() => {
        userEditGenerationRef.current += 1
    }, [])

    const handleUserEdit = useCallback(() => {
        recordUserEdit()
        // Editing the restored text is the operator's "I'm handling it"
        // signal -- drop the inline error so the affordance doesn't shout
        // at them while they fix the message.
        if (sendError && onClearSendError) {
            onClearSendError()
        }
    }, [recordUserEdit, sendError, onClearSendError])

    const {
        onValueChange: handleRichValueChange,
        onMirrorChange: handleRichMirrorChange,
        onEdit: handleRichEdit,
    } = useRichComposerBridge(api, setInputState, sendError, onClearSendError, recordUserEdit)

    const attachmentDrafts = attachments.flatMap((attachment) => {
        if (!attachment.file) return []
        const upload = attachment as typeof attachment & { path?: string; previewUrl?: string }
        return [{
            id: attachment.id,
            file: attachment.file,
            path: upload.path,
            previewUrl: upload.previewUrl,
        }]
    })
    const draftHydration = useComposerDraft(
        sessionId,
        composerText,
        attachmentDrafts,
        active,
        (text) => api.composer().setText(text),
        (file) => api.composer().addAttachment(file),
    )

    // assistant-ui clears `composer.text` synchronously the moment a send is
    // invoked AND `SessionChat.handleSend` clears `pendingSchedule` after the
    // mutation is accepted. A failure must put the text and absolute schedule
    // back as one atomic recovery unit, but only while the composer still
    // reflects that send's cleared state. A blank composer alone is not enough:
    // a user might type then delete a replacement draft before onError arrives.
    const restoredErrorIdRef = useRef<number | null>(null)
    const restoredErrorSnapshotRef = useRef<{ id: number; text: string; observed: boolean } | null>(null)
    useEffect(() => {
        if (!sendError || restoredErrorIdRef.current === sendError.id) {
            return
        }
        if (sendError.restoreSuppressed) {
            // Route retains the error UI for the retry attempt, but this id
            // must never repopulate a composer after a keyed remount.
            restoredErrorIdRef.current = sendError.id
            return
        }

        const guard = sendRestoreGuardRef.current
        // A resolved inactive session navigates to a keyed, fresh composer
        // before the target mutation can fail. That new instance has no local
        // send snapshot, but its zero mount-time generations still prove no
        // user interaction has happened there. Treat that as an implicit guard;
        // any edit, schedule interaction, or newly observed attachment makes
        // the error terminally unsafe just like the explicit snapshot path.
        if (!guard) {
            // The implicit guard is only for a keyed remount. Wait until the
            // session-keyed draft hydration has conclusively run: its RAF may
            // still restore a persisted replacement after this effect.
            if (draftHydration.sessionId !== sessionId || !draftHydration.complete) return
            if (draftHydration.restoredAny) {
                restoredErrorIdRef.current = sendError.id
                onClearSendError?.()
                return
            }
        }
        const interactionChanged = guard
            ? userEditGenerationRef.current !== guard.userEditGeneration
                || userScheduleGenerationRef.current !== guard.userScheduleGeneration
                || userAttachmentGenerationRef.current !== guard.userAttachmentGeneration
            : userEditGenerationRef.current !== 0
                || userScheduleGenerationRef.current !== 0
                || userAttachmentGenerationRef.current !== 0
        const textOrAttachmentChanged = composerText.length !== 0 || attachments.length !== 0

        if (interactionChanged || textOrAttachmentChanged) {
            // This error id is now conclusively unsafe. Do not retry if the
            // user later deletes their replacement text or attachment. Clear
            // route-level state as well: a remount otherwise loses this local
            // consumed marker and can replay the stale error over the draft.
            restoredErrorIdRef.current = sendError.id
            onClearSendError?.()
            return
        }

        if (sendError.mutationStarted && pendingSchedule !== null) {
            // SessionChat clears an accepted send's schedule asynchronously.
            // The mutation's onError can arrive before that parent render, so
            // wait for its null cleared state before restoring text + schedule
            // as one unit. User-selected schedules were rejected above by the
            // schedule generation check.
            return
        }

        restoredErrorIdRef.current = sendError.id
        restoredErrorSnapshotRef.current = { id: sendError.id, text: sendError.text, observed: false }
        api.composer().setText(sendError.text)
        // `scheduledAt` is already absolute (presets resolve at send time), so
        // restore it through the normal controlled schedule path in the same
        // effect as text. For a pre-mutation rejection this updates the still
        // present source schedule to its send-time absolute instant.
        if (sendError.scheduledAt !== null && onScheduleProp) {
            onScheduleProp({ type: 'absolute', ms: sendError.scheduledAt })
        }
    }, [sendError, api, attachments, composerText, draftHydration, onClearSendError, onScheduleProp, pendingSchedule, sessionId])

    // A successful automatic restore keeps its inline error visible so the
    // operator understands why the draft returned. If another path replaces
    // the restored text or inserts an attachment without firing a textarea or
    // rich-input event (scratchlist/queued/draft programmatic writes), consume
    // the route-level error before a keyed remount can replay it over that new
    // state. The exact restored text is intentionally exempt from this check.
    useEffect(() => {
        const restored = restoredErrorSnapshotRef.current
        if (!sendError || !restored || restored.id !== sendError.id) return
        if (!restored.observed) {
            if (composerText === restored.text && attachments.length === 0) {
                restored.observed = true
            }
            return
        }
        if (composerText === restored.text && attachments.length === 0) return
        onClearSendError?.()
    }, [sendError, attachments, composerText, onClearSendError])

    // A user-added attachment must make a recovery unsafe even if it is removed
    // again before the send error arrives. This runs even without a local send
    // guard so a post-resume composer gets the same protection. Attachment IDs
    // already present at mount are the baseline; assistant-ui's send clear only
    // removes IDs and therefore does not look like a user addition.
    useEffect(() => {
        for (const attachment of attachments) {
            if (observedAttachmentIdsRef.current.has(attachment.id)) continue
            observedAttachmentIdsRef.current.add(attachment.id)
            userAttachmentGenerationRef.current += 1
        }
    }, [attachments])

    useEffect(() => {
        if (richMentionsEnabled) {
            // Rich input owns mirror text + selection via onMirrorChange.
            return
        }
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText, richMentionsEnabled])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const { isStandalone, isIOS } = usePWAInstall()
    const isIOSPWA = isIOS && isStandalone
    const bottomPaddingClass = isIOSPWA ? 'pb-0' : 'pb-3'
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const handleExpandedToggle = useCallback(() => {
        const currentInput = textareaRef.current
        const selection = currentInput ? {
            start: currentInput.selectionStart,
            end: currentInput.selectionEnd,
            direction: currentInput.selectionDirection,
        } : null

        setIsExpanded((expanded) => !expanded)
        haptic('light')
        setTimeout(() => {
            if (richMentionsEnabled) {
                richInputRef.current?.focus()
                return
            }
            const input = textareaRef.current
            if (!input) return
            try {
                input.focus({ preventScroll: true })
            } catch {
                input.focus()
            }
            if (selection) {
                const maxOffset = input.value.length
                input.setSelectionRange(
                    Math.min(selection.start, maxOffset),
                    Math.min(selection.end, maxOffset),
                    selection.direction,
                )
            }
        }, 0)
    }, [haptic, richMentionsEnabled])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

        // Suggestions edit composer content programmatically, so neither the
        // textarea onChange nor RichComposerInput.onEdit sees this path.
        handleUserEdit()

        if (richMentionsEnabled && richInputRef.current) {
            // insert*/apply* emit mirror state via onMirrorChange (keep inputState in mirror space).
            if (suggestion.sessionMention) {
                richInputRef.current.insertSessionMention(
                    suggestion.sessionMention,
                    autocompletePrefixes
                )
            } else {
                richInputRef.current.applyPlainSuggestion(
                    suggestion.text,
                    autocompletePrefixes
                )
            }
            setTimeout(() => {
                richInputRef.current?.focus()
            }, 0)
            haptic('light')
            return
        }

        if (!textareaRef.current) return

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            autocompletePrefixes,
            true
        )

        api.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(result.cursorPosition, result.cursorPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)

        haptic('light')
    }, [api, suggestions, inputState, autocompletePrefixes, haptic, richMentionsEnabled, handleUserEdit])

    const abortDisabled = controlsDisabled || isAborting || !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal || terminalUnsupported)
    const terminalDisabled = controlsDisabled || terminalUnsupported
    const terminalLabel = terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal')

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )
    const collaborationModeOptions = useMemo(
        () => agentFlavor === 'codex' ? getCodexCollaborationModeOptions() : [],
        [agentFlavor]
    )
    const copilotAgentModeOptions = useMemo(
        () => agentFlavor === 'copilot' ? getCopilotAgentModeOptions() : [],
        [agentFlavor]
    )
    const modelOptions = useMemo(
        () => getModelOptionsForFlavor(agentFlavor, model, availableModelOptions),
        [agentFlavor, model, availableModelOptions]
    )

    // Cursor dual picker: after choosing a multi-variant base, drill into variant
    // rows in-place (picker stays open). Variant pick dismisses; back returns to
    // the full base list.
    const [cursorDrillDownBase, setCursorDrillDownBase] = useState<string | null>(null)
    const [cursorDrillDownDefaultVariant, setCursorDrillDownDefaultVariant] = useState<string | null>(null)
    useEffect(() => {
        if (!selectedModelBase || selectedModelBase === 'auto') {
            setCursorDrillDownBase(null)
            setCursorDrillDownDefaultVariant(null)
        }
    }, [selectedModelBase])

    const cursorDrillDownVariantOptions = useMemo(() => {
        if (!cursorDrillDownBase || !resolveModelVariantsForBase) {
            return null
        }
        const options = resolveModelVariantsForBase(cursorDrillDownBase)
        return options.length > 1 ? options : null
    }, [cursorDrillDownBase, resolveModelVariantsForBase])

    const cursorVariantDrillDownActive = agentFlavor === 'cursor' && cursorDrillDownVariantOptions !== null

    const visibleModelEffortOptions = cursorDrillDownVariantOptions ?? modelEffortOptions
    const codexReasoningEffortOptions = useMemo(
        () => agentFlavor === 'codex' || agentFlavor === 'opencode'
            ? getCodexComposerReasoningEffortOptions(
                modelReasoningEffort,
                agentFlavor,
                availableModelReasoningEffortOptions
            )
            : [],
        [agentFlavor, modelReasoningEffort, availableModelReasoningEffortOptions]
    )
    // Pi: group models by provider for hierarchical display
    const piModelGroups = useMemo(
        () => piModels && piModels.length > 0 ? groupModelsByProvider(piModels) : null,
        [piModels]
    )
    // Pi: find the currently selected model's thinkingLevelMap for effort filtering.
    // Prefer provider-qualified match (metadata.piSelectedModel) when available —
    // two providers may share a modelId, and a modelId-only match would pick the
    // wrong one, sending the wrong provider on the next model/effort change.
    const selectedPiModel = useMemo(
        () => piSelectedModel
            ? piModels?.find((m) => m.provider === piSelectedModel.provider && m.modelId === piSelectedModel.modelId)
            : piModels?.find((m) => m.modelId === model),
        [piModels, piSelectedModel, model]
    )

    // Pi: reset effort to highest supported level when model changes and current level is unsupported
    useEffect(() => {
        if (!effort || !selectedPiModel || !onEffortChange) return
        // Non-reasoning model: clear stale effort so the hub does not forward
        // a set_thinking_level the user can no longer see or change.
        if (selectedPiModel.reasoning === false) {
            onEffortChange(null)
            return
        }
        if (!isThinkingLevelSupported(effort, selectedPiModel.thinkingLevelMap)) {
            onEffortChange(getHighestThinkingLevel(selectedPiModel.thinkingLevelMap))
        }
    }, [selectedPiModel, effort, onEffortChange])
    const claudeEffortOptions = useMemo(
        () => agentFlavor === 'pi'
            ? getPiThinkingLevelOptions(effort, selectedPiModel?.thinkingLevelMap)
            : agentFlavor === 'grok' && availableEffortOptions && availableEffortOptions.length > 0
                ? [
                    { value: null, label: 'Default' },
                    ...availableEffortOptions.map((option) => ({
                        value: option.value,
                        label: option.name ?? option.value
                    }))
                ]
            : getClaudeComposerEffortOptions(effort),
        [agentFlavor, effort, selectedPiModel, availableEffortOptions]
    )
    const permissionModes = useMemo(
        () => permissionModeOptions.map((option) => option.mode),
        [permissionModeOptions]
    )

    const handleUserSchedule = useCallback((nextPendingSchedule: PendingSchedule) => {
        userScheduleGenerationRef.current += 1
        if (sendError) onClearSendError?.()
        setPendingSchedule(nextPendingSchedule)
    }, [onClearSendError, sendError, setPendingSchedule])

    const handleUserClearSchedule = useCallback(() => {
        userScheduleGenerationRef.current += 1
        if (sendError) onClearSendError?.()
        if (isControlled) {
            onClearScheduleProp?.()
        } else {
            setPendingScheduleLocal(null)
        }
    }, [isControlled, onClearScheduleProp, onClearSendError, sendError])
    // Preserve the original controlled-mode contract: without a parent clear
    // handler the schedule button opens the picker instead of claiming it can
    // clear a value it does not own.
    const onUserClearSchedule = isControlled && !onClearScheduleProp
        ? undefined
        : handleUserClearSchedule

    const resetPendingSendIntent = useCallback(() => {
        if (pendingSendIntentRef) pendingSendIntentRef.current = 'default'
    }, [pendingSendIntentRef])

    const handleSend = useCallback(async (intent: ComposerSendIntent = 'default') => {
        // SessionChat preloads the ref only when restoring a rejected send:
        // queue retries remain queue, while an ordinary fresh send always
        // starts from the explicit/default argument. Capture it before the
        // mandatory early-path reset below, then consume it at send time.
        const restoredIntent = intent === 'default'
            ? (pendingSendIntentRef?.current ?? 'default')
            : intent
        // The runtime consumes this ref from assistant-ui's onNew callback.
        // Clear any prior one-shot value before paths that do not call send(),
        // so a rejected park/schedule path can never leak a stale queue intent
        // into the next normal submission.
        resetPendingSendIntent()

        // Rich chips must be serialized into composer.text before any send or
        // scratchlist park snapshot (RichComposerInput contract).
        if (richMentionsEnabled && richInputRef.current) {
            richInputRef.current.flushSerializedText()
        }

        // Scratchlist parks must not go through assistant-ui's send(): it
        // empties text/chips before onNew, so a rejected add cannot restore
        // retryable composer state (#1226 Major).
        if (
            props.scratchlistMode
            && pendingSchedule == null
            && props.onParkScratchlist
        ) {
            if (!canSend || parkInFlightRef.current) return
            parkInFlightRef.current = true
            setIsParkingScratchlist(true)
            try {
                const snapshot = api.composer().getState()
                const prepared = await props.onParkScratchlist(
                    snapshot.text,
                    snapshot.attachments,
                )
                if (!prepared) return
                // Validate before irreversible add — otherwise a mid-flight
                // composer edit leaves a parked duplicate while chips remain.
                if (!composerParkSnapshotUnchanged(snapshot, api.composer().getState())) {
                    await prepared.abort()
                    return
                }
                if (!await prepared.commit()) {
                    return
                }
                await prepared.beforeClear()
                api.composer().setText('')
                await api.composer().clearAttachments()
                setIsExpanded(false)
            } finally {
                parkInFlightRef.current = false
                setIsParkingScratchlist(false)
            }
            return
        }
        // A retry intentionally clears composer state synchronously. It is
        // neither a replacement draft nor a dismissal: route onSuccess/onError
        // owns the inline-error transition for this new attempt. Drop the old
        // restore watcher before the clear so it cannot consume that error.
        restoredErrorSnapshotRef.current = null
        if (sendError) onSuppressSendErrorRestore?.(sendError.id)
        sendRestoreGuardRef.current = {
            userEditGeneration: userEditGenerationRef.current,
            userScheduleGeneration: userScheduleGenerationRef.current,
            userAttachmentGeneration: userAttachmentGenerationRef.current,
        }
        // Scheduled sends retain their existing route. The same is true for a
        // scratchlist route above; only an immediate chat submit may carry the
        // explicit queue intent to SessionChat.
        const effectiveIntent = pendingSchedule == null ? restoredIntent : 'default'
        try {
            // Must be adjacent to send(): useHappyRuntime consumes and resets
            // this ref synchronously from assistant-ui's onNew callback.
            if (pendingSendIntentRef) pendingSendIntentRef.current = effectiveIntent
            api.composer().send()
        } catch (error) {
            resetPendingSendIntent()
            throw error
        }
        // SessionChat owns clearing the schedule — it clears only after awaiting
        // the send hook's accepted result, which covers both pre-mutation guards
        // and async inactive-session resume failure. Clearing here unconditionally
        // would race ahead of that check and drop the user's schedule on every
        // rejected send path.
        //
        // The inline send-error affordance is intentionally NOT cleared here:
        // the route-level state (`onSuccess`/`onError` in router.tsx) replaces
        // or clears it based on the actual mutation result, so the user keeps
        // the error context while the new attempt is in flight.
    }, [
        api,
        attachments,
        canSend,
        onSuppressSendErrorRestore,
        pendingSchedule,
        props.onParkScratchlist,
        props.scratchlistMode,
        richMentionsEnabled,
        sendError,
        pendingSendIntentRef,
        resetPendingSendIntent,
    ])

    const flushAndSend = useCallback((intent: ComposerSendIntent = 'default') => {
        void handleSend(intent)
    }, [handleSend])

    const canQueueSend = agentFlavor === 'pi'
        && thinking
        && threadIsRunning
        && pendingSchedule == null
        && !props.scratchlistMode

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        // Shift+Enter inserts a newline (textarea default; rich path inserts <br>).
        if (key === 'Enter' && e.shiftKey) {
            return
        }

        // Enter with suggestions visible: select the suggestion
        if (key === 'Enter' && suggestions.length > 0) {
            e.preventDefault()
            const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
            handleSuggestionSelect(indexToSelect)
            return
        }

        // Alt/Option+Enter is an explicit Pi follow-up request. It is
        // orthogonal to the normal Enter preference but never overrides IME,
        // Shift+Enter, autocomplete, scheduling, or scratchlist routing.
        if (
            key === 'Enter'
            && e.altKey
            && !e.ctrlKey
            && !e.metaKey
            && canQueueSend
        ) {
            e.preventDefault()
            flushAndSend('queue')
            setShowContinueHint(false)
            return
        }

        // Only plain Enter (no modifiers) sends; other modifier combos are ignored
        if (key === 'Enter') {
            if (composerEnterBehavior === 'newline') {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && canSend) {
                    e.preventDefault()
                    flushAndSend()
                    setShowContinueHint(false)
                }
                return
            }
            e.preventDefault()
            if (!e.ctrlKey && !e.altKey && !e.metaKey && canSend) {
                flushAndSend()
                setShowContinueHint(false)
            }
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if ((key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
        }

        if (key === 'Escape') {
            // FUE callout also listens on window; dismiss it first so Escape
            // does not also abort a running thread or collapse the editor.
            if (richComposerFueStatus === 'engaging') {
                e.preventDefault()
                e.stopPropagation()
                dismissRichComposerFue()
                return
            }
            const action = getComposerEscapeAction({
                hasSuggestions: suggestions.length > 0,
                threadIsRunning,
                isExpanded,
            })
            if (action) {
                e.preventDefault()
                if (action === 'clearSuggestions') clearSuggestions()
                else if (action === 'abort') handleAbort()
                else handleExpandedToggle()
                return
            }
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 0) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'default'
            onPermissionModeChange(nextMode)
            haptic('light')
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        canSend,
        handleSend,
        haptic,
        composerEnterBehavior,
        richMentionsEnabled,
        richComposerFueStatus,
        dismissRichComposerFue,
        flushAndSend,
        canQueueSend,
        isExpanded,
        handleExpandedToggle,
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            // Pi needs { provider, modelId } to disambiguate duplicate model IDs,
            // but this generic cycler only emits a bare modelId (or null), which
            // would lose the provider and can pick the wrong cached match or clear
            // the model. Pi model changes go only through the dedicated PiModelPanel.
            if (agentFlavor === 'pi') return
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelChange && supportsModelChange(agentFlavor)) {
                e.preventDefault()
                onModelChange(getNextModelForFlavor(agentFlavor, model, availableModelOptions))
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [model, onModelChange, haptic, agentFlavor, availableModelOptions])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setInputState({ text: e.target.value, selection })
        handleUserEdit()
    }, [handleUserEdit])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        const files = Array.from(e.clipboardData?.files || [])
        const imageFiles = files.filter(file => file.type.startsWith('image/'))

        if (imageFiles.length === 0) return

        // The backend rejects scheduledAt + attachments (per-CLI upload dir is
        // torn down before a mature emit could read the files). The button-based
        // attachment flow is disabled by ComposerButtons.hasAttachments, but the
        // paste path bypasses that — guard here so a pasted image while a
        // schedule is active cannot produce a submission the hub will reject.
        if (pendingSchedule != null) {
            e.preventDefault()
            return
        }

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api, pendingSchedule])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings((prev) => {
            if (prev) {
                setCursorDrillDownBase(null)
                setCursorDrillDownDefaultVariant(null)
            }
            return !prev
        })
    }, [haptic])

    const clearCursorDrillDown = useCallback(() => {
        setCursorDrillDownBase(null)
        setCursorDrillDownDefaultVariant(null)
    }, [])

    const dismissSettings = useCallback(() => {
        clearCursorDrillDown()
        setShowSettings(false)
    }, [clearCursorDrillDown])

    const handleModelChange = useCallback((nextModel: { provider: string; modelId: string } | string | null) => {
        if (!onModelChange || controlsDisabled) return
        onModelChange(nextModel)
        dismissSettings()
        haptic('light')
    }, [onModelChange, controlsDisabled, haptic, dismissSettings])

    const handleCursorModelRowClick = useCallback((nextModel: string | null) => {
        if (!onModelChange || controlsDisabled) return

        const variants = nextModel && nextModel !== 'auto' && resolveModelVariantsForBase
            ? resolveModelVariantsForBase(nextModel)
            : []

        const isMultiVariantBasePick = selectedModelBase !== undefined
            && nextModel !== null
            && nextModel !== 'auto'
            && !nextModel.includes('[')
            && variants.length > 1

        if (isMultiVariantBasePick) {
            setCursorDrillDownBase(nextModel)
            setCursorDrillDownDefaultVariant(variants[0]?.value ?? null)
            onModelChange(nextModel)
            haptic('light')
            return
        }

        onModelChange(nextModel)
        dismissSettings()
        haptic('light')
    }, [
        onModelChange,
        controlsDisabled,
        resolveModelVariantsForBase,
        selectedModelBase,
        haptic,
        dismissSettings
    ])

    const handleModelEffortChange = useCallback((nextWireId: string | null) => {
        const handler = onModelEffortChange ?? onModelChange
        if (!handler || controlsDisabled) return
        handler(nextWireId)
        dismissSettings()
        haptic('light')
    }, [onModelEffortChange, onModelChange, controlsDisabled, haptic, dismissSettings])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        event?.preventDefault()
        if (!attachmentsReady) {
            return
        }
        setShowContinueHint(false)
    }, [attachmentsReady])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic, dismissSettings])

    const handleCollaborationChange = useCallback((mode: CodexCollaborationMode) => {
        if (!onCollaborationModeChange || controlsDisabled) return
        onCollaborationModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onCollaborationModeChange, controlsDisabled, haptic, dismissSettings])

    const handleCopilotAgentModeChange = useCallback((mode: CopilotAgentMode) => {
        if (!onCopilotAgentModeChange || controlsDisabled) return
        onCopilotAgentModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onCopilotAgentModeChange, controlsDisabled, haptic, dismissSettings])

    const handleModelReasoningEffortChange = useCallback((nextModelReasoningEffort: string | null) => {
        if (!onModelReasoningEffortChange || controlsDisabled) return
        onModelReasoningEffortChange(nextModelReasoningEffort)
        dismissSettings()
        haptic('light')
    }, [onModelReasoningEffortChange, controlsDisabled, haptic, dismissSettings])

    const handleEffortChange = useCallback((nextEffort: string | null) => {
        if (!onEffortChange || controlsDisabled) return
        onEffortChange(nextEffort)
        dismissSettings()
        haptic('light')
    }, [onEffortChange, controlsDisabled, haptic, dismissSettings])

    const handleServiceTierChange = useCallback((nextServiceTier: string | null) => {
        if (!onServiceTierChange || controlsDisabled) return
        onServiceTierChange(nextServiceTier)
        dismissSettings()
        haptic('light')
    }, [onServiceTierChange, controlsDisabled, haptic, dismissSettings])

    // 'standard' (not null) is the explicit Fast-off choice so it persists
    // distinctly from an untouched/account-default session.
    const fastModeOptions: Array<{ value: string; label: string }> = useMemo(() => [
        { value: 'standard', label: t('misc.fastModeStandard') },
        { value: 'fast', label: t('misc.fastModeFast') }
    ], [t])

    const showCollaborationSettings = Boolean(onCollaborationModeChange && collaborationModeOptions.length > 0)
    const showCopilotAgentModeSettings = Boolean(onCopilotAgentModeChange && copilotAgentModeOptions.length > 0)
    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelChange && supportsModelChange(agentFlavor) && (piModels && piModels.length > 0 || modelOptions.length > 0))
        && !cursorVariantDrillDownActive
    const showModelEffortSettings = cursorVariantDrillDownActive
        ? Boolean((onModelEffortChange ?? onModelChange) && visibleModelEffortOptions && visibleModelEffortOptions.length > 0)
        : Boolean(
            (onModelEffortChange ?? onModelChange)
            && modelEffortOptions
            && modelEffortOptions.length > 1
        )
    const showModelReasoningEffortSettings = Boolean(onModelReasoningEffortChange && codexReasoningEffortOptions.length > 0)
    // For Pi: hide effort when selected model explicitly has reasoning: false
    const piEffortHidden = piModels && selectedPiModel && selectedPiModel.reasoning === false
    const showEffortSettings = Boolean(onEffortChange && supportsEffort(agentFlavor) && !piEffortHidden)
    const showFastModeSettings = Boolean(onServiceTierChange)
    const showSettingsButton = Boolean(
        showCollaborationSettings
        || showCopilotAgentModeSettings
        || showPermissionSettings
        || showModelSettings
        || showModelEffortSettings
        || showModelReasoningEffortSettings
        || showEffortSettings
        || showFastModeSettings
    )
    const showAbortButton = true
    const voiceEnabled = Boolean(effectiveVoiceToggle)

    // Pi: selected model info for UI labels and thinking level filtering
    const piModelLabel = agentFlavor === 'pi'
        ? (selectedPiModel?.name ?? selectedPiModel?.modelId ?? 'Model')
        : undefined
    const piThinkingLabel = agentFlavor === 'pi'
        ? (() => {
            if (!selectedPiModel) return 'Thinking'
            const effectiveLevel = effort && isThinkingLevelSupported(effort, selectedPiModel.thinkingLevelMap)
                ? effort
                : getHighestThinkingLevel(selectedPiModel.thinkingLevelMap)
            return effectiveLevel
                ? (PI_THINKING_LEVEL_LABELS[effectiveLevel as PiThinkingLevel] ?? effectiveLevel)
                : 'Thinking'
        })()
        : undefined
    const piHasModels = piModels && piModels.length > 0

    const closeAllPanels = useCallback(() => {
        clearCursorDrillDown()
        setShowSettings(false)
        setShowPiModelPanel(false)
        setShowPiThinkingPanel(false)
    }, [clearCursorDrillDown])

    const handlePiModelToggle = useCallback(() => {
        if (controlsDisabled) return
        setShowPiModelPanel((v) => !v)
        setShowSettings(false)
        setShowPiThinkingPanel(false)
        haptic('light')
    }, [controlsDisabled, haptic])

    const handlePiThinkingToggle = useCallback(() => {
        if (controlsDisabled) return
        setShowPiThinkingPanel((v) => !v)
        setShowSettings(false)
        setShowPiModelPanel(false)
        haptic('light')
    }, [controlsDisabled, haptic])

    const overlayPositionClass = isExpanded
        ? 'absolute z-10 bottom-12 mb-2'
        : 'absolute z-10 bottom-[100%] mb-2'

    const overlays = useMemo(() => {
        // Pi flavor: separate floating panels for model and thinking level.
        // (Pi RPC mode has no runtime permission switching → no permission panel.)
        if (agentFlavor === 'pi') {
            const panels: React.ReactNode[] = []

            // Model selection panel
            if (showPiModelPanel && piModels && piModels.length > 0) {
                const currentPiModel = selectedPiModel ?? null
                panels.push(
                    <div key="model" className={`${overlayPositionClass} left-2 w-64`}>
                        <PiModelPanel
                            models={piModels}
                            currentModel={currentPiModel ? { provider: currentPiModel.provider, modelId: currentPiModel.modelId } : null}
                            controlsDisabled={controlsDisabled}
                            onSelect={(piModel) => {
                                handleModelChange({ provider: piModel.provider, modelId: piModel.modelId })
                            }}
                            onClose={closeAllPanels}
                        />
                    </div>
                )
            }

            // Thinking level panel
            if (showPiThinkingPanel && selectedPiModel?.reasoning !== false) {
                panels.push(
                    <div key="thinking" className={`${overlayPositionClass} left-2 w-48`}>
                        <PiThinkingLevelPanel
                            currentLevel={effort}
                            reasoning={selectedPiModel?.reasoning}
                            thinkingLevelMap={selectedPiModel?.thinkingLevelMap}
                            controlsDisabled={controlsDisabled}
                            onSelect={(level) => handleEffortChange(level)}
                            onClose={closeAllPanels}
                        />
                    </div>
                )
            }

            if (panels.length > 0) return <>{panels}</>
        }

        // Non-Pi flavors: original unified gear menu
        if (showSettings && (showCollaborationSettings || showCopilotAgentModeSettings || showPermissionSettings || showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings || showEffortSettings || showFastModeSettings)) {
            return (
                <div className={`${overlayPositionClass} w-full`}>
                    <FloatingOverlay maxHeight={320}>
                        {showCollaborationSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.collaborationMode')}
                                </div>
                                {collaborationModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleCollaborationChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                collaborationMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {collaborationMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={collaborationMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showCopilotAgentModeSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.copilotAgentMode')}
                                </div>
                                {copilotAgentModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleCopilotAgentModeChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                copilotAgentMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {copilotAgentMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={copilotAgentMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {(showCollaborationSettings || showCopilotAgentModeSettings) && (showPermissionSettings || showModelSettings || showModelReasoningEffortSettings || showEffortSettings) ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showPermissionSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.permissionMode')}
                                </div>
                                {permissionModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handlePermissionChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                permissionMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {permissionMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={permissionMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {(showCollaborationSettings || showCopilotAgentModeSettings || showPermissionSettings) && (showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings || showEffortSettings) ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.model')}
                                </div>
                                {piModelGroups ? (
                                    piModelGroups.map((group) => (
                                        <div key={group.provider}>
                                            <div className="px-3 pt-2 pb-0.5 text-xs font-medium text-[var(--app-hint)]">
                                                {group.label}
                                            </div>
                                            {group.models.map((piModel) => (
                                                <button
                                                    key={piModel.modelId}
                                                    type="button"
                                                    disabled={controlsDisabled}
                                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                        controlsDisabled
                                                            ? 'cursor-not-allowed opacity-50'
                                                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                    }`}
                                                    onClick={() => handleModelChange({ provider: piModel.provider, modelId: piModel.modelId })}
                                                    onMouseDown={(e) => e.preventDefault()}
                                                >
                                                    <div
                                                        className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                            model === piModel.modelId
                                                                ? 'border-[var(--app-link)]'
                                                                : 'border-[var(--app-hint)]'
                                                    }`}
                                                    >
                                                        {model === piModel.modelId && (
                                                            <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                        )}
                                                    </div>
                                                    <span className={model === piModel.modelId ? 'text-[var(--app-link)]' : ''}>
                                                        {piModel.name ?? piModel.modelId}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    ))
                                ) : (
                                    modelOptions.map((option) => {
                                        const isSelected = selectedModelBase !== undefined
                                            ? selectedModelBase === option.value
                                            : model === option.value
                                        return (
                                        <button
                                            key={option.value ?? 'auto'}
                                            type="button"
                                            disabled={controlsDisabled}
                                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                controlsDisabled
                                                    ? 'cursor-not-allowed opacity-50'
                                                    : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                            }`}
                                            onClick={() => {
                                                if (resolveModelVariantsForBase) {
                                                    handleCursorModelRowClick(option.value)
                                                } else {
                                                    handleModelChange(option.value)
                                                }
                                            }}
                                            onMouseDown={(e) => e.preventDefault()}
                                        >
                                            <div
                                                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                    isSelected
                                                        ? 'border-[var(--app-link)]'
                                                        : 'border-[var(--app-hint)]'
                                                }`}
                                            >
                                                {isSelected && (
                                                    <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                )}
                                            </div>
                                            <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
                                                {option.label}
                                            </span>
                                        </button>
                                        )
                                    })
                                )}
                            </div>
                        ) : null}

                        {showModelSettings && showModelEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelEffortSettings ? (
                            <ModelEffortSettingsSection
                                agentFlavor={agentFlavor}
                                options={[...(visibleModelEffortOptions ?? [])]}
                                selectedValue={resolveVisibleModelEffortSelectedValue({
                                    options: visibleModelEffortOptions,
                                    selectedModelVariant,
                                    cursorDrillDownDefaultVariant,
                                    model
                                })}
                                controlsDisabled={controlsDisabled}
                                onChange={handleModelEffortChange}
                                title={cursorVariantDrillDownActive && cursorDrillDownBase
                                    ? cursorDrillDownBase
                                    : undefined}
                                onBack={cursorVariantDrillDownActive ? clearCursorDrillDown : undefined}
                            />
                        ) : null}

                        {(showModelSettings || showModelEffortSettings) && showModelReasoningEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelReasoningEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.reasoningEffort')}
                                </div>
                                {codexReasoningEffortOptions.map((option) => (
                                    <button
                                        key={option.value ?? 'default'}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleModelReasoningEffortChange(option.value)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                modelReasoningEffort === option.value
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {modelReasoningEffort === option.value && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={modelReasoningEffort === option.value ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showModelReasoningEffortSettings && showEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.effort')}
                                </div>
                                {claudeEffortOptions.map((option) => (
                                    <button
                                        key={option.value ?? 'auto'}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleEffortChange(option.value)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                effort === option.value
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {effort === option.value && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={effort === option.value ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {(showModelReasoningEffortSettings || showEffortSettings) && showFastModeSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showFastModeSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.fastMode')}
                                </div>
                                {fastModeOptions.map((option) => (
                                    <button
                                        key={option.value ?? 'standard'}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleServiceTierChange(option.value)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                displayedServiceTier === option.value
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {displayedServiceTier === option.value && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={displayedServiceTier === option.value ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </FloatingOverlay>
                </div>
            )
        }

        if (suggestions.length > 0) {
            return (
                <div className={`${overlayPositionClass} w-full`}>
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        showSettings,
        showPiModelPanel,
        showPiThinkingPanel,
        agentFlavor,
        piModels,
        selectedPiModel,
        closeAllPanels,
        showCollaborationSettings,
        showCopilotAgentModeSettings,
        showPermissionSettings,
        showModelSettings,
        showModelEffortSettings,
        visibleModelEffortOptions,
        cursorVariantDrillDownActive,
        cursorDrillDownBase,
        cursorDrillDownDefaultVariant,
        modelEffortOptions,
        piModelGroups,
        selectedModelBase,
        selectedModelVariant,
        showModelReasoningEffortSettings,
        showEffortSettings,
        showFastModeSettings,
        agentFlavor,
        modelOptions,
        codexReasoningEffortOptions,
        claudeEffortOptions,
        fastModeOptions,
        suggestions,
        selectedIndex,
        controlsDisabled,
        collaborationMode,
        permissionMode,
        model,
        modelReasoningEffort,
        effort,
        displayedServiceTier,
        collaborationModeOptions,
        copilotAgentModeOptions,
        permissionModeOptions,
        handleCollaborationChange,
        handleCopilotAgentModeChange,
        copilotAgentMode,
        handlePermissionChange,
        handleModelChange,
        handleCursorModelRowClick,
        handleModelEffortChange,
        handleModelReasoningEffortChange,
        handleEffortChange,
        handleServiceTierChange,
        clearCursorDrillDown,
        resolveModelVariantsForBase,
        handleSuggestionSelect,
        overlayPositionClass,
        t
    ])

    const shellClassName = isExpanded
        ? `z-[60] flex min-h-0 flex-col bg-[var(--app-bg)] px-3 ${bottomPaddingClass} max-sm:fixed max-sm:inset-x-0 max-sm:top-0 max-sm:h-[var(--tg-viewport-stable-height,var(--app-viewport-height,100dvh))] max-sm:pt-[calc(0.5rem+env(safe-area-inset-top))] sm:absolute sm:inset-0 sm:pt-2`
        : `bg-[var(--app-bg)] px-3 ${bottomPaddingClass} pt-2`
    const innerClassName = isExpanded
        ? 'mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col'
        : 'mx-auto w-full max-w-content'
    const rootClassName = isExpanded
        ? 'relative flex min-h-0 flex-1 flex-col'
        : 'relative'
    const editorClassName = isExpanded
        ? 'h-full min-h-[1.5rem] flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-base leading-snug text-[var(--app-fg)] focus:outline-none'
        : 'max-h-[7.5rem] min-h-[1.5rem] flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-base leading-snug text-[var(--app-fg)] focus:outline-none'

    return (
        <ComposerParkingContext.Provider value={isParkingScratchlist}>
        <div className={shellClassName} data-testid="composer-shell" data-expanded={isExpanded || undefined}>
            <div className={innerClassName}>
                <ComposerPrimitive.Root className={rootClassName} onSubmit={handleSubmit}>
                    {overlays}

                    <StatusBar
                        active={active}
                        thinking={thinking}
                        agentState={agentState}
                        backgroundTaskCount={backgroundTaskCount}
                        contextSize={contextSize}
                        contextCacheRead={contextCacheRead}
                        contextWindow={contextWindow}
                        contextModel={contextModel}
                        model={model}
                        modelReasoningEffort={modelReasoningEffort}
                        effort={effort}
                        serviceTier={serviceTier}
                        permissionMode={permissionMode}
                        collaborationMode={collaborationMode}
                        copilotAgentMode={copilotAgentMode}
                        agentFlavor={agentFlavor}
                        voiceStatus={effectiveVoiceStatus}
                    />

                    {dictationActive && dictation.partialTranscript ? (
                        <div
                            role="status"
                            aria-live="polite"
                            className="mb-2 max-h-20 overflow-y-auto rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                        >
                            {dictation.partialTranscript}
                        </div>
                    ) : null}

                    {dictationActive && dictation.error ? (
                        <div role="alert" className="mb-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-red-600">
                            {dictation.error}
                        </div>
                    ) : null}

                    {sendError ? (
                        <div
                            role="alert"
                            data-testid="composer-send-error"
                            className="mb-2 flex items-center justify-between gap-3 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-red-600"
                        >
                            <span className="flex-1">{sendError.message}</span>
                            {sendError.action ? (
                                <button
                                    type="button"
                                    data-testid="composer-send-error-action"
                                    onClick={sendError.action.onClick}
                                    disabled={sendError.action.pending}
                                    className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {sendError.action.label}
                                </button>
                            ) : null}
                        </div>
                    ) : null}

                    <div
                        className={`overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)] ${
                            isExpanded ? 'flex min-h-0 flex-1 flex-col' : ''
                        } ${
                            sendError ? 'ring-1 ring-red-500' : ''
                        }`}
                    >
                        {attachments.length > 0 ? (
                            <div className={`flex flex-wrap gap-2 px-4 pt-3 ${
                                isExpanded ? 'max-h-[35%] shrink-0 overflow-y-auto' : ''
                            }`}>
                                <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                            </div>
                        ) : null}

                        <div className={`flex px-4 py-3 ${
                            isExpanded ? 'min-h-0 flex-1 items-stretch' : 'items-center'
                        }`}>
                            {richMentionsEnabled ? (
                                <div
                                    ref={richComposerFueAnchorRef}
                                    className="relative flex min-w-0 flex-1"
                                    data-testid="rich-composer-fue-anchor"
                                >
                                    <RichComposerInput
                                        ref={richInputRef}
                                        value={composerText}
                                        autoFocus={!controlsDisabled && !isTouch}
                                        placeholder={t(resolveComposerPlaceholderKey({
                                            richMentionsEnabled: true,
                                            showContinueHint,
                                        }))}
                                        disabled={controlsDisabled}
                                        onValueChange={handleRichValueChange}
                                        onMirrorChange={handleRichMirrorChange}
                                        onKeyDown={handleKeyDown}
                                        onPaste={handlePaste}
                                        onFocus={() => engageRichComposerFue()}
                                        resolveSessionMentionTooltip={resolveSessionMentionTooltip}
                                        onEdit={handleRichEdit}
                                        className={editorClassName}
                                    />
                                    {richComposerFueStatus !== 'acknowledged' ? (
                                        <FueDot
                                            pulsing={richComposerFueStatus === 'unseen'}
                                            ariaLabel={t('fue.newFeatureDot')}
                                        />
                                    ) : null}
                                </div>
                            ) : isExpanded ? (
                                <ComposerPrimitive.Input
                                    asChild
                                    ref={textareaRef}
                                    autoFocus={!controlsDisabled && !isTouch}
                                    submitOnEnter={false}
                                    cancelOnEscape={false}
                                    onChange={handleChange}
                                    onSelect={handleSelect}
                                    onKeyDown={handleKeyDown}
                                    onPaste={handlePaste}
                                >
                                    <textarea
                                        placeholder={t(resolveComposerPlaceholderKey({
                                            richMentionsEnabled: false,
                                            showContinueHint,
                                        }))}
                                        disabled={controlsDisabled}
                                        className="h-full min-h-0 flex-1 resize-none overflow-y-auto bg-transparent text-base leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                </ComposerPrimitive.Input>
                            ) : (
                                <ComposerPrimitive.Input
                                    ref={textareaRef}
                                    autoFocus={!controlsDisabled && !isTouch}
                                    placeholder={t(resolveComposerPlaceholderKey({
                                        richMentionsEnabled: false,
                                        showContinueHint,
                                    }))}
                                    disabled={controlsDisabled}
                                    maxRows={5}
                                    submitOnEnter={false}
                                    cancelOnEscape={false}
                                    onChange={handleChange}
                                    onSelect={handleSelect}
                                    onKeyDown={handleKeyDown}
                                    onPaste={handlePaste}
                                    className="flex-1 resize-none bg-transparent text-base leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                />
                            )}
                        </div>
                        {richMentionsEnabled && richComposerFueStatus === 'engaging' ? (
                            <FueCallout
                                title={t('richComposer.fueTitle')}
                                body={t('richComposer.fueBody')}
                                onDismiss={dismissRichComposerFue}
                                dismissLabel={t('fue.gotIt')}
                                closeAriaLabel={t('fue.closeAriaLabel')}
                                anchorRef={richComposerFueAnchorRef}
                                width={288}
                            />
                        ) : null}

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
                            expanded={isExpanded}
                            onExpandedToggle={handleExpandedToggle}
                            showTerminalButton={showTerminalButton}
                            terminalDisabled={terminalDisabled}
                            terminalLabel={terminalLabel}
                            onTerminal={onTerminal ?? (() => {})}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                            showSwitchButton={showSwitchButton}
                            switchDisabled={switchDisabled}
                            isSwitching={isSwitching}
                            onSwitch={handleSwitch}
                            voiceEnabled={voiceEnabled}
                            dictationEnabled={dictationActive}
                            voiceStatus={effectiveVoiceStatus}
                            voiceMicMuted={dictationActive ? false : voiceMicMuted}
                            onVoiceToggle={effectiveVoiceToggle ?? (() => {})}
                            onVoiceMicToggle={dictationActive ? undefined : onVoiceMicToggle}
                            onSend={handleSend}
                            allowQueueGesture={canQueueSend}
                            pendingSchedule={pendingSchedule}
                            onSchedule={handleUserSchedule}
                            onClearSchedule={onUserClearSchedule}
                            hasAttachments={hasAttachments}
                            piModelLabel={piModelLabel}
                            piModelDisabled={controlsDisabled || !piHasModels}
                            piModelOpen={showPiModelPanel}
                            onPiModelToggle={handlePiModelToggle}
                            piThinkingLabel={piThinkingLabel}
                            piThinkingDisabled={controlsDisabled || !piHasModels || !selectedPiModel || selectedPiModel.reasoning === false}
                            piThinkingOpen={showPiThinkingPanel}
                            onPiThinkingToggle={handlePiThinkingToggle}
                            scratchlistMode={props.scratchlistMode}
                            scratchlistCount={props.scratchlistCount}
                            onScratchlistToggle={props.onScratchlistToggle}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>
        </div>
        </ComposerParkingContext.Provider>
    )
}
