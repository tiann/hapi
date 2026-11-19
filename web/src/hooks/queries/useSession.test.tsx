import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { createQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { applySessionDetailPatch } from '@/lib/sessionPatch'
import type { AgentState, SessionResponse } from '@/types/api'
import { useSession } from './useSession'

it('preserves an SSE question when a session GET started before issuance returns afterward', async () => {
    const id = 'session'
    const key = queryKeys.session(id)
    const client = createQueryClient()
    const snapshot = (agentStateVersion: number, agentState: AgentState, activeAt: number): SessionResponse => ({
        session: { id, agentStateVersion, agentState, activeAt } as SessionResponse['session']
    })
    const before = snapshot(1, {}, 1)
    client.setQueryData(key, before)

    let finishGet!: (value: SessionResponse) => void
    const delayed = new Promise<SessionResponse>(resolve => { finishGet = resolve })
    const getSession = vi.fn().mockReturnValueOnce(delayed).mockResolvedValueOnce(snapshot(3, { requests: {} }, 3))
    const { result } = renderHook(() => useSession({ getSession } as unknown as ApiClient, id), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    })

    const pending: AgentState = {
        requests: { question: { tool: 'request_user_input', arguments: {}, instanceId: 'issuance' } }
    }
    const first = result.current.refetch()
    await waitFor(() => expect(getSession).toHaveBeenCalledOnce())
    act(() => {
        const patched = applySessionDetailPatch(before.session, { agentState: { version: 2, value: pending } })
        client.setQueryData(key, { session: patched })
    })
    await waitFor(() => expect(result.current.session?.agentState).toEqual(pending))

    await act(async () => {
        finishGet(snapshot(1, {}, 2))
        await first
    })
    expect(client.getQueryData<SessionResponse>(key)?.session).toMatchObject({
        agentStateVersion: 2, agentState: pending, activeAt: 2
    })

    await act(async () => { await result.current.refetch() })
    expect(client.getQueryData<SessionResponse>(key)?.session).toMatchObject({
        agentStateVersion: 3, agentState: { requests: {} }, activeAt: 3
    })
})
