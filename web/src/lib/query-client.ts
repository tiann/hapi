import { QueryClient, replaceEqualDeep } from '@tanstack/react-query'
import { mergeReadState } from '@hapi/protocol'
import type { SessionResponse } from '@/types/api'
import { queryKeys } from './query-keys'
import { fillMissingPendingRequestInstanceIds } from './sessionPatch'

function shareSessionDetail(previous: unknown, incoming: unknown): unknown {
    const current = (previous as SessionResponse | undefined)?.session
    const response = incoming as SessionResponse | undefined
    const next = response?.session
    if (!current || !next || current === next) return replaceEqualDeep(previous, incoming)

    const session = { ...next }
    // Only a versioned snapshot can supersede known versioned state.
    if (Number.isFinite(current.agentStateVersion) && (
        !Number.isFinite(next.agentStateVersion)
        || current.agentStateVersion > next.agentStateVersion
    )) {
        session.agentState = current.agentState
        session.agentStateVersion = current.agentStateVersion
    } else if (
        Number.isFinite(current.agentStateVersion)
        && current.id === next.id
        && current.agentStateVersion === next.agentStateVersion
        && current.agentState
    ) {
        session.agentState = fillMissingPendingRequestInstanceIds(current.agentState, next.agentState)
    }
    if (current.contentRevision !== undefined || next.contentRevision !== undefined) {
        session.contentRevision = Math.max(current.contentRevision ?? 0, next.contentRevision ?? 0)
    }
    if (current.readState || next.readState) {
        session.readState = mergeReadState(current.readState, next.readState)
    }
    return replaceEqualDeep(previous, { ...response, session })
}

export function createQueryClient(): QueryClient {
    const client = new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 5_000,
                refetchOnWindowFocus: false,
                retry: 1,
            },
            mutations: {
                retry: 0,
            },
        },
    })
    // Runs at cache commit for fetched results and setQueryData alike.
    client.setQueryDefaults(queryKeys.sessionDetails, { structuralSharing: shareSessionDetail })
    return client
}

export const queryClient = createQueryClient()
