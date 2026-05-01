import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { ApiClient } from '@/api/client'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { useAppContext } from '@/lib/app-context'
import type { EditorTab } from '@/hooks/useEditorState'
import { useSession } from '@/hooks/queries/useSession'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'

function EditorTerminalBody(props: {
    api: ApiClient | null
    tab: EditorTab
    onAddToChat?: (text: string) => void
}) {
    const { token, baseUrl } = useAppContext()
    const sessionId = props.tab.sessionId ?? null
    const machineId = props.tab.machineId ?? null
    const cwd = props.tab.cwd ?? undefined
    const { session, isLoading } = useSession(props.api, sessionId)
    const terminalSupported = sessionId ? isRemoteTerminalSupported(session?.metadata) : true
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const selectionDisposeRef = useRef<() => void>(() => {})
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
    const [terminalSelection, setTerminalSelection] = useState<string | null>(null)
    const [terminalMousePos, setTerminalMousePos] = useState<{ x: number; y: number } | null>(null)
    const terminalContainerRef = useRef<HTMLDivElement | null>(null)

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
        baseUrl,
        sessionId: sessionId ?? '',
        machineId: machineId ?? '',
        cwd,
        terminalId: props.tab.id
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
        })
    }, [onExit])

    const handleTerminalMount = useCallback((terminal: Terminal) => {
        terminalRef.current = terminal
        inputDisposableRef.current?.dispose()

        // Dispose previous selection + mouse listeners
        selectionDisposeRef.current()

        // Selection tracking for "Add to chat"
        const selectionDisposable = terminal.onSelectionChange(() => {
            const sel = terminal.getSelection()
            setTerminalSelection(sel || null)
        })

        // Track mouse position on terminal element (xterm captures mouse events,
        // so we can't rely on wrapper div onMouseUp)
        const termElement = terminal.element
        const handleMouseUp = (e: MouseEvent) => {
            const rect = termElement.getBoundingClientRect()
            setTerminalMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        }
        termElement.addEventListener('mouseup', handleMouseUp)

        selectionDisposeRef.current = () => {
            selectionDisposable.dispose()
            termElement.removeEventListener('mouseup', handleMouseUp)
            setTerminalSelection(null)
            setTerminalMousePos(null)
        }

        inputDisposableRef.current = terminal.onData((data) => {
            write(data)
        })
        terminal.focus()
    }, [write])

    const handleResize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const isScopeActive = machineId ? true : Boolean(session?.active)
        if ((!sessionId && !machineId) || !isScopeActive || !terminalSupported) {
            return
        }
        if (!connectOnceRef.current) {
            connectOnceRef.current = true
            connect(cols, rows)
            return
        }
        resize(cols, rows)
    }, [connect, machineId, resize, session?.active, sessionId, terminalSupported])

    useEffect(() => {
        const isScopeActive = machineId ? true : Boolean(session?.active)
        if ((!sessionId && !machineId) || !isScopeActive || !terminalSupported || connectOnceRef.current) {
            return
        }
        const size = lastSizeRef.current
        if (!size) {
            return
        }
        connectOnceRef.current = true
        connect(size.cols, size.rows)
    }, [connect, machineId, session?.active, sessionId, terminalSupported])

    useEffect(() => {
        if (terminalState.status === 'connecting' || terminalState.status === 'connected') {
            setExitInfo(null)
        }
    }, [terminalState.status])

    useEffect(() => {
        if ((sessionId && session?.active === false) || !terminalSupported) {
            disconnect()
            connectOnceRef.current = false
        }
    }, [disconnect, session?.active, sessionId, terminalSupported])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            selectionDisposeRef.current()
            connectOnceRef.current = false
            disconnect()
        }
    }, [disconnect])

    if (!sessionId && !machineId) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-[var(--app-hint)]">
                Select or create a session to use terminal
            </div>
        )
    }

    if (sessionId && isLoading) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-[var(--app-hint)]">
                Loading terminal session...
            </div>
        )
    }

    const status = terminalState.status
    const errorMessage = sessionId && !session
        ? 'Terminal session is unavailable.'
        : !terminalSupported
        ? 'Remote terminal is not supported on this host.'
        : terminalState.status === 'error'
          ? terminalState.error
          : session?.active === false
            ? 'Session is inactive. Terminal is unavailable.'
            : null

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-2 py-1 text-[10px] text-[var(--app-hint)]">
                <span className={`h-2 w-2 rounded-full ${
                    status === 'connected'
                        ? 'bg-emerald-500'
                        : status === 'connecting'
                          ? 'bg-amber-500'
                          : status === 'error'
                            ? 'bg-red-500'
                            : 'bg-[var(--app-hint)]'
                }`} />
                <span>{status}</span>
                {exitInfo ? (
                    <span>
                        exited{exitInfo.code !== null ? ` with code ${exitInfo.code}` : ''}
                        {exitInfo.signal ? ` (${exitInfo.signal})` : ''}
                    </span>
                ) : null}
            </div>
            {errorMessage ? (
                <div className="border-b border-[var(--app-border)] px-2 py-1 text-xs text-red-500">
                    {errorMessage}
                </div>
            ) : null}
            <div
                ref={terminalContainerRef}
                className="min-h-0 flex-1 overflow-hidden p-2 relative"
            >
                {terminalSupported && (machineId || session?.active) ? (
                    <TerminalView onMount={handleTerminalMount} onResize={handleResize} className="h-full w-full" />
                ) : (
                    <div className="flex h-full items-center justify-center rounded border border-[var(--app-border)] text-xs text-[var(--app-hint)]">
                        {errorMessage}
                    </div>
                )}
                {terminalSelection && terminalMousePos && props.onAddToChat && (
                    <button
                        type="button"
                        aria-label="Add selection to chat"
                        className="absolute z-20 rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300 shadow-md hover:bg-violet-500 hover:text-white hover:border-violet-400 transition-colors"
                        style={{
                            top: Math.max(0, terminalMousePos.y - 28) + 'px',
                            left: Math.max(0, terminalMousePos.x - 45) + 'px',
                        }}
                        onClick={() => {
                            if (terminalSelection && props.onAddToChat) {
                                props.onAddToChat(terminalSelection)
                            }
                            setTerminalSelection(null)
                            setTerminalMousePos(null)
                        }}
                    >
                        Add to chat
                    </button>
                )}
            </div>
        </div>
    )
}

