import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function usePiForkMessages(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}) {
    return useQuery({
        queryKey: queryKeys.sessionPiForkMessages(args.sessionId ?? ''),
        queryFn: () => args.api!.getPiForkMessages(args.sessionId!),
        enabled: !!args.api && !!args.sessionId && (args.enabled ?? true),
        staleTime: 60_000,
    })
}
