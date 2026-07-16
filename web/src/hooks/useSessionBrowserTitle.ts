import { useEffect } from 'react'
import type { Session } from '@/types/api'
import { getSessionTitle } from '@/lib/sessionTitle'

const APP_TITLE = 'HAPI'

export function useSessionBrowserTitle(session: Session | null): void {
    const sessionTitle = session ? getSessionTitle(session) : null

    useEffect(() => {
        document.title = sessionTitle ? `${sessionTitle} - ${APP_TITLE}` : APP_TITLE

        return () => {
            document.title = APP_TITLE
        }
    }, [sessionTitle])
}
