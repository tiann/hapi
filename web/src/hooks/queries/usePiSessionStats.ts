import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function usePiSessionStats(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}) {
    return useQuery({
        queryKey: queryKeys.sessionPiStats(args.sessionId ?? ''),
        queryFn: () => args.api!.getPiSessionStats(args.sessionId!),
        enabled: !!args.api && !!args.sessionId && (args.enabled ?? true),
        staleTime: 30_000,
    })
}
