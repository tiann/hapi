import {
    useState,
    useCallback,
    useRef,
    useEffect,
    useImperativeHandle,
    forwardRef,
    memo
} from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import type { ModelMode, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import { FloatingOverlay } from './ChatInput/FloatingOverlay'
import { Autocomplete } from './ChatInput/Autocomplete'

// Types
export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'Tab'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

export interface ChatInputHandle {
    focus: () => void
    blur: () => void
}

export interface ChatInputProps {
    disabled?: boolean
    onSend: (text: string) => void
    // Session data
    sessionId?: string
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    active?: boolean
    // Callbacks
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelModeChange?: (mode: ModelMode) => void
    onAbort?: () => Promise<void>
    // Autocomplete
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
}

// Permission mode display config
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
const PERMISSION_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    bypassPermissions: 'Bypass All'
}

// Model mode display config
const MODEL_MODES = ['default', 'sonnet', 'opus'] as const
const MODEL_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    sonnet: 'Sonnet',
    opus: 'Opus'
}

// Default empty suggestion handler
const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export const ChatInput = memo(forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(props, ref) {
    const {
        disabled = false,
        onSend,
        permissionMode = 'default',
        modelMode = 'default',
        active = true,
        onPermissionModeChange,
        onModelModeChange,
        onAbort,
        autocompletePrefixes = ['@', '/'],
        autocompleteSuggestions = defaultSuggestionHandler
    } = props

    // State
    const [text, setText] = useState('')
    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [isAborting, setIsAborting] = useState(false)

    // Refs
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Imperative handle
    useImperativeHandle(ref, () => ({
        focus: () => textareaRef.current?.focus(),
        blur: () => textareaRef.current?.blur()
    }), [])

    // Autocomplete hooks
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    // Computed values
    const trimmed = text.trim()
    const hasText = trimmed.length > 0
    const controlsDisabled = disabled || !active

    // Haptic feedback helper
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

    // Send message
    const send = useCallback(() => {
        if (!trimmed || controlsDisabled) return
        haptic('light')
        onSend(trimmed)
        setText('')
        setInputState({ text: '', selection: { start: 0, end: 0 } })
    }, [trimmed, controlsDisabled, haptic, onSend])

    // Handle suggestion selection
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

        setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        // Set cursor position
        setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.setSelectionRange(result.cursorPosition, result.cursorPosition)
                textareaRef.current.focus()
            }
        }, 0)

        haptic('light')
    }, [suggestions, inputState, autocompletePrefixes, haptic])

    // Handle abort
    const handleAbort = useCallback(async () => {
        if (!onAbort || isAborting) return

        haptic('error')
        setIsAborting(true)
        const startTime = Date.now()

        try {
            await onAbort()
            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed))
            }
        } catch (error) {
            console.error('Abort failed:', error)
        } finally {
            setIsAborting(false)
        }
    }, [onAbort, isAborting, haptic])

    // Handle keyboard events
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            } else if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            } else if ((key === 'Enter' || key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            } else if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        // Handle Escape for abort when no suggestions
        if (key === 'Escape' && onAbort && !isAborting) {
            e.preventDefault()
            handleAbort()
            return
        }

        // Handle Enter to send
        if (key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
            return
        }

        // Handle Shift+Tab for permission mode switching
        if (key === 'Tab' && e.shiftKey && onPermissionModeChange) {
            e.preventDefault()
            const currentIndex = PERMISSION_MODES.indexOf(permissionMode as typeof PERMISSION_MODES[number])
            const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length
            onPermissionModeChange(PERMISSION_MODES[nextIndex])
            haptic('light')
            return
        }
    }, [
        suggestions, selectedIndex, moveUp, moveDown, clearSuggestions, handleSuggestionSelect,
        onAbort, isAborting, handleAbort, send, onPermissionModeChange, permissionMode, haptic
    ])

    // Handle global keyboard for model mode switching
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            // Handle Cmd/Ctrl+M for model mode switching
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

    // Handle text change
    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newText = e.target.value
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setText(newText)
        setInputState({ text: newText, selection })
    }, [])

    // Handle selection change
    const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    // Handle settings toggle
    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => !prev)
    }, [haptic])

    // Handle permission mode change
    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        haptic('light')
        onPermissionModeChange?.(mode)
    }, [haptic, onPermissionModeChange])

    // Handle model mode change
    const handleModelChange = useCallback((mode: ModelMode) => {
        haptic('light')
        onModelModeChange?.(mode)
    }, [haptic, onModelModeChange])

    // Close settings when clicking outside
    useEffect(() => {
        if (!showSettings) return

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement
            if (!target.closest('.settings-panel') && !target.closest('.settings-button')) {
                setShowSettings(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showSettings])

    return (
        <div className="bg-[var(--app-bg)] px-2 pb-2 pt-1">
            <div className="relative mx-auto w-full max-w-[720px]">
                {/* Autocomplete overlay */}
                {suggestions.length > 0 && (
                    <div className="absolute bottom-full left-0 right-0 z-50 mb-2">
                        <FloatingOverlay maxHeight={240}>
                            <Autocomplete
                                suggestions={suggestions as Suggestion[]}
                                selectedIndex={selectedIndex}
                                onSelect={handleSuggestionSelect}
                            />
                        </FloatingOverlay>
                    </div>
                )}

                {/* Settings overlay */}
                {showSettings && (
                    <div className="settings-panel absolute bottom-full left-0 right-0 z-50 mb-2">
                        <FloatingOverlay maxHeight={320}>
                            {/* Permission Mode Section */}
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

                            {/* Divider */}
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />

                            {/* Model Mode Section */}
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
                )}

                {/* Status bar */}
                {(permissionMode && permissionMode !== 'default') && (
                    <div className="flex items-center justify-end px-2 pb-1">
                        <span className={`text-xs ${
                            permissionMode === 'acceptEdits' ? 'text-amber-500' :
                            permissionMode === 'bypassPermissions' ? 'text-red-500' :
                            permissionMode === 'plan' ? 'text-blue-500' :
                            'text-[var(--app-hint)]'
                        }`}>
                            {PERMISSION_MODE_LABELS[permissionMode]}
                        </span>
                    </div>
                )}

                {/* Unified panel */}
                <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                    {/* Input area */}
                    <div className="flex items-center px-3 py-2">
                        <TextareaAutosize
                            ref={textareaRef}
                            value={text}
                            onChange={handleChange}
                            onSelect={handleSelect}
                            onKeyDown={handleKeyDown}
                            placeholder="Type a message..."
                            disabled={controlsDisabled}
                            maxRows={5}
                            className="flex-1 resize-none bg-transparent text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        />
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center justify-between px-2 pb-2">
                        <div className="flex items-center gap-1">
                            {/* Settings button */}
                            {onPermissionModeChange && (
                                <button
                                    type="button"
                                    className="settings-button flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                                    onClick={handleSettingsToggle}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="18"
                                        height="18"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                    </svg>
                                </button>
                            )}

                            {/* Abort button */}
                            {onAbort && (
                                <button
                                    type="button"
                                    disabled={isAborting || controlsDisabled}
                                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                                    onClick={handleAbort}
                                >
                                    {isAborting ? (
                                        <svg
                                            className="animate-spin"
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="18"
                                            height="18"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                            <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
                                        </svg>
                                    ) : (
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="18"
                                            height="18"
                                            viewBox="0 0 16 16"
                                            fill="currentColor"
                                        >
                                            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
                                        </svg>
                                    )}
                                </button>
                            )}
                        </div>

                        {/* Send button */}
                        <button
                            type="button"
                            disabled={controlsDisabled || !hasText}
                            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                                hasText && !controlsDisabled
                                    ? 'bg-black text-white'
                                    : 'bg-[#C0C0C0] text-white'
                            } disabled:cursor-not-allowed`}
                            onClick={send}
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="12" y1="19" x2="12" y2="5" />
                                <polyline points="5 12 12 5 19 12" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}))
