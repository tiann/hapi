import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useSessionActions } from './useSessionActions'
import type { ApiClient } from '@/api/client'

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
    useNavigate: vi.fn(),
}))

// Create mockable toast
const mockToast = {
    success: vi.fn(),
    error: vi.fn(),
}

vi.mock('@/lib/simple-toast', () => ({
    useSimpleToast: () => mockToast,
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

vi.mock('@/lib/message-window-store', () => ({
    clearMessageWindow: vi.fn(),
}))

describe('useSessionActions - resumeSession', () => {
    let mockApi: ApiClient
    let mockNavigate: ReturnType<typeof vi.fn>
    let queryClient: QueryClient

    // Helper to render hook with providers
    const createWrapper = () => {
        queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
            },
        })
        return ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
    }

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks()

        // Create mock API client
        mockApi = {
            resumeSession: vi.fn().mockResolvedValue(undefined),
            abortSession: vi.fn(),
            archiveSession: vi.fn(),
            switchSession: vi.fn(),
            setPermissionMode: vi.fn(),
            setModelMode: vi.fn(),
            renameSession: vi.fn(),
            deleteSession: vi.fn(),
        } as unknown as ApiClient

        // Create mock navigate function
        mockNavigate = vi.fn()
        vi.mocked(useNavigate).mockReturnValue(mockNavigate)
    })

    describe('Happy Path', () => {
        it('should invalidate queries before calling API', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session-id', null),
                { wrapper }
            )

            // Spy on invalidateQueries
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

            await result.current.resumeSession()

            // Verify invalidate was called before navigate
            expect(invalidateSpy).toHaveBeenCalled()
            expect(mockApi.resumeSession).toHaveBeenCalledWith('test-session-id')
        })

        it('should call api.resumeSession with correct sessionId', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'my-session-123', null),
                { wrapper }
            )

            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalledTimes(1)
            expect(mockApi.resumeSession).toHaveBeenCalledWith('my-session-123')
        })

        it('should navigate to session after successful resume', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            await result.current.resumeSession()

            expect(mockNavigate).toHaveBeenCalledTimes(1)
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/sessions/$sessionId',
                params: { sessionId: 'test-session' },
            })
        })

        it('should navigate after API call completes', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            const callOrder: string[] = []

            mockApi.resumeSession = vi.fn().mockImplementation(async () => {
                callOrder.push('resume')
            })

            mockNavigate.mockImplementation(() => {
                callOrder.push('navigate')
            })

            await result.current.resumeSession()

            expect(callOrder).toEqual(['resume', 'navigate'])
        })

        it('should not show success toast (navigation is the feedback)', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            await result.current.resumeSession()

            // Success toast should NOT be called
            expect(mockToast.success).not.toHaveBeenCalled()
            expect(mockNavigate).toHaveBeenCalled()
        })
    })

    describe('409 Already Active Handling', () => {
        it('should treat "Session is already active" as success and navigate', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'active-session', null),
                { wrapper }
            )

            // Mock API to throw 409 error
            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Session is already active')
            )

            // Should NOT throw
            await result.current.resumeSession()

            // Should navigate to the session
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/sessions/$sessionId',
                params: { sessionId: 'active-session' },
            })
        })

        it('should use exact match for "already active" error', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            // Mock API to throw similar but different error
            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Session is already active, but with extra text')
            )

            // Should treat as error (not exact match)
            await expect(result.current.resumeSession()).rejects.toThrow()
        })

        it('should not show error toast for already active', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Session is already active')
            )

            await result.current.resumeSession()

            // Should navigate, not show error
            expect(mockToast.error).not.toHaveBeenCalled()
            expect(mockNavigate).toHaveBeenCalled()
        })
    })

    describe('Error Handling', () => {
        it('should throw error if api is null', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(null, 'test-session', null),
                { wrapper }
            )

            await expect(result.current.resumeSession()).rejects.toThrow('Session unavailable')
        })

        it('should throw error if sessionId is null', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, null, null),
                { wrapper }
            )

            await expect(result.current.resumeSession()).rejects.toThrow('Session unavailable')
        })

        it('should propagate API errors (not "already active")', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Network timeout')
            )

            await expect(result.current.resumeSession()).rejects.toThrow('Network timeout')
        })

        it('should not navigate on API error', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Server error')
            )

            await expect(result.current.resumeSession()).rejects.toThrow()

            expect(mockNavigate).not.toHaveBeenCalled()
        })

        it('should handle non-Error objects thrown by API', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            mockApi.resumeSession = vi.fn().mockRejectedValue('String error')

            await expect(result.current.resumeSession()).rejects.toBe('String error')
        })

        it('should re-throw errors for caller to handle', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            const testError = new Error('Test failure')
            mockApi.resumeSession = vi.fn().mockRejectedValue(testError)

            await expect(result.current.resumeSession()).rejects.toThrow(testError)
        })

        it('should show error toast with error message from Error object', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            mockApi.resumeSession = vi.fn().mockRejectedValue(
                new Error('Custom network error')
            )

            await expect(result.current.resumeSession()).rejects.toThrow()

            expect(mockToast.error).toHaveBeenCalledWith('Custom network error')
        })

        it('should show error toast with translation key for non-Error objects', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            // Non-Error object thrown
            mockApi.resumeSession = vi.fn().mockRejectedValue({ code: 500, status: 'failed' })

            await expect(result.current.resumeSession()).rejects.toBeTruthy()

            expect(mockToast.error).toHaveBeenCalledWith('dialog.resume.error')
        })
    })

    describe('Boundary Cases', () => {
        it('should handle empty string sessionId', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, '', null),
                { wrapper }
            )

            // Empty string should pass through (API validates)
            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalledWith('')
        })

        it('should handle very long sessionId', async () => {
            const wrapper = createWrapper()
            const longId = 'session-' + 'x'.repeat(1000)
            const { result } = renderHook(
                () => useSessionActions(mockApi, longId, null),
                { wrapper }
            )

            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalledWith(longId)
        })
    })

    describe('Edge Cases', () => {
        it('should handle UUID sessionId format', async () => {
            const wrapper = createWrapper()
            const uuid = 'aada10c6-9299-4c45-abc4-91db9c0f935d'
            const { result } = renderHook(
                () => useSessionActions(mockApi, uuid, null),
                { wrapper }
            )

            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalledWith(uuid)
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/sessions/$sessionId',
                params: { sessionId: uuid },
            })
        })

        it('should handle sessionId with special characters', async () => {
            const wrapper = createWrapper()
            const sessionId = 'session-abc-123-xyz'
            const { result } = renderHook(
                () => useSessionActions(mockApi, sessionId, null),
                { wrapper }
            )

            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalledWith(sessionId)
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })

        it('should handle rapid successive calls', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            // Call twice rapidly
            const promise1 = result.current.resumeSession()
            const promise2 = result.current.resumeSession()

            await Promise.all([promise1, promise2])

            // Both should complete independently
            expect(mockApi.resumeSession).toHaveBeenCalledTimes(2)
            expect(mockNavigate).toHaveBeenCalledTimes(2)
        })

        it('should handle slow API response', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            // Mock slow API
            mockApi.resumeSession = vi.fn().mockImplementation(
                () => new Promise((resolve) => setTimeout(resolve, 100))
            )

            await result.current.resumeSession()

            expect(mockApi.resumeSession).toHaveBeenCalled()
            expect(mockNavigate).toHaveBeenCalled()
        })
    })

    describe('Query Invalidation', () => {
        it('should invalidate session queries before navigation', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
            const callOrder: string[] = []

            invalidateSpy.mockImplementation(async () => {
                callOrder.push('invalidate')
            })

            mockNavigate.mockImplementation(() => {
                callOrder.push('navigate')
            })

            await result.current.resumeSession()

            // Invalidate should happen before navigate
            expect(callOrder[0]).toBe('invalidate')
            expect(callOrder[callOrder.length - 1]).toBe('navigate')
        })

        it('should invalidate both session and sessions queries', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

            await result.current.resumeSession()

            // Should be called at least once for session queries
            expect(invalidateSpy).toHaveBeenCalled()
        })
    })

    describe('Integration Behavior', () => {
        it('should complete full flow: invalidate -> resume -> navigate', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            const callOrder: string[] = []

            vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async () => {
                callOrder.push('invalidate')
            })

            mockApi.resumeSession = vi.fn().mockImplementation(async () => {
                callOrder.push('resume')
            })

            mockNavigate.mockImplementation(() => {
                callOrder.push('navigate')
            })

            await result.current.resumeSession()

            expect(callOrder).toEqual(['invalidate', 'invalidate', 'resume', 'navigate'])
        })

        it('should allow retry after error', async () => {
            const wrapper = createWrapper()
            const { result } = renderHook(
                () => useSessionActions(mockApi, 'test-session', null),
                { wrapper }
            )

            // First call fails
            mockApi.resumeSession = vi.fn().mockRejectedValueOnce(
                new Error('Network error')
            )

            await expect(result.current.resumeSession()).rejects.toThrow('Network error')

            // Second call succeeds
            mockApi.resumeSession = vi.fn().mockResolvedValueOnce(undefined)

            await result.current.resumeSession()

            expect(mockNavigate).toHaveBeenCalledTimes(1) // Only on success
        })
    })
})
