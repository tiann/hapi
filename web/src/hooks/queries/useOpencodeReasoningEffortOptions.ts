import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { OpencodeReasoningEffortResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function shouldRetryOpencodeReasoningEffortQuery(failureCount: number): boolean {
    return failureCount < 3
}

const MAX_OPENCODE_REASONING_EFFORT_DISCOVERY_POLLS = 10
// While the reported options still belong to a previous model (a requested
// switch has not been applied by the backend yet), keep polling so the picker
// converges once the switch lands — but bounded, so an idle session that
// never turns again does not poll forever.
const MAX_OPENCODE_REASONING_EFFORT_MISMATCH_POLLS = 60

export function getOpencodeReasoningEffortRefetchInterval(
    enabled: boolean,
    data: OpencodeReasoningEffortResponse | undefined,
    pollCount: number,
    sessionModel?: string | null
): 1000 | 30_000 | false {
    if (!enabled) {
        return false
    }
    const targetModelId = data?.targetModelId ?? sessionModel
    if (
        data
        && data.currentModelId
        && targetModelId
        && data.currentModelId !== targetModelId
    ) {
        // The backend still reports the previous model. This includes a
        // variant-less previous model whose response has no options.
        return pollCount < MAX_OPENCODE_REASONING_EFFORT_MISMATCH_POLLS ? 1000 : 30_000
    }
    if (pollCount >= MAX_OPENCODE_REASONING_EFFORT_DISCOVERY_POLLS) {
        return false
    }
    if (!data) {
        return 1000
    }
    if (data.success === false) {
        return 1000
    }
    return (data.options?.length ?? 0) > 0 ? false : 1000
}

export function useOpencodeReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
    /** Server-confirmed session model — lets polling continue while the backend still reports the previous model's options. */
    sessionModel?: string | null
}): {
    options: Array<{ value: string; name?: string }>
    currentValue: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId, sessionModel } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    // The mismatch poll budget is per model switch: query.state.dataUpdateCount
    // is cumulative for the query's whole life, so earlier switches would
    // permanently exhaust the budget for later ones. Capture the update count
    // as a baseline when the session model changes and budget by the diff.
    // (Counting inside the refetchInterval callback is wrong: TanStack
    // evaluates that callback on every setOptions, i.e. every render.)
    const lastSeenModelRef = useRef<string | null | undefined>(undefined)
    const latestUpdateCountRef = useRef(0)
    const mismatchBaselineRef = useRef(0)
    useEffect(() => {
        if (lastSeenModelRef.current !== undefined && lastSeenModelRef.current !== sessionModel) {
            mismatchBaselineRef.current = latestUpdateCountRef.current
        }
        lastSeenModelRef.current = sessionModel
    }, [sessionModel])

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionOpencodeReasoningEffortOptions(sessionId)
            : ['session-opencode-reasoning-effort-options', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('OpenCode reasoning effort target unavailable')
            }
            return await api.getSessionOpencodeReasoningEffortOptions(sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: (failureCount) => shouldRetryOpencodeReasoningEffortQuery(failureCount),
        refetchInterval: (query) => {
            const data = query.state.data as OpencodeReasoningEffortResponse | undefined
            const totalUpdateCount = query.state.dataUpdateCount + query.state.errorUpdateCount
            latestUpdateCountRef.current = totalUpdateCount
            const targetModelId = data?.targetModelId ?? sessionModel
            const mismatchActive = Boolean(
                data
                && data.currentModelId
                && targetModelId
                && data.currentModelId !== targetModelId
            )
            return getOpencodeReasoningEffortRefetchInterval(
                enabled,
                data,
                mismatchActive
                    ? totalUpdateCount - mismatchBaselineRef.current
                    : totalUpdateCount,
                sessionModel
            )
        },
    })
    const targetModelId = sessionModel ?? query.data?.targetModelId
    const optionsAreCurrent = !query.data?.currentModelId
        || !targetModelId
        || query.data.currentModelId === targetModelId

    return {
        options: optionsAreCurrent ? (query.data?.options ?? []) : [],
        currentValue: optionsAreCurrent ? (query.data?.currentValue ?? null) : null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load OpenCode reasoning effort options')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load OpenCode reasoning effort options'
                    : null,
    }
}
