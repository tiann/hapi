import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { useParams } from '@tanstack/react-router'
import type { Terminal } from '@xterm/xterm'
import { useAppContext } from '@/lib/app-context'
import { safeCopyToClipboard } from '@/shared/lib/clipboard'
import { cn } from '@/lib/utils'
import { useSession } from '@/hooks/queries/useSession'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { useLongPress } from '@/shared/hooks/useLongPress'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import {
    appendTerminalSessionOutput,
    getTerminalSessionState,
    markTerminalSessionConnected,
    resetTerminalSessionState
} from '@/lib/terminal-session-store'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { LoadingState } from '@/components/LoadingState'
import { Button } from '@/shared/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/shared/ui/dialog'

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
    const { t } = useTranslation()
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
            className={cn(
                'flex-1 border-l border-[var(--app-border)] px-2 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent first:border-l-0 active:bg-[var(--app-subtle-bg)] sm:px-3 sm:text-sm',
                isActive ? 'bg-[var(--app-link)] text-[var(--app-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
            )}
            aria-label={popupDescription ? t('terminal.quickInput.longPressLabel', { key: input.description, alternate: popupDescription }) : input.description}
            title={popupDescription ? t('terminal.quickInput.longPressLabel', { key: input.description, alternate: popupDescription }) : input.description}
        >
            {input.label}
        </button>
    )
}

