import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import type { Terminal } from '@xterm/xterm'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { useQuickKeyInput, QuickKeyRows } from '@/components/QuickKeys/QuickKeys'
import { useTranslation } from '@/lib/use-translation'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { LoadingState } from '@/components/LoadingState'
import { Button } from '@/components/ui/button'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
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

function ConnectionIndicator(props: { status: 'idle' | 'connecting' | 'connected' | 'error' }) {
    const isConnected = props.status === 'connected'
    const isConnecting = props.status === 'connecting'
    const label = isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Offline'
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

const EXIT_NAVIGATION_DELAY_MS = 700

export default function TerminalPage() {
    const { t } = useTranslation()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/terminal' })
    const { api, token, baseUrl } = useAppContext()
    const goBack = useAppGoBack()
    const { session } = useSession(api, sessionId)
    const terminalSupported = isRemoteTerminalSupported(session?.metadata)
    // A per-viewer-unique terminal id. Two browsers/tabs/devices viewing the
    // same session must each drive their own shell: the hub registry evicts a
    // reused id arriving from a different socket as a stale reconnect
    // (terminalRegistry.ts), which would otherwise let a second viewer hijack
    // the first viewer's PTY. The id is intentionally NOT derived from sessionId
    // alone — scrollback survives navigation via the sessionId-keyed buffer
    // (userTerminalBuffer.ts), not via a stable id. Held in a ref so it stays
    // constant across re-renders and transient socket reconnects, and
    // regenerates only when the route switches to a different session.
    const terminalIdRef = useRef<{ sessionId: string; id: string } | null>(null)
    if (terminalIdRef.current?.sessionId !== sessionId) {
        terminalIdRef.current = { sessionId, id: `term-${sessionId}-${crypto.randomUUID()}` }
    }
    const terminalId = terminalIdRef.current.id
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const exitNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false)
    const [manualPasteText, setManualPasteText] = useState('')

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

    useEffect(() => {
        onOutput((data) => {
            terminalRef.current?.write(data)
        })
    }, [onOutput])

    useEffect(() => {
        onExit((code, signal) => {
            setExitInfo({ code, signal })
            terminalRef.current?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
            }
            exitNavTimerRef.current = setTimeout(() => {
                exitNavTimerRef.current = null
                goBack()
            }, EXIT_NAVIGATION_DELAY_MS)
        })
    }, [onExit, goBack])

    // Raw terminal input AND the quick-key buttons share one sticky-modifier
    // state via the dispatcher, so toggling Ctrl then typing sends the control
    // code. onData is intentionally ungated; the buttons gate via `disabled`.
    const { ctrlActive, altActive, dispatch, toggleModifier, resetModifiers } = useQuickKeyInput({ onSend: write })

    const handleTerminalMount = useCallback(
        (terminal: Terminal) => {
            terminalRef.current = terminal
            inputDisposableRef.current?.dispose()
            inputDisposableRef.current = terminal.onData((data) => {
                dispatch(data)
            })
            terminal.focus()
        },
        [dispatch]
    )

    const handleResize = useCallback(
        (cols: number, rows: number) => {
            lastSizeRef.current = { cols, rows }
            if (!session?.active || !terminalSupported) {
                return
            }
            if (!connectOnceRef.current) {
                connectOnceRef.current = true
                connect(cols, rows)
            } else {
                resize(cols, rows)
            }
        },
        [session?.active, terminalSupported, connect, resize]
    )

    useEffect(() => {
        if (!session?.active || !terminalSupported) {
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
    }, [session?.active, terminalSupported, connect])

    useEffect(() => {
        connectOnceRef.current = false
        setExitInfo(null)
        if (exitNavTimerRef.current) {
            clearTimeout(exitNavTimerRef.current)
            exitNavTimerRef.current = null
        }
        disconnect()
    }, [sessionId, disconnect])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            connectOnceRef.current = false
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
                exitNavTimerRef.current = null
            }
            disconnect()
        }
    }, [disconnect])

    useEffect(() => {
        if (session?.active === false || !terminalSupported) {
            disconnect()
            connectOnceRef.current = false
        }
    }, [session?.active, terminalSupported, disconnect])

    useEffect(() => {
        if (terminalState.status === 'connecting' || terminalState.status === 'connected') {
            setExitInfo(null)
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
                exitNavTimerRef.current = null
            }
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
            dispatch(sequence)
            terminalRef.current?.focus()
        },
        [quickInputDisabled, dispatch]
    )

    const handleModifierToggle = useCallback(
        (modifier: 'ctrl' | 'alt') => {
            if (quickInputDisabled) {
                return
            }
            toggleModifier(modifier)
            terminalRef.current?.focus()
        },
        [quickInputDisabled, toggleModifier]
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
    const errorMessage = !terminalSupported
        ? t('terminal.unsupportedWindows')
        : terminalState.status === 'error'
          ? terminalState.error
          : null

    return (
        <div className="flex h-full min-h-0 flex-col">
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
                    <ConnectionIndicator status={status} />
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

            <div className="flex-1 min-h-0 overflow-hidden bg-[var(--app-bg)]">
                <div className="mx-auto h-full w-full max-w-content p-3">
                    {terminalSupported ? (
                        <TerminalView onMount={handleTerminalMount} onResize={handleResize} className="h-full w-full" />
                    ) : (
                        <div className="flex h-full items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                            {t('terminal.unsupportedWindows')}
                        </div>
                    )}
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-t border-[var(--app-border)] pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-3">
                    <div className="flex flex-col gap-2 py-2">
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
                        <QuickKeyRows
                            ctrlActive={ctrlActive}
                            altActive={altActive}
                            disabled={quickInputDisabled}
                            onPress={handleQuickInput}
                            onToggleModifier={handleModifierToggle}
                        />
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
