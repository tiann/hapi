import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useMachinePathsExists } from './useMachinePathsExists'

const NO_PATHS: string[] = []

describe('useMachinePathsExists', () => {
    it('does not merge an imperative result from a previously selected machine', async () => {
        let resolveLookup!: (value: { exists: Record<string, boolean> }) => void
        const checkMachinePathsExists = vi.fn(async () => await new Promise<{ exists: Record<string, boolean> }>((resolve) => {
            resolveLookup = resolve
        }))
        const api = { checkMachinePathsExists } as unknown as ApiClient
        const { result, rerender } = renderHook(
            ({ machineId }: { machineId: string }) => useMachinePathsExists(api, machineId, NO_PATHS),
            { initialProps: { machineId: 'machine-a' } }
        )

        let pending!: Promise<Record<string, boolean>>
        act(() => {
            pending = result.current.checkPathsExists(['/tmp/project-a'])
        })
        expect(checkMachinePathsExists).toHaveBeenCalledWith('machine-a', ['/tmp/project-a'])

        rerender({ machineId: 'machine-b' })
        await act(async () => {
            resolveLookup({ exists: { '/tmp/project-a': true } })
            await Promise.resolve()
        })
        await expect(pending).resolves.toEqual({ '/tmp/project-a': true })

        await waitFor(() => expect(result.current.pathExistence).toEqual({}))
    })
})
