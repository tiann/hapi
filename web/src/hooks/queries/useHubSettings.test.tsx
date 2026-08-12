import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { HubSettingsResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'
import { useHubSettings } from './useHubSettings'

const settings = (peerToolsEnabled: boolean): HubSettingsResponse => ({
    sessionSummaryContract: false,
    sessionSummaryInChat: false,
    peerToolsEnabled,
})

function renderHubSettings(api: ApiClient | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return { ...renderHook(() => useHubSettings(api), { wrapper }), queryClient }
}

describe('useHubSettings peer-tools exposure', () => {
    it('returns false after a successful disabled response', async () => {
        const getHubSettings = vi.fn().mockResolvedValue(settings(false))
        const api = { getHubSettings } as unknown as ApiClient
        const { result } = renderHubSettings(api)
        await waitFor(() => expect(getHubSettings).toHaveBeenCalled())
        await waitFor(() => {
            expect(result.current.data?.peerToolsEnabled).toBe(false)
            expect(result.current.peerToolsEnabled).toBe(false)
        })
    })

    it('returns true after a successful enabled response', async () => {
        const api = { getHubSettings: vi.fn().mockResolvedValue(settings(true)) } as unknown as ApiClient
        const { result } = renderHubSettings(api)
        await waitFor(() => expect(result.current.peerToolsEnabled).toBe(true))
    })

    it('denies guidance while settings are pending', () => {
        const api = {
            getHubSettings: vi.fn(() => new Promise<HubSettingsResponse>(() => {})),
        } as unknown as ApiClient
        const { result } = renderHubSettings(api)
        expect(result.current.peerToolsEnabled).toBe(false)
    })

    it('denies guidance when settings reject', async () => {
        const getHubSettings = vi.fn().mockRejectedValue(new Error('settings unavailable'))
        const api = { getHubSettings } as unknown as ApiClient
        const { result } = renderHubSettings(api)
        await waitFor(() => expect(getHubSettings).toHaveBeenCalled())
        await waitFor(() => {
            expect(result.current.data).toBeUndefined()
            expect(result.current.peerToolsEnabled).toBe(false)
        })
    })

    it('denies guidance after an enabled settings refetch rejects', async () => {
        const getHubSettings = vi
            .fn()
            .mockResolvedValueOnce(settings(true))
            .mockRejectedValueOnce(new Error('settings unavailable'))
        const api = { getHubSettings } as unknown as ApiClient
        const { result, queryClient } = renderHubSettings(api)

        await waitFor(() => expect(result.current.peerToolsEnabled).toBe(true))
        await queryClient.refetchQueries({ queryKey: queryKeys.hubSettings, type: 'active' })
        await waitFor(() => expect(queryClient.getQueryState(queryKeys.hubSettings)?.status).toBe('error'))

        expect(result.current.data?.peerToolsEnabled).toBe(true)
        expect(result.current.peerToolsEnabled).toBe(false)
    })

    it('denies guidance when no API is available', () => {
        const { result } = renderHubSettings(null)
        expect(result.current.peerToolsEnabled).toBe(false)
    })
})
