import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { ApiClient } from '@/api/client'
import type {
    SessionSortPreference,
    SessionSortPreferenceResponse,
    SetSessionSortPreferencePayload,
    SetSessionSortPreferenceResult
} from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionSortPreferenceMutation(api: ApiClient | null): {
    setSessionSortPreference: (payload: SetSessionSortPreferencePayload) => Promise<SetSessionSortPreferenceResult>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (payload: SetSessionSortPreferencePayload) => {
            if (!api) {
                throw new Error('API unavailable')
            }

            return await api.setSessionSortPreference(payload)
        },
        onMutate: async (payload) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.sessionSortPreference })
            const previous = queryClient.getQueryData<SessionSortPreferenceResponse>(queryKeys.sessionSortPreference)

            const previousPreference = previous?.preference
            if (previousPreference) {
                const optimisticPreference: SessionSortPreference = {
                    sortMode: payload.sortMode,
                    manualOrder: payload.manualOrder,
                    version: payload.expectedVersion !== undefined
                        ? payload.expectedVersion + 1
                        : previousPreference.version + 1,
                    updatedAt: Date.now()
                }

                queryClient.setQueryData<SessionSortPreferenceResponse>(
                    queryKeys.sessionSortPreference,
                    { preference: optimisticPreference }
                )
            }

            return { previous }
        },
        onError: (_error, _payload, context) => {
            if (context?.previous) {
                queryClient.setQueryData(queryKeys.sessionSortPreference, context.previous)
            }
        },
        onSuccess: (result) => {
            queryClient.setQueryData<SessionSortPreferenceResponse>(
                queryKeys.sessionSortPreference,
                {
                    preference: result.preference
                }
            )
        }
    })

    return {
        setSessionSortPreference: mutation.mutateAsync,
        isPending: mutation.isPending
    }
}
