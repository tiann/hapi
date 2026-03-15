import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessionActions } from './useSessionActions'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

vi.mock('@/lib/message-window-store', () => ({
    clearMessageWindow: vi.fn(),
}))

vi.mock('@/lib/agentFlavorUtils', () => ({
    isKnownFlavor: vi.fn(() => false),
}))

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useSessionActions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('abortSession calls api and invalidates queries', async () => {
        const mockApi = {
            abortSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.abortSession()

        expect(mockApi.abortSession).toHaveBeenCalledWith('session-123')
    })

    it('archiveSession calls api', async () => {
        const mockApi = {
            archiveSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.archiveSession()

        expect(mockApi.archiveSession).toHaveBeenCalledWith('session-123')
    })

    it('switchSession calls api', async () => {
        const mockApi = {
            switchSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.switchSession()

        expect(mockApi.switchSession).toHaveBeenCalledWith('session-123')
    })

    it('setPermissionMode calls api with mode', async () => {
        const mockApi = {
            setPermissionMode: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.setPermissionMode('yolo')

        expect(mockApi.setPermissionMode).toHaveBeenCalledWith('session-123', 'yolo')
    })

    it('setModelMode calls api with mode', async () => {
        const mockApi = {
            setModelMode: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.setModelMode('default')

        expect(mockApi.setModelMode).toHaveBeenCalledWith('session-123', 'default')
    })

    it('renameSession calls api with name', async () => {
        const mockApi = {
            renameSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.renameSession('New Name')

        expect(mockApi.renameSession).toHaveBeenCalledWith('session-123', 'New Name')
    })

    it('deleteSession calls api', async () => {
        const mockApi = {
            deleteSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await result.current.deleteSession()

        expect(mockApi.deleteSession).toHaveBeenCalledWith('session-123')
    })

    it('throws error when api is null', async () => {
        const { result } = renderHook(
            () => useSessionActions(null, 'session-123'),
            { wrapper: createWrapper() }
        )

        await expect(result.current.abortSession()).rejects.toThrow('Session unavailable')
    })

    it('throws error when sessionId is null', async () => {
        const mockApi = {
            abortSession: vi.fn(),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, null),
            { wrapper: createWrapper() }
        )

        await expect(result.current.abortSession()).rejects.toThrow('Session unavailable')
    })

    it('isPending reflects mutation state', async () => {
        const mockApi = {
            abortSession: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100))),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionActions(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        expect(result.current.isPending).toBe(false)

        const promise = result.current.abortSession()

        await waitFor(() => {
            expect(result.current.isPending).toBe(true)
        })

        await promise

        await waitFor(() => {
            expect(result.current.isPending).toBe(false)
        })
    })
})
