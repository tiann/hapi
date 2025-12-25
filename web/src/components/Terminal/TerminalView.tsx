import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

function resolveThemeColors(): { background: string; foreground: string; selectionBackground: string } {
    const styles = getComputedStyle(document.documentElement)
    const background = styles.getPropertyValue('--app-bg').trim() || '#000000'
    const foreground = styles.getPropertyValue('--app-fg').trim() || '#ffffff'
    const selectionBackground = styles.getPropertyValue('--app-subtle-bg').trim() || 'rgba(255, 255, 255, 0.2)'
    return { background, foreground, selectionBackground }
}

export function TerminalView(props: {
    onMount?: (terminal: Terminal) => void
    onResize?: (cols: number, rows: number) => void
    className?: string
}) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const onMountRef = useRef(props.onMount)
    const onResizeRef = useRef(props.onResize)

    useEffect(() => {
        onMountRef.current = props.onMount
    }, [props.onMount])

    useEffect(() => {
        onResizeRef.current = props.onResize
    }, [props.onResize])

    useEffect(() => {
        const container = containerRef.current
        if (!container) {
            return
        }

        const { background, foreground, selectionBackground } = resolveThemeColors()
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 13,
            theme: {
                background,
                foreground,
                cursor: foreground,
                selectionBackground
            },
            convertEol: true
        })

        const fitAddon = new FitAddon()
        const webLinksAddon = new WebLinksAddon()
        terminal.loadAddon(fitAddon)
        terminal.loadAddon(webLinksAddon)
        terminal.open(container)

        const resizeTerminal = () => {
            fitAddon.fit()
            onResizeRef.current?.(terminal.cols, terminal.rows)
        }

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(resizeTerminal)
        })
        observer.observe(container)

        requestAnimationFrame(resizeTerminal)
        onMountRef.current?.(terminal)

        return () => {
            observer.disconnect()
            terminal.dispose()
        }
    }, [])

    return (
        <div
            ref={containerRef}
            className={`h-full w-full ${props.className ?? ''}`}
        />
    )
}
