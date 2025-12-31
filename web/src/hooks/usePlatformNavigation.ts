import { useEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { getTelegramWebApp } from './useTelegram'
import { isLarkEnvironment } from './useLark'
import { useAppGoBack } from './useAppGoBack'

export function usePlatformNavigation() {
    const goBack = useAppGoBack()
    const pathname = useLocation({ select: (location) => location.pathname })

    // Telegram Back Button
    useEffect(() => {
        const tg = getTelegramWebApp()
        const backButton = tg?.BackButton
        if (!backButton) return

        if (pathname === '/' || pathname === '/sessions') {
            backButton.offClick(goBack)
            backButton.hide()
            return
        }

        backButton.show()
        backButton.onClick(goBack)
        return () => {
            backButton.offClick(goBack)
            backButton.hide()
        }
    }, [goBack, pathname])

    // Lark Title & Navigation
    useEffect(() => {
        if (!isLarkEnvironment()) return

        // Set title based on path (Simplified)
        let title = 'HAPI'
        if (pathname.startsWith('/sessions/')) {
            if (pathname.endsWith('/files')) title = 'Files'
            else if (pathname.endsWith('/terminal')) title = 'Terminal'
            else title = 'Session'
        } else if (pathname === '/sessions') {
            title = 'Sessions'
        }
        
        document.title = title
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tt = window.tt as any
        if (tt && tt.setNavigationBarTitle) {
            tt.setNavigationBarTitle({ title })
        }
    }, [pathname])
}
