import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { isTelegramApp } from '@/hooks/useTelegram'

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })

    return useCallback(() => {
        if (!isTelegramApp()) {
            router.history.back()
            return
        }

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
        }
    }, [navigate, pathname, router])
}
