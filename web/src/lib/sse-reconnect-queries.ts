import { queryKeys } from '@/lib/query-keys'

/**
 * Query keys invalidated on global SSE reconnect (`App.handleSseConnect`).
 * Must include upgradeInfo: staleTime alone does not refetch a mounted offer,
 * so a hub restart with a new version/generation would otherwise keep the
 * skew banner comparing against the pre-disconnect offer indefinitely.
 * Machines too: fleet skew / online state can change while SSE was down.
 */
export function getSseReconnectQueryKeys(): ReadonlyArray<readonly unknown[]> {
    return [
        queryKeys.sessions,
        ['session'],
        queryKeys.machines,
        queryKeys.upgradeInfo,
    ]
}
