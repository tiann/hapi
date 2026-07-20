import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'

export function getSettingsBackTarget(pathname: string): string | null {
    if (pathname === '/settings') return '/sessions'
    if (pathname === '/settings/voice/advanced' || pathname === '/settings/voice/voices') return '/settings/voice'
    if (pathname.startsWith('/settings/')) return '/settings'
    return null
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

        // For single file view, go back to files list
        if (pathname.match(/^\/sessions\/[^/]+\/file$/)) {
            const filesPath = pathname.replace(/\/file$/, '/files')

            const tab = (search && typeof search === 'object' && 'tab' in search)
                ? (search as { tab?: unknown }).tab
                : undefined
            const nextSearch = tab === 'directories' ? { tab: 'directories' as const } : {}

            navigate({ to: filesPath, search: nextSearch })
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
