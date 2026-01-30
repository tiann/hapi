import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { createFontProvider } from '@/lib/terminalFont'

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

        let terminal: Terminal | null = null
        let fitAddon: FitAddon | null = null
        let webLinksAddon: WebLinksAddon | null = null
        let canvasAddon: CanvasAddon | null = null
        let observer: ResizeObserver | null = null

        // Load font and create terminal in the same effect
        createFontProvider().then(fontProvider => {
            if (!container.isConnected) return // Component unmounted

            const { background, foreground, selectionBackground } = resolveThemeColors()
            terminal = new Terminal({
                cursorBlink: true,
                fontFamily: fontProvider.getFontFamily(),
                fontSize: 13,
                theme: {
                    background,
                    foreground,
                    cursor: foreground,
                    selectionBackground
                },
                convertEol: true,
                customGlyphs: true
            })

            fitAddon = new FitAddon()
            webLinksAddon = new WebLinksAddon()
            canvasAddon = new CanvasAddon()
            terminal.loadAddon(fitAddon)
            terminal.loadAddon(webLinksAddon)
            terminal.loadAddon(canvasAddon)
            terminal.open(container)

            const resizeTerminal = () => {
                fitAddon?.fit()
                if (terminal) {
                    onResizeRef.current?.(terminal.cols, terminal.rows)
                }
            }

            observer = new ResizeObserver(() => {
                requestAnimationFrame(resizeTerminal)
            })
            observer.observe(container)

            requestAnimationFrame(resizeTerminal)
            onMountRef.current?.(terminal)
        })

        return () => {
            observer?.disconnect()
            fitAddon?.dispose()
            webLinksAddon?.dispose()
            canvasAddon?.dispose()
            terminal?.dispose()
        }
    }, [])

    return (
        <div
            ref={containerRef}
            className={`h-full w-full ${props.className ?? ''}`}
        />
    )
}
