import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })

    return useCallback(() => {
        // Use explicit path navigation for consistent behavior across all environments
        if (pathname.startsWith('/sessions/')) {
            navigate({ to: '/sessions' })
            return
        }

        if (pathname.endsWith('/spawn')) {
            navigate({ to: '/machines' })
            return
        }

        if (pathname.startsWith('/machines')) {
            navigate({ to: '/sessions' })
            return
        }

        // Fallback to history.back() for other cases
        router.history.back()
    }, [navigate, pathname, router])
}
