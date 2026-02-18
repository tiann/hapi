import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { Terminal } from '@xterm/xterm'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { useLongPress } from '@/hooks/useLongPress'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { LoadingState } from '@/components/LoadingState'
import { getSessionTerminalInstanceId } from '@/lib/terminalInstanceId'
function BackIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CloseIcon(props: { className?: string }) {
    return (
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
            className={props.className}
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

function ConnectionIndicator(props: { status: 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error' }) {
    const isConnected = props.status === 'connected'
    const isConnecting = props.status === 'connecting' || props.status === 'reconnecting'
    const label = isConnected
        ? 'Connected'
        : props.status === 'reconnecting'
          ? 'Reconnecting'
          : isConnecting
            ? 'Connecting'
            : 'Offline'
    const colorClass = isConnected
        ? 'bg-emerald-500'
        : isConnecting
          ? 'bg-amber-400 animate-pulse'
          : 'bg-[var(--app-hint)]'

    return (
        <div className="flex items-center" aria-label={label} title={label} role="status">
            <span className={`h-2.5 w-2.5 rounded-full ${colorClass}`} />
        </div>
    )
}

type QuickInput = {
    label: string
    sequence?: string
    description: string
    modifier?: 'ctrl' | 'alt'
    popup?: {
        label: string
        sequence: string
        description: string
    }
}

type ModifierState = {
    ctrl: boolean
    alt: boolean
}

function applyModifierState(sequence: string, state: ModifierState): string {
    let modified = sequence
    if (state.alt) {
        modified = `\u001b${modified}`
    }
    if (state.ctrl && modified.length === 1) {
        const code = modified.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
            modified = String.fromCharCode(code - 64)
        }
    }
    return modified
}

function shouldResetModifiers(sequence: string, state: ModifierState): boolean {
    if (!sequence) {
        return false
    }
    return state.ctrl || state.alt
}

function isBackspaceInput(sequence: string): boolean {
    return sequence === '\u0008' || sequence === '\u007f'
}

const OUTPUT_QUEUE_MAX_BYTES = 2 * 1024 * 1024
const OUTPUT_DRAIN_BYTES_PER_FRAME = 64 * 1024
const OUTPUT_OVERFLOW_NOTICE = '\r\n[terminal output truncated due to high volume]\r\n'
const DEFAULT_BACKSPACE_SEQUENCE = '\u007f'
const TERMINAL_DEBUG_STORAGE_KEY = 'hapi:debug:terminal'
const TERMINAL_BACKSPACE_MODE_STORAGE_KEY = 'hapi:terminal:backspace'

function isTerminalDebugEnabled(): boolean {
    if (typeof window === 'undefined') {
        return false
    }
    if (import.meta.env.DEV) {
        return true
    }
    try {
        return window.localStorage.getItem(TERMINAL_DEBUG_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

function describeSequence(sequence: string): string {
    if (!sequence) {
        return '(empty)'
    }
    return sequence
        .split('')
        .map((char) => {
            const code = char.charCodeAt(0)
            if (char === '\u0008') {
                return 'BS(0x08)'
            }
            if (char === '\u007f') {
                return 'DEL(0x7f)'
            }
            if (char === '\r') {
                return 'CR(0x0d)'
            }
            if (char === '\n') {
                return 'LF(0x0a)'
            }
            if (char === '\t') {
                return 'TAB(0x09)'
            }
            if (code < 32 || code === 127) {
                return `CTRL(0x${code.toString(16).padStart(2, '0')})`
            }
            return `${char}(0x${code.toString(16).padStart(2, '0')})`
        })
        .join(' ')
}

function debugTerminal(label: string, data: Record<string, unknown>): void {
    if (!isTerminalDebugEnabled()) {
        return
    }
    console.debug(`[TerminalDebug] ${label}`, data)
}

function getBackspaceOverride(): string | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        const value = window.localStorage.getItem(TERMINAL_BACKSPACE_MODE_STORAGE_KEY)
        if (value === 'bs') {
            return '\u0008'
        }
        if (value === 'del') {
            return '\u007f'
        }
        return null
    } catch {
        return null
    }
}

const QUICK_INPUT_ROWS: QuickInput[][] = [
    [
        { label: 'Esc', sequence: '\u001b', description: 'Escape' },
        {
            label: '/',
            sequence: '/',
            description: 'Forward slash',
            popup: { label: '?', sequence: '?', description: 'Question mark' },
        },
        {
            label: '-',
            sequence: '-',
            description: 'Hyphen',
            popup: { label: '|', sequence: '|', description: 'Pipe' },
        },
        { label: 'Home', sequence: '\u001b[H', description: 'Home' },
        { label: '↑', sequence: '\u001b[A', description: 'Arrow up' },
        { label: 'End', sequence: '\u001b[F', description: 'End' },
        { label: 'PgUp', sequence: '\u001b[5~', description: 'Page up' },
    ],
    [
        { label: 'Tab', sequence: '\t', description: 'Tab' },
        { label: 'Ctrl', description: 'Control', modifier: 'ctrl' },
        { label: 'Alt', description: 'Alternate', modifier: 'alt' },
        { label: '←', sequence: '\u001b[D', description: 'Arrow left' },
        { label: '↓', sequence: '\u001b[B', description: 'Arrow down' },
        { label: '→', sequence: '\u001b[C', description: 'Arrow right' },
        { label: 'PgDn', sequence: '\u001b[6~', description: 'Page down' },
    ],
]

function QuickKeyButton(props: {
    input: QuickInput
    disabled: boolean
    isActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: 'ctrl' | 'alt') => void
}) {
    const { input, disabled, isActive, onPress, onToggleModifier } = props
    const modifier = input.modifier
    const popupSequence = input.popup?.sequence
    const popupDescription = input.popup?.description
    const hasPopup = Boolean(popupSequence)
    const longPressDisabled = disabled || Boolean(modifier) || !hasPopup

    const handleClick = useCallback(() => {
        if (modifier) {
            onToggleModifier(modifier)
            return
        }
        onPress(input.sequence ?? '')
    }, [modifier, onToggleModifier, onPress, input.sequence])

    const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'touch') {
            event.preventDefault()
        }
    }, [])

    const longPressHandlers = useLongPress({
        onLongPress: () => {
            if (popupSequence && !modifier) {
                onPress(popupSequence)
            }
        },
        onClick: handleClick,
        disabled: longPressDisabled,
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            onPointerDown={handlePointerDown}
            disabled={disabled}
            aria-pressed={modifier ? isActive : undefined}
            className={`flex-1 border-l border-[var(--app-border)] px-2 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent first:border-l-0 active:bg-[var(--app-subtle-bg)] sm:px-3 sm:text-sm ${
                isActive ? 'bg-[var(--app-link)] text-[var(--app-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
            }`}
            aria-label={input.description}
            title={popupDescription ? `${input.description} (long press: ${popupDescription})` : input.description}
        >
            {input.label}
        </button>
    )
}

