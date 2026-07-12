import { getCodexCollaborationModeOptions, getPermissionModeOptionsForFlavor } from '@hapi/protocol'
import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type SyntheticEvent as ReactSyntheticEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import type { AgentState, CodexCollaborationMode, PermissionMode, PiModelSummary, ThreadGoal } from '@/types/api'
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
import { shouldShowComposerStatusBar, StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { useTranslation } from '@/lib/use-translation'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'
import { getDisplayedCodexServiceTier } from './codexFastMode'
import { getPiThinkingLevelOptions, getHighestThinkingLevel, isThinkingLevelSupported } from './piThinkingLevelOptions'
import { groupModelsByProvider } from './piModelGroups'
import { PiModelPanel } from './PiModelPanel'
import { PiThinkingLevelPanel } from './PiThinkingLevelPanel'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
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
    action?: {
        label: string
        onClick: () => void
        pending?: boolean
    } | null
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export function ModelEffortSettingsSection(props: {
    agentFlavor?: string | null
    options: Array<{ value: string; label: string }>
    selectedValue: string | null | undefined
    controlsDisabled: boolean
    onChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const { agentFlavor, options, selectedValue, controlsDisabled, onChange } = props

    return (
        <div className="py-2">
            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                {agentFlavor === 'cursor' ? t('misc.variant') : t('misc.effort')}
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
    threadGoal?: ThreadGoal | null
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
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
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
    // Set when the most recent send failed (4xx/5xx/network).  The composer
    // restores the original text once per `sendError.id` and renders an
    // inline error affordance until the user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
}) {
    const { t } = useTranslation()
    const {
        sessionId,
        disabled = false,
        permissionMode: rawPermissionMode,
        collaborationMode: rawCollaborationMode,
        threadGoal,
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
        onCollaborationModeChange,
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
        onClearSendError
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const collaborationMode = rawCollaborationMode ?? 'default'
    const model = rawModel ?? null
    const modelReasoningEffort = rawModelReasoningEffort ?? null
    const effort = rawEffort ?? null
    const serviceTier = rawServiceTier ?? null
    const displayedServiceTier = getDisplayedCodexServiceTier(serviceTier)

    const api = useAssistantApi()
    const { composerEnterBehavior } = useComposerEnterBehavior()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    const controlsDisabled = disabled || (!active && !allowSendWhenInactive) || threadIsDisabled
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

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const prevControlledByUser = useRef(controlledByUser)

    useComposerDraft(sessionId, composerText, (text) => api.composer().setText(text))

    // assistant-ui clears `composer.text` synchronously the moment a send is
    // invoked AND `SessionChat.handleSend` clears `pendingSchedule` the
    // moment the mutation is accepted, so by the time the mutation's
    // onError fires both the typed text and the schedule are gone.  When
    // the route hands us a `sendError`, splice both back in -- once per
    // `sendError.id` so a second failure with the same text still triggers
    // a fresh restore.
    const restoredErrorIdRef = useRef<number | null>(null)
    useEffect(() => {
        if (!sendError) {
            return
        }
        if (restoredErrorIdRef.current === sendError.id) {
            return
        }
        restoredErrorIdRef.current = sendError.id
        // Only restore when the composer is empty.  If the user has already
        // typed something new (rare -- composer is `disabled` during send,
        // but possible if isSending toggles before this effect runs), we
        // would otherwise stomp on their fresh input.
        if (composerText.length === 0 && sendError.text.length > 0) {
            api.composer().setText(sendError.text)
        }
        // Restore the pending schedule too.  `scheduledAt` was already
        // resolved to an absolute epoch-ms before the failed send (presets
        // are computed at send time -- see `resolvePendingSchedule`), so
        // we feed it back as an 'absolute' PendingSchedule.  The existing
        // shouldAutoClearPendingSchedule effect in SessionChat handles the
        // case where the absolute time has passed by the time we restore.
        if (sendError.scheduledAt !== null && onScheduleProp) {
            onScheduleProp({ type: 'absolute', ms: sendError.scheduledAt })
        }
    }, [sendError, api, composerText, onScheduleProp])

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText])

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

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

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
    }, [api, suggestions, inputState, autocompletePrefixes, haptic])

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
    const modelOptions = useMemo(
        () => getModelOptionsForFlavor(agentFlavor, model, availableModelOptions),
        [agentFlavor, model, availableModelOptions]
    )
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

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        // Shift+Enter inserts a newline (standard behavior)
        if (key === 'Enter' && e.shiftKey) {
            return // let default textarea behavior handle newline
        }

        // Enter with suggestions visible: select the suggestion
        if (key === 'Enter' && suggestions.length > 0) {
            e.preventDefault()
            const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
            handleSuggestionSelect(indexToSelect)
            return
        }

        // Only plain Enter (no modifiers) sends; other modifier combos are ignored
        if (key === 'Enter') {
            if (composerEnterBehavior === 'newline') {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && canSend) {
                    e.preventDefault()
                    api.composer().send()
                    setShowContinueHint(false)
                }
                return
            }
            e.preventDefault()
            if (!e.ctrlKey && !e.altKey && !e.metaKey && canSend) {
                api.composer().send()
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
            if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        if (key === 'Escape' && threadIsRunning) {
            e.preventDefault()
            handleAbort()
            return
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
        api,
        haptic,
        composerEnterBehavior
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
        // Editing the restored text is the operator's "I'm handling it"
        // signal -- drop the inline error so the affordance doesn't shout
        // at them while they fix the message.
        if (sendError && onClearSendError) {
            onClearSendError()
        }
    }, [sendError, onClearSendError])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
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
        setShowSettings(prev => !prev)
    }, [haptic])

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
        setShowSettings(false)
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic])

    const handleCollaborationChange = useCallback((mode: CodexCollaborationMode) => {
        if (!onCollaborationModeChange || controlsDisabled) return
        onCollaborationModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onCollaborationModeChange, controlsDisabled, haptic])

    const handleModelChange = useCallback((nextModel: { provider: string; modelId: string } | string | null) => {
        if (!onModelChange || controlsDisabled) return
        onModelChange(nextModel)
        setShowSettings(false)
        haptic('light')
    }, [onModelChange, controlsDisabled, haptic])

    const handleModelEffortChange = useCallback((nextWireId: string | null) => {
        const handler = onModelEffortChange ?? onModelChange
        if (!handler || controlsDisabled) return
        handler(nextWireId)
        setShowSettings(false)
        haptic('light')
    }, [onModelEffortChange, onModelChange, controlsDisabled, haptic])

    const handleModelReasoningEffortChange = useCallback((nextModelReasoningEffort: string | null) => {
        if (!onModelReasoningEffortChange || controlsDisabled) return
        onModelReasoningEffortChange(nextModelReasoningEffort)
        setShowSettings(false)
        haptic('light')
    }, [onModelReasoningEffortChange, controlsDisabled, haptic])

    const handleEffortChange = useCallback((nextEffort: string | null) => {
        if (!onEffortChange || controlsDisabled) return
        onEffortChange(nextEffort)
        setShowSettings(false)
        haptic('light')
    }, [onEffortChange, controlsDisabled, haptic])

    const handleServiceTierChange = useCallback((nextServiceTier: string | null) => {
        if (!onServiceTierChange || controlsDisabled) return
        onServiceTierChange(nextServiceTier)
        setShowSettings(false)
        haptic('light')
    }, [onServiceTierChange, controlsDisabled, haptic])

    // 'standard' (not null) is the explicit Fast-off choice so it persists
    // distinctly from an untouched/account-default session.
    const fastModeOptions: Array<{ value: string; label: string }> = useMemo(() => [
        { value: 'standard', label: t('misc.fastModeStandard') },
        { value: 'fast', label: t('misc.fastModeFast') }
    ], [t])

    const showCollaborationSettings = Boolean(onCollaborationModeChange && collaborationModeOptions.length > 0)
    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelChange && supportsModelChange(agentFlavor) && (piModels && piModels.length > 0 || modelOptions.length > 0))
    const showModelEffortSettings = Boolean(
        (onModelEffortChange ?? onModelChange)
        && modelEffortOptions
        && modelEffortOptions.length > 0
    )
    const showModelReasoningEffortSettings = Boolean(onModelReasoningEffortChange && codexReasoningEffortOptions.length > 0)
    // For Pi: hide effort when selected model explicitly has reasoning: false
    const piEffortHidden = piModels && selectedPiModel && selectedPiModel.reasoning === false
    const showEffortSettings = Boolean(onEffortChange && supportsEffort(agentFlavor) && !piEffortHidden)
    const showFastModeSettings = Boolean(onServiceTierChange)
    const showSettingsButton = Boolean(
        showCollaborationSettings
        || showPermissionSettings
        || showModelSettings
        || showModelEffortSettings
        || showModelReasoningEffortSettings
        || showEffortSettings
        || showFastModeSettings
    )
    const showAbortButton = true
    const voiceEnabled = Boolean(onVoiceToggle)

    const handleSend = useCallback(() => {
        api.composer().send()
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
    }, [api])

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
        setShowSettings(false)
        setShowPiModelPanel(false)
        setShowPiThinkingPanel(false)
    }, [])

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

    const overlays = useMemo(() => {
        // Pi flavor: separate floating panels for model and thinking level.
        // (Pi RPC mode has no runtime permission switching → no permission panel.)
        if (agentFlavor === 'pi') {
            const panels: React.ReactNode[] = []

            // Model selection panel
            if (showPiModelPanel && piModels && piModels.length > 0) {
                const currentPiModel = selectedPiModel ?? null
                panels.push(
                    <div key="model" className="absolute bottom-[100%] mb-2 left-2 w-64">
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
                    <div key="thinking" className="absolute bottom-[100%] mb-2 left-2 w-48">
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
        if (showSettings && (showCollaborationSettings || showPermissionSettings || showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings || showEffortSettings || showFastModeSettings)) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
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

                        {showCollaborationSettings && (showPermissionSettings || showModelSettings || showModelReasoningEffortSettings || showEffortSettings) ? (
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

                        {(showCollaborationSettings || showPermissionSettings) && (showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings || showEffortSettings) ? (
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
                                            onClick={() => handleModelChange(option.value)}
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
                                options={modelEffortOptions!}
                                selectedValue={selectedModelVariant ?? model}
                                controlsDisabled={controlsDisabled}
                                onChange={handleModelEffortChange}
                            />
                        ) : null}

                        {(showModelSettings || showModelEffortSettings) && showModelReasoningEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {(showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings) && showEffortSettings ? (
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
                <div className="absolute bottom-[100%] mb-2 w-full">
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
        showPermissionSettings,
        showModelSettings,
        showModelEffortSettings,
        modelEffortOptions,
        selectedModelBase,
        selectedModelVariant,
        showModelReasoningEffortSettings,
        showEffortSettings,
        showFastModeSettings,
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
        permissionModeOptions,
        handleCollaborationChange,
        handlePermissionChange,
        handleModelChange,
        handleModelReasoningEffortChange,
        handleEffortChange,
        handleServiceTierChange,
        handleSuggestionSelect,
        t
    ])

    return (
        <div className={`px-3 ${bottomPaddingClass} pt-2 bg-[var(--app-bg)]`}>
            <div className="mx-auto w-full max-w-content">
                <ComposerPrimitive.Root className="relative" onSubmit={handleSubmit}>
                    {overlays}

                    {shouldShowComposerStatusBar(agentFlavor) ? (
                        <StatusBar
                            active={active}
                            thinking={thinking}
                            agentState={agentState}
                            backgroundTaskCount={backgroundTaskCount}
                            contextSize={contextSize}
                            contextCacheRead={contextCacheRead}
                            contextWindow={contextWindow}
                            model={model}
                            modelReasoningEffort={modelReasoningEffort}
                            serviceTier={serviceTier}
                            permissionMode={permissionMode}
                            collaborationMode={collaborationMode}
                            threadGoal={threadGoal}
                            agentFlavor={agentFlavor}
                            voiceStatus={voiceStatus}
                        />
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
                            sendError ? 'ring-1 ring-red-500' : ''
                        }`}
                    >
                        {attachments.length > 0 ? (
                            <div className="flex flex-wrap gap-2 px-4 pt-3">
                                <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                            </div>
                        ) : null}

                        <div className="flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                autoFocus={!controlsDisabled && !isTouch}
                                placeholder={showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
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
                        </div>

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
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
                            voiceStatus={voiceStatus}
                            voiceMicMuted={voiceMicMuted}
                            onVoiceToggle={onVoiceToggle ?? (() => {})}
                            onVoiceMicToggle={onVoiceMicToggle}
                            onSend={handleSend}
                            pendingSchedule={pendingSchedule}
                            onSchedule={setPendingSchedule}
                            onClearSchedule={isControlled ? onClearScheduleProp : () => setPendingScheduleLocal(null)}
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
    )
}