export function TerminalPage() {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/terminal' })
    const { api, token, baseUrl } = useAppContext()
    const { session } = useSession(api, sessionId)
    const [terminalStateSnapshot, setTerminalStateSnapshot] = useState(() => getTerminalSessionState(sessionId))
    const terminalId = terminalStateSnapshot.terminalId
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const connectOnceRef = useRef(false)
    const closeRef = useRef<(terminalId?: string) => void>(() => {})
    const disconnectRef = useRef<() => void>(() => {})
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const modifierStateRef = useRef<ModifierState>({ ctrl: false, alt: false })
    const replayedBufferRef = useRef<string | null>(null)
    const pendingReconnectToastRef = useRef(false)
    const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
    const [ctrlActive, setCtrlActive] = useState(false)
    const [altActive, setAltActive] = useState(false)
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false)
    const [manualPasteText, setManualPasteText] = useState('')

    const handleTerminalNotFound = useCallback(() => {
        pendingReconnectToastRef.current = true
        const previousTerminalId = terminalId
        closeRef.current(previousTerminalId)
        disconnectRef.current()
        const nextState = resetTerminalSessionState(sessionId)
        setTerminalStateSnapshot(nextState)
        setExitInfo(null)
        connectOnceRef.current = false
        replayedBufferRef.current = null
        terminalRef.current?.reset()
    }, [sessionId, terminalId])

    const {
        state: terminalState,
        connect,
        write,
        resize,
        close,
        disconnect,
        onOutput,
        onExit,
    } = useTerminalSocket({
        token,
        sessionId,
        terminalId,
        baseUrl,
        onTerminalNotFound: handleTerminalNotFound
    })

    useEffect(() => {
        closeRef.current = close
        disconnectRef.current = disconnect
    }, [close, disconnect])

    useEffect(() => {
        setTerminalStateSnapshot(getTerminalSessionState(sessionId))
        setExitInfo(null)
        connectOnceRef.current = false
        replayedBufferRef.current = null
    }, [sessionId])

    // Reset connection flag when component mounts (e.g., when navigating back to terminal page)
    useEffect(() => {
        connectOnceRef.current = false
    }, [])

    const replayStoredBuffer = useCallback((terminal: Terminal | null, outputBuffer: string) => {
        if (!terminal) {
            return
        }
        if (replayedBufferRef.current === terminalId) {
            return
        }
        terminal.reset()
        if (outputBuffer) {
            terminal.write(outputBuffer)
        }
        replayedBufferRef.current = terminalId
    }, [terminalId])

    useEffect(() => {
        replayedBufferRef.current = null
        replayStoredBuffer(terminalRef.current, terminalStateSnapshot.outputBuffer)
    }, [terminalId, replayStoredBuffer])

    useEffect(() => {
        onOutput((data) => {
            const nextState = appendTerminalSessionOutput(sessionId, data)
            setTerminalStateSnapshot(nextState)
            terminalRef.current?.write(data)
        })
    }, [onOutput, sessionId])

    useEffect(() => {
        onExit((code, signal) => {
            setExitInfo({ code, signal })
            terminalRef.current?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            connectOnceRef.current = false
        })
    }, [onExit])

    useEffect(() => {
        modifierStateRef.current = { ctrl: ctrlActive, alt: altActive }
    }, [ctrlActive, altActive])

    useEffect(() => {
        if (terminalState.status !== 'connected') {
            return
        }
        const nextState = markTerminalSessionConnected(sessionId)
        setTerminalStateSnapshot(nextState)
        replayStoredBuffer(terminalRef.current, nextState.outputBuffer)
        if (pendingReconnectToastRef.current) {
            addToast({
                title: t('terminal.toast.restartedTitle'),
                body: t('terminal.toast.restartedBody'),
                sessionId,
                url: ''
            })
            pendingReconnectToastRef.current = false
        }
    }, [addToast, replayStoredBuffer, sessionId, terminalState.status])

    const resetModifiers = useCallback(() => {
        setCtrlActive(false)
        setAltActive(false)
    }, [])

    const dispatchSequence = useCallback(
        (sequence: string, modifierState: ModifierState) => {
            write(applyModifierState(sequence, modifierState))
            if (shouldResetModifiers(sequence, modifierState)) {
                resetModifiers()
            }
        },
        [write, resetModifiers]
    )

    const handleTerminalCopyShortcut = useCallback((event: KeyboardEvent) => {
        const isCopyKey = event.key.toLowerCase() === 'c'
        const isCopyShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        if (!isCopyKey || !isCopyShortcut) {
            return true
        }

        const terminal = terminalRef.current
        const hasSelection = terminal?.hasSelection() ?? false
        if (!terminal || !hasSelection) {
            return true
        }

        const selectionText = terminal.getSelection()
        if (!selectionText) {
            return true
        }

        event.preventDefault()
        event.stopPropagation()

        void safeCopyToClipboard(selectionText).catch(() => {
            setManualPasteText(selectionText)
            setPasteDialogOpen(true)
        })
        return false
    }, [])

    const handleTerminalMount = useCallback(
        (terminal: Terminal) => {
            terminalRef.current = terminal
            terminal.attachCustomKeyEventHandler(handleTerminalCopyShortcut)
            inputDisposableRef.current?.dispose()
            inputDisposableRef.current = terminal.onData((data) => {
                const modifierState = modifierStateRef.current
                dispatchSequence(data, modifierState)
            })
            replayStoredBuffer(terminal, terminalStateSnapshot.outputBuffer)
        },
        [dispatchSequence, handleTerminalCopyShortcut, replayStoredBuffer]
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
    }, [session?.active, connect, terminalId])

    useEffect(() => {
        connectOnceRef.current = false
        setExitInfo(null)
        disconnect()
    }, [sessionId, disconnect])

    // Cleanup on component unmount.
    // We disconnect the web socket here so Hub can detach the terminal from the old socket.
    // The terminal process itself remains alive in the registry and can be reattached
    // when the user navigates back to this page within the idle timeout window.
    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            disconnectRef.current()
        }
    }, [])

    useEffect(() => {
        if (session?.active === false) {
            disconnect()
            connectOnceRef.current = false
        }
    }, [session?.active, disconnect])

    useEffect(() => {
        if (terminalState.status === 'error') {
            connectOnceRef.current = false
            return
        }
        if (
            terminalState.status === 'connecting'
            || terminalState.status === 'connected'
            || terminalState.status === 'reconnecting'
        ) {
            setExitInfo(null)
        }
    }, [terminalState.status])

    const quickInputDisabled = !session?.active || terminalState.status !== 'connected'

    const writePlainInput = useCallback((text: string) => {
        if (!text || quickInputDisabled) {
            return false
        }
        write(text)
        resetModifiers()
        terminalRef.current?.focus()
        return true
    }, [quickInputDisabled, write, resetModifiers])

    const handlePasteAction = useCallback(async () => {
        if (quickInputDisabled) {
            return
        }
        const readClipboard = navigator.clipboard?.readText
        if (readClipboard) {
            try {
                const clipboardText = await readClipboard.call(navigator.clipboard)
                if (!clipboardText) {
                    return
                }
                if (writePlainInput(clipboardText)) {
                    return
                }
            } catch {
                // Fall through to manual paste modal.
            }
        }
        setManualPasteText('')
        setPasteDialogOpen(true)
    }, [quickInputDisabled, writePlainInput])

    const handleManualPasteSubmit = useCallback(() => {
        if (!manualPasteText.trim()) {
            return
        }
        if (writePlainInput(manualPasteText)) {
            setPasteDialogOpen(false)
            setManualPasteText('')
        }
    }, [manualPasteText, writePlainInput])

    const handleQuickInput = useCallback(
        (sequence: string) => {
            if (quickInputDisabled) {
                return
            }
            const modifierState = { ctrl: ctrlActive, alt: altActive }
            dispatchSequence(sequence, modifierState)
            terminalRef.current?.focus()
        },
        [quickInputDisabled, ctrlActive, altActive, dispatchSequence]
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

    const handleResetTerminal = useCallback(() => {
        const previousTerminalId = terminalId
        close(previousTerminalId)
        disconnect()
        const nextState = resetTerminalSessionState(sessionId)
        pendingReconnectToastRef.current = false
        setTerminalStateSnapshot(nextState)
        setExitInfo(null)
        connectOnceRef.current = false
        replayedBufferRef.current = null
        terminalRef.current?.reset()
    }, [close, disconnect, sessionId, terminalId])

    if (!session) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label={t('loading.session')} className="text-sm" />
            </div>
        )
    }

    const errorMessage = terminalState.status === 'error' ? terminalState.error : null
    const reconnectingMessage = terminalState.status === 'reconnecting' ? terminalState.reason : null

    return (
        <div className="flex h-full flex-col">
            {session.active ? null : (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        {t('terminal.sessionInactive')}
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

            {reconnectingMessage ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        {t('terminal.reconnecting')}
                    </div>
                </div>
            ) : null}

            {exitInfo ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        {t('terminal.exitStatus', {
                            code: exitInfo.code !== null ? String(exitInfo.code) : '',
                            suffix: exitInfo.signal ? ` (${exitInfo.signal})` : ''
                        })}
                    </div>
                </div>
            ) : null}

            <div className="flex-1 overflow-hidden bg-[var(--app-bg)]">
                <div className="mx-auto h-full w-full max-w-content p-3">
                    <TerminalView onMount={handleTerminalMount} onResize={handleResize} className="h-full w-full" />
                </div>
            </div>

            <div className="border-t border-[var(--app-border)] bg-[var(--app-bg)] pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-3">
                    <div className="flex flex-col gap-2 py-2">
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    void handlePasteAction()
                                }}
                                disabled={quickInputDisabled}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {t('button.paste')}
                            </button>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={handleResetTerminal}
                                disabled={!session.active}
                            >
                                {t('terminal.action.reset')}
                            </Button>
                        </div>
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

            <Dialog
                open={pasteDialogOpen}
                onOpenChange={(open) => {
                    setPasteDialogOpen(open)
                    if (!open) {
                        setManualPasteText('')
                    }
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('terminal.paste.fallbackTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('terminal.paste.fallbackDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <textarea
                        value={manualPasteText}
                        onChange={(event) => setManualPasteText(event.target.value)}
                        placeholder={t('terminal.paste.placeholder')}
                        className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        autoCapitalize="none"
                        autoCorrect="off"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setPasteDialogOpen(false)
                                setManualPasteText('')
                            }}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleManualPasteSubmit}
                            disabled={!manualPasteText.trim()}
                        >
                            {t('button.paste')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