export function EditorTerminal(props: {
    api: ApiClient | null
    tabs: EditorTab[]
    activeTabId: string | null
    isCollapsed: boolean
    onSelectTab: (tabId: string) => void
    onCloseTab: (tabId: string) => void
    onOpenTerminal: () => void
    onToggleCollapsed: () => void
    onAddToChat?: (text: string) => void
}) {
    const terminalTabs = useMemo(
        () => props.tabs.filter((tab) => tab.type === 'terminal'),
        [props.tabs]
    )
    const activeTerminal = terminalTabs.find((tab) => tab.id === props.activeTabId) ?? terminalTabs[0] ?? null

    return (
        <div className="flex h-full min-h-0 flex-col border-t border-[var(--app-border)] bg-[var(--app-bg)]">
            <div className="flex h-8 shrink-0 items-center border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                <button
                    type="button"
                    aria-label={props.isCollapsed ? 'Expand terminal' : 'Collapse terminal'}
                    className="flex h-full w-7 items-center justify-center text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => props.onToggleCollapsed()}
                    title={props.isCollapsed ? 'Expand terminal' : 'Collapse terminal'}
                >
                    {props.isCollapsed ? '›' : '⌄'}
                </button>
                <div className="px-2 text-xs font-medium text-[var(--app-hint)]">Terminal</div>
                <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
                    {terminalTabs.map((tab) => {
                        const isActive = tab.id === activeTerminal?.id
                        return (
                            <div
                                key={tab.id}
                                className={`flex items-center gap-1 border-l border-[var(--app-border)] px-2 py-1 text-xs ${
                                    isActive ? 'bg-[var(--app-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'
                                }`}
                            >
                                <button
                                    type="button"
                                    aria-label={`Select terminal ${tab.label}`}
                                    className="max-w-[140px] truncate hover:text-[var(--app-fg)]"
                                    onClick={() => props.onSelectTab(tab.id)}
                                >
                                    {tab.label}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Close terminal ${tab.label}`}
                                    className="text-[10px] hover:text-[var(--app-fg)]"
                                    onClick={() => props.onCloseTab(tab.id)}
                                >
                                    ✕
                                </button>
                            </div>
                        )
                    })}
                </div>
                <button
                    type="button"
                    aria-label="Open terminal"
                    className="h-full px-3 text-sm text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => props.onOpenTerminal()}
                    title="Open terminal"
                >
                    +
                </button>
            </div>

            {terminalTabs.length > 0 ? (
                <div className={`min-h-0 flex-1 overflow-hidden ${props.isCollapsed ? 'hidden' : ''}`}>
                    {terminalTabs.map((tab) => {
                        const isActive = tab.id === activeTerminal?.id
                        return (
                            <div key={tab.id} className={`h-full min-h-0 ${isActive ? 'block' : 'hidden'}`}>
                                <EditorTerminalBody api={props.api} tab={tab} onAddToChat={props.onAddToChat} />
                            </div>
                        )
                    })}
                </div>
            ) : !props.isCollapsed ? (
                <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-[var(--app-hint)]">
                    <div>No terminal open</div>
                </div>
            ) : null}
        </div>
    )
}
