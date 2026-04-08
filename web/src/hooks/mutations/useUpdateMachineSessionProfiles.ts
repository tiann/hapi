import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { MachineSessionProfilesResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useUpdateMachineSessionProfiles(api: ApiClient | null): {
    updateMachineSessionProfiles: (input: { machineId: string; payload: MachineSessionProfilesResponse }) => Promise<MachineSessionProfilesResponse>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: { machineId: string; payload: MachineSessionProfilesResponse }) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.updateMachineSessionProfiles(input.machineId, input.payload)
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.machineSessionProfiles(variables.machineId)
            })
        }
    })

    return {
        updateMachineSessionProfiles: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : mutation.error ? 'Failed to update machine session profiles' : null
    }
}
