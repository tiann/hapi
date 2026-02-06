import { getPermissionModeOptionsForFlavor, MODEL_MODE_LABELS, MODEL_MODES } from '@hapi/protocol'
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
import type { AgentState, ModelMode, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ConversationStatus } from '@/realtime/types'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { useVerticalDrag } from '@/hooks/useVerticalDrag'
import { applySuggestion } from '@/utils/applySuggestion'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { markSkillUsed } from '@/lib/recent-skills'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'

type ComposerMode = 'quick' | 'expanded'
type SnapIndex = 0 | 1 | 2

// Snap points as fractions of viewport height
const SNAP_POINTS = [0.2, 0.5, 1.0] as const

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export function HappyComposer(props: {
    disabled?: boolean
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    active?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    contextSize?: number
    controlledByUser?: boolean
    agentFlavor?: string | null
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelModeChange?: (mode: ModelMode) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    // Voice assistant props
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle?: () => void
    onVoiceMicToggle?: () => void
}) {
    const { t } = useTranslation()
    const {
        disabled = false,
        permissionMode: rawPermissionMode,
        modelMode: rawModelMode,
        active = true,
        thinking = false,
        agentState,
        contextSize,
        controlledByUser = false,
        agentFlavor,
        onPermissionModeChange,
        onModelModeChange,
        onSwitchToRemote,
        onTerminal,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
        voiceStatus = 'disconnected',
        voiceMicMuted = false,
        onVoiceToggle,
        onVoiceMicToggle
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const modelMode = rawModelMode ?? 'default'

    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    const controlsDisabled = disabled || !active || threadIsDisabled
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
    const canSend = (hasText || hasAttachments) && attachmentsReady && !controlsDisabled && !threadIsRunning

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    const [composerMode, setComposerMode] = useState<ComposerMode>('quick')
    const [snapIndex, setSnapIndex] = useState<SnapIndex>(0)
    const [isDragging, setIsDragging] = useState(false)
    const [dragPreviewHeight, setDragPreviewHeight] = useState<number | null>(null)

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const prevControlledByUser = useRef(controlledByUser)

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

    // Voice active check - disable mode switching during voice input
    const voiceActive = voiceStatus === 'connected'

    // Constants for drag behavior
    const VELOCITY_THRESHOLD = 0.5 // px/ms - threshold for flick gestures
    const DRAG_THRESHOLD_TO_EXPAND = 50 // px - minimum drag from quick mode to expand

    // Track the starting state when drag begins
    const dragStartHeightRef = useRef<number>(0)
    const dragStartModeRef = useRef<ComposerMode>('quick')
    const dragStartSnapIndexRef = useRef<SnapIndex>(0)
    const dragHandleRef = useRef<HTMLDivElement>(null)

    // Calculate current viewport height (accounts for keyboard)
    const getViewportHeight = useCallback(() => {
        return window.visualViewport?.height ?? window.innerHeight
    }, [])

    // Calculate height for a given snap index
    // Leave 60px margin at top for close button visibility, and respect safe area at bottom
    const getSnapHeight = useCallback((index: SnapIndex) => {
        const vh = getViewportHeight()
        const maxHeight = vh - 60 // Keep 60px visible at top for close button/status
        const targetHeight = Math.round(vh * SNAP_POINTS[index])
        return Math.min(targetHeight, maxHeight)
    }, [getViewportHeight])

    // Get the current expanded height based on snap index
    const expandedHeight = composerMode === 'expanded' ? getSnapHeight(snapIndex) : null

    // Force re-render when viewport changes (keyboard open/close)
    const [, forceUpdate] = useState(0)
    useEffect(() => {
        if (!window.visualViewport) return

        const handleViewportChange = () => {
            // Force re-render to recalculate expandedHeight with new viewport
            forceUpdate(n => n + 1)
        }

        window.visualViewport.addEventListener('resize', handleViewportChange)
        window.visualViewport.addEventListener('scroll', handleViewportChange)

        return () => {
            window.visualViewport?.removeEventListener('resize', handleViewportChange)
            window.visualViewport?.removeEventListener('scroll', handleViewportChange)
        }
    }, [])

    const dragHandlers = useVerticalDrag({
        disabled: voiceActive,
        threshold: 10,
        onDragStart: () => {
            setIsDragging(true)
            dragStartModeRef.current = composerMode
            dragStartSnapIndexRef.current = snapIndex
            // Store the starting height for calculating drag progress
            if (composerMode === 'expanded') {
                dragStartHeightRef.current = getSnapHeight(snapIndex)
            } else {
                // Starting from quick mode - use first snap point as reference
                dragStartHeightRef.current = getSnapHeight(0)
            }
        },
        onDrag: (deltaY: number) => {
            const vh = getViewportHeight()
            // Calculate preview height (drag up = negative deltaY = increase height)
            const newHeight = Math.max(
                vh * SNAP_POINTS[0] * 0.5, // Minimum preview height
                Math.min(vh, dragStartHeightRef.current - deltaY)
            )

            // If starting from quick mode, expand once drag threshold is reached
            if (dragStartModeRef.current === 'quick' && -deltaY > DRAG_THRESHOLD_TO_EXPAND) {
                if (composerMode !== 'expanded') {
                    setComposerMode('expanded')
                    setSnapIndex(0)
                }
                setDragPreviewHeight(newHeight)
            } else if (dragStartModeRef.current === 'expanded') {
                // Already expanded - update preview height
                setDragPreviewHeight(newHeight)
            }
        },
        onDragEnd: (totalDeltaY: number, velocity: number) => {
            setIsDragging(false)
            setDragPreviewHeight(null)

            const vh = getViewportHeight()

            if (dragStartModeRef.current === 'quick') {
                // Started from quick mode
                if (composerMode === 'expanded') {
                    // Successfully expanded - determine which snap point
                    const draggedHeight = -totalDeltaY
                    const targetSnapIndex = findTargetSnapIndex(draggedHeight, velocity, vh)
                    setSnapIndex(targetSnapIndex)
                    haptic('light')
                }
            } else {
                // Started from expanded mode
                const startHeight = dragStartHeightRef.current
                const currentHeight = startHeight - totalDeltaY

                // Check for collapse (fast downward flick or dragged below threshold)
                const collapseThreshold = vh * SNAP_POINTS[0] * 0.5
                const shouldCollapse = velocity > VELOCITY_THRESHOLD || currentHeight < collapseThreshold

                if (shouldCollapse) {
                    setComposerMode('quick')
                    setSnapIndex(0)
                    haptic('light')
                } else {
                    // Find target snap point based on current position and velocity
                    const targetSnapIndex = findTargetSnapIndex(currentHeight, -velocity, vh)
                    setSnapIndex(targetSnapIndex)
                    if (targetSnapIndex !== dragStartSnapIndexRef.current) {
                        haptic('light')
                    }
                }
            }

            // Focus textarea after drag ends (with Android-friendly timing)
            focusTextarea()
        }
    })

    // Find the best snap point based on current height and velocity
    const findTargetSnapIndex = (height: number, velocity: number, vh: number): SnapIndex => {
        // Velocity-based snap: if flicking up/down quickly, go to next/prev snap
        if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
            const currentIndex = dragStartSnapIndexRef.current
            if (velocity < 0 && currentIndex < 2) {
                // Flicking up - go to higher snap
                return (currentIndex + 1) as SnapIndex
            } else if (velocity > 0 && currentIndex > 0) {
                // Flicking down - go to lower snap
                return (currentIndex - 1) as SnapIndex
            }
        }

        // Position-based snap: find nearest snap point
        let nearestIndex: SnapIndex = 0
        let nearestDistance = Infinity

        for (let i = 0; i < SNAP_POINTS.length; i++) {
            const snapHeight = vh * SNAP_POINTS[i]
            const distance = Math.abs(height - snapHeight)
            if (distance < nearestDistance) {
                nearestDistance = distance
                nearestIndex = i as SnapIndex
            }
        }

        return nearestIndex
    }

    // Focus textarea with Android-friendly timing
    const focusTextarea = useCallback(() => {
        requestAnimationFrame(() => {
            setTimeout(() => {
                if (!textareaRef.current) return
                textareaRef.current.focus({ preventScroll: true })
            }, 100)
        })
    }, [])

    // Double-click/tap handler to collapse expanded mode
    const handleDragHandleDoubleClick = useCallback(() => {
        if (composerMode === 'expanded') {
            setComposerMode('quick')
            setSnapIndex(0)
            haptic('light')
            focusTextarea()
        }
    }, [composerMode, haptic, focusTextarea])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

        // For Codex user prompts with content, expand the content instead of command name
        let textToInsert = suggestion.text
        let addSpace = true
        if (agentFlavor === 'codex' && suggestion.source === 'user' && suggestion.content) {
            textToInsert = suggestion.content
            addSpace = false
        }

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            textToInsert,
            autocompletePrefixes,
            addSpace
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
    }, [api, suggestions, inputState, autocompletePrefixes, haptic, agentFlavor])

    const abortDisabled = controlsDisabled || isAborting || !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal)

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
            if ((key === 'Enter' || key === 'Tab') && !e.shiftKey) {
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

        // Cmd/Ctrl+Shift+Enter toggles expanded mode
        if (key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey && !voiceActive) {
            e.preventDefault()
            if (composerMode === 'quick') {
                setComposerMode('expanded')
                setSnapIndex(1) // Start at middle snap point (50%)
            } else {
                setComposerMode('quick')
                setSnapIndex(0)
            }
            haptic('light')
            return
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
        haptic,
        voiceActive,
        composerMode
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelModeChange && agentFlavor !== 'codex' && agentFlavor !== 'gemini') {
                e.preventDefault()
                const currentIndex = MODEL_MODES.indexOf(modelMode as typeof MODEL_MODES[number])
                const nextIndex = (currentIndex + 1) % MODEL_MODES.length
                onModelModeChange(MODEL_MODES[nextIndex])
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [modelMode, onModelModeChange, haptic, agentFlavor])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setInputState({ text: e.target.value, selection })
    }, [])

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

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => !prev)
    }, [haptic])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        if (event && !attachmentsReady) {
            event.preventDefault()
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

    const handleModelChange = useCallback((mode: ModelMode) => {
        if (!onModelModeChange || controlsDisabled) return
        onModelModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onModelModeChange, controlsDisabled, haptic])

    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelModeChange && agentFlavor !== 'codex' && agentFlavor !== 'gemini')
    const showSettingsButton = Boolean(showPermissionSettings || showModelSettings)
    const showAbortButton = true
    const voiceEnabled = Boolean(onVoiceToggle)

    const handleSend = useCallback(() => {
        api.composer().send()
    }, [api])

    const overlays = useMemo(() => {
        if (showSettings && (showPermissionSettings || showModelSettings)) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={320}>
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

                        {showPermissionSettings && showModelSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.model')}
                                </div>
                                {MODEL_MODES.map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleModelChange(mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                modelMode === mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {modelMode === mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={modelMode === mode ? 'text-[var(--app-link)]' : ''}>
                                            {MODEL_MODE_LABELS[mode]}
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
        showPermissionSettings,
        showModelSettings,
        suggestions,
        selectedIndex,
        controlsDisabled,
        permissionMode,
        modelMode,
        permissionModeOptions,
        handlePermissionChange,
        handleModelChange,
        handleSuggestionSelect
    ])

    const isExpanded = composerMode === 'expanded'

    // Calculate the display height (preview during drag, snap height otherwise)
    const displayHeight = isDragging && dragPreviewHeight !== null
        ? dragPreviewHeight
        : expandedHeight

    const expandedStyle = useMemo(() => {
        if (!isExpanded || !displayHeight) return undefined
        return {
            height: displayHeight,
            // Disable transition during drag for responsive feel
            transition: isDragging ? 'none' : 'height 0.2s ease-out'
        }
    }, [isExpanded, displayHeight, isDragging])

    // Close handler for the close button
    const handleClose = useCallback(() => {
        setComposerMode('quick')
        setSnapIndex(0)
        haptic('light')
        focusTextarea()
    }, [haptic, focusTextarea])

    return (
        <>
            <div
                className={
                    isExpanded
                        ? `fixed inset-x-0 z-50 px-3 pt-2 bg-[var(--app-bg)] composer-expanding`
                        : `px-3 ${bottomPaddingClass} pt-2 bg-[var(--app-bg)]`
                }
                style={{
                    ...(isExpanded ? {
                        bottom: 0,
                        paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))'
                    } : {}),
                    ...expandedStyle
                }}
            >
                <div className={`mx-auto w-full max-w-content ${isExpanded ? 'h-full flex flex-col' : ''}`}>
                    <ComposerPrimitive.Root className={`relative ${isExpanded ? 'flex-1 flex flex-col min-h-0' : ''}`} onSubmit={handleSubmit}>
                        {overlays}

                        {!isExpanded && (
                            <StatusBar
                                active={active}
                                thinking={thinking}
                                agentState={agentState}
                                contextSize={contextSize}
                                modelMode={modelMode}
                                permissionMode={permissionMode}
                                agentFlavor={agentFlavor}
                                voiceStatus={voiceStatus}
                            />
                        )}

                        <div className={`overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)] ${isExpanded ? 'flex-1 flex flex-col min-h-0' : ''}`}>
                            {/* Drag handle with close button */}
                            <div className="relative flex-shrink-0">
                                <div
                                    ref={dragHandleRef}
                                    className={`flex justify-center py-4 -my-2 touch-none select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                                    onDoubleClick={handleDragHandleDoubleClick}
                                    {...dragHandlers}
                                >
                                    <div
                                        className={`w-12 h-1.5 rounded-full transition-colors ${
                                            isExpanded
                                                ? 'bg-[var(--app-link)]'
                                                : 'bg-[var(--app-hint)]/40'
                                        }`}
                                    />
                                </div>
                                {/* Close button - visible when expanded */}
                                {isExpanded && (
                                    <button
                                        type="button"
                                        onClick={handleClose}
                                        className="absolute right-2 top-1 p-1.5 rounded-full hover:bg-[var(--app-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                                        aria-label="Close expanded composer"
                                    >
                                        <CloseIcon className="h-4 w-4" />
                                    </button>
                                )}
                            </div>

                            {attachments.length > 0 ? (
                                <div className="flex flex-wrap gap-2 px-4 pb-2 flex-shrink-0">
                                    <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                                </div>
                            ) : null}

                            <div className={`flex px-4 ${isExpanded ? 'flex-1 min-h-0 overflow-y-auto pb-2' : 'items-center py-3'}`}>
                                <ComposerPrimitive.Input
                                    ref={textareaRef}
                                    autoFocus={!controlsDisabled && !isTouch}
                                    placeholder={showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
                                    disabled={controlsDisabled}
                                    maxRows={isExpanded ? undefined : 5}
                                    submitOnEnter={!isExpanded}
                                    cancelOnEscape={false}
                                    onChange={handleChange}
                                    onSelect={handleSelect}
                                    onKeyDown={handleKeyDown}
                                    onPaste={handlePaste}
                                    className={`flex-1 resize-none bg-transparent text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${isExpanded ? '' : ''}`}
                                />
                            </div>

                            <div className="flex-shrink-0">
                                <ComposerButtons
                                canSend={canSend}
                                controlsDisabled={controlsDisabled}
                                showSettingsButton={showSettingsButton}
                                onSettingsToggle={handleSettingsToggle}
                                showTerminalButton={showTerminalButton}
                                terminalDisabled={controlsDisabled}
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
                                />
                            </div>
                        </div>
                    </ComposerPrimitive.Root>
                </div>
            </div>
        </>
    )
}
