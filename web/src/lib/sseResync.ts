import { queryKeys } from './query-keys'

export type SseConnectInfo = { resumed: boolean }
export type QueryKey = readonly unknown[]

export function getAppSseResyncQueryKeys(
    info: SseConnectInfo,
    isFirstConnect: boolean
): QueryKey[] {
    if (info.resumed && !isFirstConnect) {
        return []
    }

    return [
        queryKeys.sessions,
        queryKeys.scratchlistSessionIds,
        ['session']
    ]
}
