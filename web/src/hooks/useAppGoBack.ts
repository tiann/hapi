import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'

export function getSettingsBackTarget(pathname: string): string | null {
    if (pathname === '/settings') return '/sessions'
    if (pathname === '/settings/voice/advanced' || pathname === '/settings/voice/voices') return '/settings/voice'
    if (pathname.startsWith('/settings/')) return '/settings'
    return null
}

export function getSessionFilesBackSearch(search: unknown): {
    tab?: 'directories'
    query?: string
} {
    if (!search || typeof search !== 'object') return {}

    const currentSearch = search as { tab?: unknown; query?: unknown }
    return {
        ...(currentSearch.tab === 'directories' ? { tab: 'directories' as const } : {}),
        ...(typeof currentSearch.query === 'string' && currentSearch.query.length > 0
            ? { query: currentSearch.query }
            : {}),
    }
}

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })
    const search = useLocation({ select: (location) => location.search })

    return useCallback(() => {
        // Use explicit path navigation for consistent behavior across all environments
        if (pathname === '/sessions/new') {
            navigate({ to: '/sessions' })
            return
        }

        // Settings uses explicit parent routes so mobile drill-down remains predictable.
        const settingsBackTarget = getSettingsBackTarget(pathname)
        if (settingsBackTarget) {
            navigate({ to: settingsBackTarget })
            return
        }

        // Chat file links return to the conversation; file-browser previews
        // retain their deterministic parent route and browsing context.
        if (pathname.match(/^\/sessions\/[^/]+\/file$/)) {
            const origin = search && typeof search === 'object' && 'origin' in search
                ? (search as { origin?: unknown }).origin
                : undefined
            if (origin === 'chat') {
                navigate({ to: pathname.replace(/\/file$/, '') })
                return
            }

            const filesPath = pathname.replace(/\/file$/, '/files')
            navigate({ to: filesPath, search: getSessionFilesBackSearch(search) })
            return
        }

        // For session routes, navigate to parent path
        if (pathname.startsWith('/sessions/')) {
            const parentPath = pathname.replace(/\/[^/]+$/, '') || '/sessions'
            navigate({ to: parentPath })
            return
        }

        // Fallback to history.back() for other cases
        router.history.back()
    }, [navigate, pathname, router, search])
}
