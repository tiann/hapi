import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import { sessionReadScope, startSessionReadSync } from '@/lib/sessionReadSync'
import type { SessionReadState } from '@hapi/protocol'

export function useSessionReadSync(api: ApiClient | null, baseUrl: string, token: string | null) {
    const controller = useRef<ReturnType<typeof startSessionReadSync> | null>(null)
    let scope: string | null = null
    if (token) {
        try { scope = sessionReadScope(baseUrl, token) } catch { /* Authentication is not ready. */ }
    }
    useLayoutEffect(() => {
        if (!api || scope === null) return
        const sync = startSessionReadSync(api, scope)
        controller.current = sync
        return () => { controller.current = null; sync.stop() }
    }, [api, scope])

    const refresh = useCallback(() => { void controller.current?.refresh() }, [])
    const receive = useCallback((states: SessionReadState[]) => { controller.current?.receive(states) }, [])
    return { refresh, receive }
}
