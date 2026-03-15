import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAuth } from './useAuth'
import type { AuthSource } from '../model'

describe('useAuth', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns null when authSource is null', () => {
        const { result } = renderHook(() => useAuth(null, 'https://example.com'))
        expect(result.current.token).toBe(null)
        expect(result.current.user).toBe(null)
        expect(result.current.api).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('authenticates with access token', async () => {
        const authSource: AuthSource = { type: 'accessToken', token: 'test-token' }
        const mockAuthResponse = {
            token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature',
            user: { id: 1, username: 'testuser' }
        }

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockAuthResponse
        })

        const { result } = renderHook(() => useAuth(authSource, 'https://example.com'))

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        }, { timeout: 3000 })

        expect(result.current.token).toBe(mockAuthResponse.token)
        expect(result.current.user).toEqual({ id: 1, username: 'testuser' })
        expect(result.current.api).not.toBe(null)
        expect(result.current.error).toBe(null)
    })

    it('handles authentication error', async () => {
        const authSource: AuthSource = { type: 'accessToken', token: 'invalid-token' }

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Unauthorized' })
        })

        const { result } = renderHook(() => useAuth(authSource, 'https://example.com'))

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        }, { timeout: 3000 })

        expect(result.current.token).toBe(null)
        expect(result.current.error).not.toBe(null)
    })
})
