import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useProjectDirectory } from './useProjectDirectory'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useProjectDirectory', () => {
    it('does not fetch when required inputs are missing', () => {
        const api = { listEditorDirectory: vi.fn() } as unknown as ApiClient

        const { result } = renderHook(
            () => useProjectDirectory(api, null, '/repo'),
            { wrapper: createWrapper() }
        )

        expect(result.current.entries).toEqual([])
        expect(result.current.error).toBeNull()
        expect(api.listEditorDirectory).not.toHaveBeenCalled()
    })

    it('fetches editor directory entries', async () => {
        const entries = [
            { name: 'src', type: 'directory' as const },
            { name: 'README.md', type: 'file' as const, gitStatus: 'modified' as const }
        ]
        const api = {
            listEditorDirectory: vi.fn(async () => ({ success: true, entries }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useProjectDirectory(api, 'machine-1', '/repo'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.entries).toEqual(entries)
        })
        expect(result.current.error).toBeNull()
        expect(api.listEditorDirectory).toHaveBeenCalledWith('machine-1', '/repo')
    })

    it('surfaces API error responses as hook errors', async () => {
        const api = {
            listEditorDirectory: vi.fn(async () => ({ success: false, error: 'No access' }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useProjectDirectory(api, 'machine-1', '/repo'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.error).toBe('No access')
        })
        expect(result.current.entries).toEqual([])
    })
})
