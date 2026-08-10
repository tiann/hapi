import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'

function getNamespace(token: string | null): string | null {
    if (!token) return null
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}

/**
 * Hub opt-in to show compact AGENT_NOTIFY_SUMMARY in chat.
 * Default false (hide/strip). Owner-only hub setting; others stay hidden.
 */
export function useSessionSummaryInChat(): boolean {
    const { api, token } = useAppContext()
    const isOwner = getNamespace(token) === 'default'
    const query = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHubSettings()
        },
        enabled: Boolean(api) && isOwner,
        staleTime: 30_000,
        retry: false,
    })
    return query.data?.sessionSummaryInChat === true
}