export default function TerminalPage() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId/terminal' })
    const navigate = useNavigate()
    const { api, token, baseUrl } = useAppContext()
    const goBack = useAppGoBack()
    const { session } = useSession(api, sessionId)
    const terminalId = useMemo(() => getSessionTerminalInstanceId(sessionId), [sessionId])
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const inputHandlerRef = useRef<{ dispose: () => void } | null>(null)
    const outputQueueRef = useRef<string[]>([])
    const outputQueuedBytesRef = useRef(0)
    const outputDrainRafRef = useRef<number | null>(null)
    const outputOverflowNotifiedRef = useRef(false)
    const skipBackspaceDataCountRef = useRef(0)
    const lastManualBackspaceAtRef = useRef(0)
    const preferredBackspaceRef = useRef(DEFAULT_BACKSPACE_SEQUENCE)
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const modifierStateRef = useRef<ModifierState>({ ctrl: false, alt: false })
    const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
    const [ctrlActive, setCtrlActive] = useState(false)
    const [altActive, setAltActive] = useState(false)

    const {
        state: terminalState,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        onExit,
    } = useTerminalSocket({
        token,
        sessionId,
        terminalId,
        baseUrl
    })

    const clearOutputQueue = useCallback(() => {
        outputQueueRef.current = []
        outputQueuedBytesRef.current = 0
        outputOverflowNotifiedRef.current = false
        if (outputDrainRafRef.current !== null) {
            cancelAnimationFrame(outputDrainRafRef.current)
            outputDrainRafRef.current = null
        }
    }, [])

    const scheduleOutputDrain = useCallback(() => {
        if (outputDrainRafRef.current !== null) {
            return
        }

        const drain = () => {
            outputDrainRafRef.current = null
            const terminal = terminalRef.current
            if (!terminal) {
                return
            }

            let written = 0
            while (outputQueueRef.current.length > 0 && written < OUTPUT_DRAIN_BYTES_PER_FRAME) {
                const chunk = outputQueueRef.current.shift()
                if (!chunk) {
                    continue
                }
                terminal.write(chunk)
                written += chunk.length
                outputQueuedBytesRef.current = Math.max(0, outputQueuedBytesRef.current - chunk.length)
            }

            if (outputQueueRef.current.length > 0) {
                outputDrainRafRef.current = requestAnimationFrame(drain)
                return
            }

            outputOverflowNotifiedRef.current = false
        }

        outputDrainRafRef.current = requestAnimationFrame(drain)
    }, [])

    const enqueueOutput = useCallback((data: string) => {
        if (!data) {
            return
        }

        outputQueueRef.current.push(data)
        outputQueuedBytesRef.current += data.length

        let droppedAny = false
        while (outputQueuedBytesRef.current > OUTPUT_QUEUE_MAX_BYTES && outputQueueRef.current.length > 0) {
            const dropped = outputQueueRef.current.shift()
            if (!dropped) {
                break
            }
            droppedAny = true
            outputQueuedBytesRef.current = Math.max(0, outputQueuedBytesRef.current - dropped.length)
        }

        if (droppedAny && !outputOverflowNotifiedRef.current) {
            outputOverflowNotifiedRef.current = true
            outputQueueRef.current.unshift(OUTPUT_OVERFLOW_NOTICE)
            outputQueuedBytesRef.current += OUTPUT_OVERFLOW_NOTICE.length
        }

        scheduleOutputDrain()
    }, [scheduleOutputDrain])

    useEffect(() => {
        onOutput((data) => {
            enqueueOutput(data)
        })
    }, [onOutput, enqueueOutput])

    useEffect(() => {
        onExit((code, signal) => {
            setExitInfo({ code, signal })
            enqueueOutput(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            connectOnceRef.current = false
        })
    }, [onExit, enqueueOutput])

    useEffect(() => {
        modifierStateRef.current = { ctrl: ctrlActive, alt: altActive }
    }, [ctrlActive, altActive])

    const resetModifiers = useCallback(() => {
        setCtrlActive(false)
        setAltActive(false)
    }, [])

    const sendInput = useCallback((sequence: string, source: 'xterm' | 'mobile-backspace' | 'keyboard-backspace' | 'mobile-paste' | 'quick-key') => {
        const modifierState = modifierStateRef.current
        const outbound = applyModifierState(sequence, modifierState)
        debugTerminal('sendInput', {
            source,
            raw: describeSequence(sequence),
            outbound: describeSequence(outbound),
            ctrl: modifierState.ctrl,
            alt: modifierState.alt
        })
        write(outbound)
        if (shouldResetModifiers(sequence, modifierState)) {
            resetModifiers()
        }
    }, [write, resetModifiers])

    const sendNormalizedBackspace = useCallback((source: 'mobile-backspace' | 'keyboard-backspace') => {
        const now = Date.now()
        // Some input stacks trigger both beforeinput and key handlers for one press.
        if (now - lastManualBackspaceAtRef.current < 40) {
            return
        }
        lastManualBackspaceAtRef.current = now
        skipBackspaceDataCountRef.current += 1
        const override = getBackspaceOverride()
        const backspaceToSend = override ?? preferredBackspaceRef.current
        debugTerminal('mobileBackspace', {
            skipBackspaceDataCount: skipBackspaceDataCountRef.current,
            preferredBackspace: describeSequence(preferredBackspaceRef.current),
            overrideBackspace: describeSequence(override ?? ''),
            outboundBackspace: describeSequence(backspaceToSend)
        })
        sendInput(backspaceToSend, source)
    }, [sendInput])

    const handleTerminalMount = useCallback(
        (terminal: Terminal) => {
            terminalRef.current = terminal
            inputDisposableRef.current?.dispose()
            inputHandlerRef.current?.dispose()
            const textarea = terminal.textarea
            if (textarea) {
                const handleBeforeInput = (event: InputEvent) => {
                    if (event.inputType === 'deleteContentBackward') {
                        debugTerminal('beforeinput', {
                            inputType: event.inputType,
                            data: event.data ?? null
                        })
                        event.preventDefault()
                        sendNormalizedBackspace('mobile-backspace')
                    }
                }
                const handleKeyDown = (event: KeyboardEvent) => {
                    if (event.key !== 'Backspace') {
                        return
                    }
                    debugTerminal('keydown backspace', {
                        key: event.key,
                        code: event.code
                    })
                    event.preventDefault()
                    sendNormalizedBackspace('keyboard-backspace')
                }
                const handlePaste = (event: ClipboardEvent) => {
                    const value = event.clipboardData?.getData('text')
                    if (!value) {
                        return
                    }
                    event.preventDefault()
                    sendInput(value, 'mobile-paste')
                }
                textarea.addEventListener('beforeinput', handleBeforeInput as EventListener)
                textarea.addEventListener('keydown', handleKeyDown as EventListener)
                textarea.addEventListener('paste', handlePaste as EventListener)
                inputHandlerRef.current = {
                    dispose: () => {
                        textarea.removeEventListener('beforeinput', handleBeforeInput as EventListener)
                        textarea.removeEventListener('keydown', handleKeyDown as EventListener)
                        textarea.removeEventListener('paste', handlePaste as EventListener)
                    }
                }
            }
            inputDisposableRef.current = terminal.onData((data) => {
                debugTerminal('xterm.onData', {
                    data: describeSequence(data),
                    skipBackspaceDataCount: skipBackspaceDataCountRef.current
                })
                if (isBackspaceInput(data)) {
                    preferredBackspaceRef.current = data
                    const override = getBackspaceOverride()
                    const outboundBackspace = override ?? data
                    debugTerminal('preferred backspace updated', {
                        preferredBackspace: describeSequence(preferredBackspaceRef.current),
                        overrideBackspace: describeSequence(override ?? ''),
                        outboundBackspace: describeSequence(outboundBackspace)
                    })
                }
                if (isBackspaceInput(data) && skipBackspaceDataCountRef.current > 0) {
                    skipBackspaceDataCountRef.current -= 1
                    debugTerminal('xterm.onData skipped duplicated backspace', {
                        data: describeSequence(data),
                        skipBackspaceDataCount: skipBackspaceDataCountRef.current
                    })
                    return
                }
                if (isBackspaceInput(data)) {
                    const override = getBackspaceOverride()
                    sendInput(override ?? data, 'xterm')
                    return
                }
                sendInput(data, 'xterm')
            })
        },
        [sendInput, sendNormalizedBackspace]
    )

    const handleResize = useCallback(
        (cols: number, rows: number) => {
            lastSizeRef.current = { cols, rows }
            if (!session?.active) {
                return
            }
            if (!connectOnceRef.current) {
                connectOnceRef.current = true
                connect(cols, rows)
            } else {
                resize(cols, rows)
            }
        },
        [session?.active, connect, resize]
    )

    useEffect(() => {
        if (!session?.active) {
            return
        }
        if (connectOnceRef.current) {
            return
        }
        const size = lastSizeRef.current
        if (!size) {
            return
        }
        connectOnceRef.current = true
        connect(size.cols, size.rows)
    }, [session?.active, connect])

    useEffect(() => {
        connectOnceRef.current = false
        setExitInfo(null)
        clearOutputQueue()
        disconnect()
    }, [sessionId, clearOutputQueue, disconnect])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            inputHandlerRef.current?.dispose()
            clearOutputQueue()
            connectOnceRef.current = false
            disconnect()
        }
    }, [clearOutputQueue, disconnect])

    useEffect(() => {
        if (session?.active === false) {
            clearOutputQueue()
            disconnect()
            connectOnceRef.current = false
        }
    }, [session?.active, clearOutputQueue, disconnect])

    useEffect(() => {
        if (terminalState.status === 'error') {
            connectOnceRef.current = false
            return
        }
        if (
            terminalState.status === 'connecting'
            || terminalState.status === 'reconnecting'
            || terminalState.status === 'connected'
        ) {
            setExitInfo(null)
        }
    }, [terminalState.status])

    const quickInputDisabled = !session?.active || terminalState.status !== 'connected'
    const handleQuickInput = useCallback(
        (sequence: string) => {
            if (quickInputDisabled) {
                return
            }
            sendInput(sequence, 'quick-key')
            terminalRef.current?.focus()
        },
        [quickInputDisabled, sendInput]
    )

    const handleModifierToggle = useCallback(
        (modifier: 'ctrl' | 'alt') => {
            if (quickInputDisabled) {
                return
            }
            if (modifier === 'ctrl') {
                setCtrlActive((value) => !value)
                setAltActive(false)
            } else {
                setAltActive((value) => !value)
                setCtrlActive(false)
            }
            terminalRef.current?.focus()
        },
        [quickInputDisabled]
    )

    if (!session) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    const subtitle = session.metadata?.path ?? sessionId
    const status = terminalState.status
    const errorMessage = terminalState.status === 'error' ? terminalState.error : null

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Terminal</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId }
                            })}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            aria-label="Close preview"
                            title="Close"
                        >
                            <CloseIcon className="h-3.5 w-3.5" />
                            <span>Close</span>
                        </button>
                        <ConnectionIndicator status={status} />
                    </div>
                </div>
            </div>

            {session.active ? null : (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Terminal is unavailable.
                    </div>
                </div>
            )}

            {errorMessage ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-xs text-[var(--app-badge-error-text)]">
                        {errorMessage}
                    </div>
                </div>
            ) : null}

            {exitInfo ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        Terminal exited{exitInfo.code !== null ? ` with code ${exitInfo.code}` : ''}
                        {exitInfo.signal ? ` (${exitInfo.signal})` : ''}.
                    </div>
                </div>
            ) : null}

            <div className="flex-1 overflow-hidden bg-[var(--app-bg)]">
                <div className="mx-auto h-full w-full max-w-content p-3">
                    <TerminalView onMount={handleTerminalMount} onResize={handleResize} className="h-full w-full" />
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-t border-[var(--app-border)] pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-3">
                    <div className="flex flex-col gap-2 py-2">
                        {QUICK_INPUT_ROWS.map((row, rowIndex) => (
                            <div
                                key={`terminal-quick-row-${rowIndex}`}
                                className="flex items-stretch overflow-hidden rounded-md bg-[var(--app-secondary-bg)]"
                            >
                                {row.map((input) => {
                                    const modifier = input.modifier
                                    const isCtrl = modifier === 'ctrl'
                                    const isAlt = modifier === 'alt'
                                    const isActive = (isCtrl && ctrlActive) || (isAlt && altActive)
                                    return (
                                        <QuickKeyButton
                                            key={input.label}
                                            input={input}
                                            disabled={quickInputDisabled}
                                            isActive={isActive}
                                            onPress={handleQuickInput}
                                            onToggleModifier={handleModifierToggle}
                                        />
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
