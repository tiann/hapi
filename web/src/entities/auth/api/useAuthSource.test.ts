import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAuthSource } from './useAuthSource'

describe('useAuthSource', () => {
    beforeEach(() => {
        localStorage.clear()
        delete (window as { location?: unknown }).location
        // @ts-expect-error - Mocking window.location for tests
        window.location = { search: '' } as unknown as Location
    })

    it('initializes with null authSource when no token', () => {
        const { result } = renderHook(() => useAuthSource('https://example.com'))
        expect(result.current.authSource).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('loads token from URL params', () => {
        window.location.search = '?token=test-token'
        const { result } = renderHook(() => useAuthSource('https://example.com'))
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'test-token' })
        expect(result.current.isLoading).toBe(false)
    })

    it('loads token from localStorage', () => {
        localStorage.setItem('hapi_access_token::https://example.com', 'stored-token')
        const { result } = renderHook(() => useAuthSource('https://example.com'))
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'stored-token' })
    })

    it('prioritizes URL token over localStorage', () => {
        localStorage.setItem('hapi_access_token::https://example.com', 'stored-token')
        window.location.search = '?token=url-token'
        const { result } = renderHook(() => useAuthSource('https://example.com'))
        expect(result.current.authSource?.token).toBe('url-token')
    })

    it('setAccessToken updates state and localStorage', async () => {
        const { result } = renderHook(() => useAuthSource('https://example.com'))

        result.current.setAccessToken('new-token')

        await waitFor(() => {
            expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'new-token' })
        })

        expect(localStorage.getItem('hapi_access_token::https://example.com')).toBe('new-token')
    })

    it('clearAuth removes state and localStorage', async () => {
        localStorage.setItem('hapi_access_token::https://example.com', 'token')
        const { result } = renderHook(() => useAuthSource('https://example.com'))

        await waitFor(() => {
            expect(result.current.authSource).not.toBe(null)
        })

        result.current.clearAuth()

        await waitFor(() => {
            expect(result.current.authSource).toBe(null)
        })

        expect(localStorage.getItem('hapi_access_token::https://example.com')).toBe(null)
    })

    it('uses different storage keys for different baseUrls', () => {
        const { result: result1 } = renderHook(() => useAuthSource('https://server1.com'))
        const { result: result2 } = renderHook(() => useAuthSource('https://server2.com'))

        result1.current.setAccessToken('token1')
        result2.current.setAccessToken('token2')

        expect(localStorage.getItem('hapi_access_token::https://server1.com')).toBe('token1')
        expect(localStorage.getItem('hapi_access_token::https://server2.com')).toBe('token2')
    })

    it('resets state when baseUrl changes', async () => {
        const { result, rerender } = renderHook(
            ({ baseUrl }) => useAuthSource(baseUrl),
            { initialProps: { baseUrl: 'https://server1.com' } }
        )

        result.current.setAccessToken('token1')

        await waitFor(() => {
            expect(result.current.authSource?.token).toBe('token1')
        })

        rerender({ baseUrl: 'https://server2.com' })

        await waitFor(() => {
            expect(result.current.authSource).toBe(null)
        })
    })
})
