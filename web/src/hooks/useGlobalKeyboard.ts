import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

type Options = {
    // When in grid mode, Cmd+1-9 calls this instead of navigating
    onSelectIndex?: (n: number) => void
    // Cmd+K: search to add a new session (to grid, or navigate in normal mode)
    onOpenSearch?: () => void
    // Cmd+Shift+F: search to replace the currently focused grid cell
    onReplaceCell?: () => void
    // Cmd+Shift+X — close/remove the currently focused grid cell
    onCloseCell?: () => void
    // Alt+hjkl — move focus between grid cells
    onMoveFocus?: (dir: 'h' | 'j' | 'k' | 'l') => void
    // Cmd+' — toggle strip/grid layout
    onToggleStrip?: () => void
}

export function useGlobalKeyboard(sessions: { id: string }[], options: Options = {}) {
    const navigate = useNavigate()

    useEffect(() => {
        // Don't register shortcuts when running inside a grid iframe
        if (window.self !== window.top) return

        const onKeyDown = (e: KeyboardEvent) => {
            // Alt+h/j/k/l — move focus between grid cells (vim-style)
            if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && options.onMoveFocus) {
                const dir = e.code === 'KeyH' ? 'h' : e.code === 'KeyJ' ? 'j' : e.code === 'KeyK' ? 'k' : e.code === 'KeyL' ? 'l' : null
                if (dir) { e.preventDefault(); options.onMoveFocus(dir as 'h'|'j'|'k'|'l'); return }
            }
            if (!e.metaKey) return

            // Cmd+K — search to add/navigate
            if ((e.key === 'k' || e.key === 'K') && !e.shiftKey) {
                e.preventDefault()
                options.onOpenSearch?.()
                return
            }

            // Cmd+Shift+F — search to replace current focused grid cell
            if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
                e.preventDefault()
                options.onReplaceCell?.()
                return
            }

            // Cmd+Shift+X — close current focused grid cell
            if ((e.key === 'x' || e.key === 'X') && e.shiftKey) {
                e.preventDefault()
                options.onCloseCell?.()
                return
            }

            // Cmd+' — toggle strip/grid layout
            if (e.key === "'") {
                e.preventDefault()
                options.onToggleStrip?.()
                return
            }

            // Cmd+; — toggle grid view
            if (e.key === ';') {
                const isGrid = window.location.pathname === '/grid'
                e.preventDefault()
                if (isGrid) {
                    navigate({ to: '/sessions' })
                } else {
                    navigate({ to: '/grid' })
                }
                return
            }

            // Cmd+1-9
            const n = parseInt(e.key)
            if (n >= 1 && n <= 9) {
                e.preventDefault()
                if (options.onSelectIndex) {
                    // Grid mode: focus nth pinned iframe
                    options.onSelectIndex(n)
                } else {
                    // Normal mode: navigate to nth session
                    const session = sessions[n - 1]
                    if (session) {
                        navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })
                    }
                }
                return
            }

            // Cmd+Shift+N — new session
            if ((e.key === 'n' || e.key === 'N') && e.shiftKey) {
                e.preventDefault()
                navigate({ to: '/sessions/new' })
            }
        }

        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [navigate, sessions, options.onSelectIndex, options.onOpenSearch, options.onReplaceCell, options.onCloseCell, options.onMoveFocus, options.onToggleStrip])
}
