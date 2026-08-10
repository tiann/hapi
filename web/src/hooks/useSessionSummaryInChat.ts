import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'

/**
 * Hub opt-in to show compact AGENT_NOTIFY_SUMMARY in chat.
 * Default false (hide/strip). Any authenticated client can read the flag;
 * only the hub owner can change it (Settings → General).
 */
export function useSessionSummaryInChat(): boolean {
    const { api } = useAppContext()
    const query = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHubSettings()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchInterval: 30_000,
        retry: false,
    })
    return query.data?.sessionSummaryInChat === true
}
