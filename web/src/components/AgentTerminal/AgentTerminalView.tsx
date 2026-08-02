import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAgentTerminalSocket } from '@/hooks/useAgentTerminalSocket'
import { useQuickKeyInput, QuickKeyRows } from '@/components/QuickKeys/QuickKeys'
import { useAppContext } from '@/lib/app-context'

function resolveThemeColors(): { background: string; foreground: string; selectionBackground: string } {
    const styles = getComputedStyle(document.documentElement)
    const background = styles.getPropertyValue('--app-bg').trim() || '#000000'
    const foreground = styles.getPropertyValue('--app-fg').trim() || '#ffffff'
    const selectionBackground = styles.getPropertyValue('--app-subtle-bg').trim() || 'rgba(255, 255, 255, 0.2)'
    return { background, foreground, selectionBackground }
}

type AgentTerminalViewProps = {
    sessionId: string
    visible: boolean
    className?: string
}

// Interactive view of the agent PTY. The chat composer remains the primary way
// to send messages (multiline, IME, mobile), but this terminal also accepts raw
// keystrokes + quick keys so a viewer can drive TUI screens the composer cannot
// express (escape a /usage screen, answer a /model dialog, send Ctrl-C).
export function AgentTerminalView(props: AgentTerminalViewProps) {
    const { sessionId, visible, className } = props
    const { token, baseUrl } = useAppContext()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)

    const {
        state,
        connect,
        disconnect,
        resubscribe,
        unsubscribe,
        onOutput,
        resize,
        sendInput,
    } = useAgentTerminalSocket({
        baseUrl,
        token,
        sessionId,
    })

    // Raw keystrokes (terminal typing AND quick keys) share one sticky-modifier
    // state, then go to the agent PTY via sendInput.
    const { ctrlActive, altActive, dispatch, toggleModifier } = useQuickKeyInput({ onSend: sendInput })

    const onOutputRef = useRef(onOutput)
    useEffect(() => {
        onOutputRef.current = onOutput
    }, [onOutput])

    const resizeRef = useRef(resize)
    useEffect(() => {
        resizeRef.current = resize
    }, [resize])

    // Dispatch is stable, but the terminal is created once (mount effect), so
    // read it through a ref to avoid re-creating the terminal on identity change.
    const dispatchRef = useRef(dispatch)
    useEffect(() => {
        dispatchRef.current = dispatch
    }, [dispatch])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const abortController = new AbortController()
        const { background, foreground, selectionBackground } = resolveThemeColors()

        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            theme: {
                background,
                foreground,
                cursor: foreground,
                selectionBackground,
            },
            convertEol: true,
            customGlyphs: true,
            cols: 80,
            rows: 12,
        })

        const fitAddon = new FitAddon()
        fitAddonRef.current = fitAddon
        terminal.loadAddon(fitAddon)
        terminal.open(container)

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                fitAddon.fit()
                // Push the fitted size to the agent PTY so the TUI re-renders at
                // the viewer's dimensions (and repaints — no black screen).
                resizeRef.current(terminal.cols, terminal.rows)
            })
        })
        observer.observe(container)

        onOutputRef.current((data) => {
            terminal.write(data)
        })

        // Interactive: forward typed keystrokes to the agent PTY (with sticky
        // modifiers applied) so a viewer can drive TUI screens the chat composer
        // cannot express (e.g. escape a /usage screen, answer a dialog).
        const inputDisposable = terminal.onData((data) => {
            dispatchRef.current(data)
        })

        abortController.signal.addEventListener('abort', () => {
            observer.disconnect()
            inputDisposable.dispose()
            fitAddon.dispose()
            terminal.dispose()
        })

        requestAnimationFrame(() => {
            fitAddon.fit()
        })
        terminalRef.current = terminal

        return () => abortController.abort()
    }, [])

    useEffect(() => {
        connect()
        return () => disconnect()
    }, [connect, disconnect])

    useEffect(() => {
        if (!visible) return
        resubscribe()
        requestAnimationFrame(() => {
            fitAddonRef.current?.fit()
            const terminal = terminalRef.current
            if (terminal) {
                // On (re)entry: sync size and trigger a repaint so the current
                // screen shows instead of a stale/black buffer replay.
                resizeRef.current(terminal.cols, terminal.rows)
            }
        })
        // Leaving the terminal view (hidden or unmounted) → unsubscribe so the
        // CLI can stop streaming the PTY when no viewers remain.
        return () => unsubscribe()
    }, [visible, resubscribe, unsubscribe])

    const statusColor = state.status === 'connected'
        ? 'bg-emerald-500'
        : state.status === 'connecting'
            ? 'bg-amber-400 animate-pulse'
            : state.status === 'error'
                ? 'bg-red-500'
                : 'bg-[var(--app-hint)]'

    return (
        <div className={`flex flex-col min-h-0 ${className ?? ''}`}>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--app-border)] bg-[var(--app-secondary-bg)]">
                <span className={`h-2 w-2 rounded-full ${statusColor}`} />
                <span className="text-xs text-[var(--app-hint)]">
                    {state.status === 'connected' ? 'Agent terminal connected' :
                     state.status === 'connecting' ? 'Connecting...' :
                     state.status === 'error' ? `Error: ${state.error}` :
                     'Disconnected'}
                </span>
            </div>

            <div ref={containerRef} className="flex-1 min-h-0 p-2 bg-[var(--app-bg)]" />

            <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
                <QuickKeyRows
                    ctrlActive={ctrlActive}
                    altActive={altActive}
                    disabled={state.status !== 'connected'}
                    onPress={(sequence) => {
                        dispatch(sequence)
                        terminalRef.current?.focus()
                    }}
                    onToggleModifier={(modifier) => {
                        toggleModifier(modifier)
                        terminalRef.current?.focus()
                    }}
                />
            </div>
        </div>
    )
}
