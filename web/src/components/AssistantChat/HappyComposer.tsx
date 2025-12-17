import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
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
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
const PERMISSION_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    bypassPermissions: 'Bypass All'
}

const MODEL_MODES = ['default', 'sonnet', 'opus'] as const
const MODEL_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    sonnet: 'Sonnet',
    opus: 'Opus'
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
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelModeChange?: (mode: ModelMode) => void
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
}) {
    const {
        disabled = false,
        permissionMode = 'default',
        modelMode = 'default',
        active = true,
        thinking = false,
        agentState,
        contextSize,
        onPermissionModeChange,
        onModelModeChange,
        autocompletePrefixes = ['@', '/'],
        autocompleteSuggestions = defaultSuggestionHandler
    } = props

    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    const controlsDisabled = disabled || !active || threadIsDisabled
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const canSend = hasText && !controlsDisabled && !threadIsRunning

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [isAborting, setIsAborting] = useState(false)

    const textareaRef = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            return { ...prev, text: composerText }
        })
    }, [composerText])

    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        const tg = getTelegramWebApp()
        if (type === 'light') {
            tg?.HapticFeedback?.impactOccurred('light')
        } else if (type === 'success') {
            tg?.HapticFeedback?.notificationOccurred('success')
        } else {
            tg?.HapticFeedback?.notificationOccurred('error')
        }
    }, [])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return

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

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

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

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange) {
            e.preventDefault()
            const currentIndex = PERMISSION_MODES.indexOf(permissionMode as typeof PERMISSION_MODES[number])
            const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length
            onPermissionModeChange(PERMISSION_MODES[nextIndex])
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
        haptic
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelModeChange) {
                e.preventDefault()
                const currentIndex = MODEL_MODES.indexOf(modelMode as typeof MODEL_MODES[number])
                const nextIndex = (currentIndex + 1) % MODEL_MODES.length
                onModelModeChange(MODEL_MODES[nextIndex])
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [modelMode, onModelModeChange, haptic])

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

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => !prev)
    }, [haptic])

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

    const showSettingsButton = Boolean(onPermissionModeChange || onModelModeChange)
    const showAbortButton = true

    const overlays = useMemo(() => {
        if (showSettings) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={320}>
                        <div className="py-2">
                            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                Permission Mode
                            </div>
                            {PERMISSION_MODES.map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    disabled={controlsDisabled}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                        controlsDisabled
                                            ? 'cursor-not-allowed opacity-50'
                                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                    }`}
                                    onClick={() => handlePermissionChange(mode)}
                                    onMouseDown={(e) => e.preventDefault()}
                                >
                                    <div
                                        className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                            permissionMode === mode
                                                ? 'border-[var(--app-link)]'
                                                : 'border-[var(--app-hint)]'
                                        }`}
                                    >
                                        {permissionMode === mode && (
                                            <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                        )}
                                    </div>
                                    <span className={permissionMode === mode ? 'text-[var(--app-link)]' : ''}>
                                        {PERMISSION_MODE_LABELS[mode]}
                                    </span>
                                </button>
                            ))}
                        </div>

                        <div className="mx-3 h-px bg-[var(--app-divider)]" />

                        <div className="py-2">
                            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                Model
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
        suggestions,
        selectedIndex,
        controlsDisabled,
        permissionMode,
        modelMode,
        handlePermissionChange,
        handleModelChange,
        handleSuggestionSelect
    ])

    return (
        <div className="px-3 pb-3 pt-2 bg-[var(--app-bg)]">
            <div className="mx-auto w-full max-w-[720px]">
                <ComposerPrimitive.Root className="relative">
                    {overlays}

                    <StatusBar
                        active={active}
                        thinking={thinking}
                        agentState={agentState}
                        contextSize={contextSize}
                        permissionMode={permissionMode}
                    />

                    <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                        <div className="flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                placeholder="Type a message..."
                                disabled={controlsDisabled}
                                maxRows={5}
                                submitOnEnter
                                cancelOnEscape={false}
                                onChange={handleChange}
                                onSelect={handleSelect}
                                onKeyDown={handleKeyDown}
                                className="flex-1 resize-none bg-transparent text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            />
                        </div>

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>
        </div>
    )
}
