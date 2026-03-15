import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { normalizeServerUrl, useServerUrl } from './useServerUrl'

describe('useServerUrl', () => {
    beforeEach(() => {
        localStorage.clear()
        // Mock window.location
        delete (window as { location?: unknown }).location
        // @ts-expect-error - Mocking window.location for tests
        window.location = { origin: 'http://localhost:3000', search: '' } as unknown as Location
    })

    describe('normalizeServerUrl', () => {
        it('returns error for empty input', () => {
            const result = normalizeServerUrl('')
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.error).toContain('Enter a hub URL')
            }
        })

        it('returns error for invalid URL', () => {
            const result = normalizeServerUrl('not-a-url')
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.error).toContain('valid URL')
            }
        })

        it('returns error for non-http(s) protocol', () => {
            const result = normalizeServerUrl('ftp://example.com')
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.error).toContain('http:// or https://')
            }
        })

        it('normalizes valid http URL', () => {
            const result = normalizeServerUrl('http://example.com')
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value).toBe('http://example.com')
            }
        })

        it('normalizes valid https URL', () => {
            const result = normalizeServerUrl('https://example.com')
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value).toBe('https://example.com')
            }
        })

        it('extracts origin from URL with path', () => {
            const result = normalizeServerUrl('https://example.com/path/to/page')
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value).toBe('https://example.com')
            }
        })

        it('trims whitespace', () => {
            const result = normalizeServerUrl('  https://example.com  ')
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value).toBe('https://example.com')
            }
        })
    })

    describe('useServerUrl hook', () => {
        it('initializes with null serverUrl when no stored value', () => {
            const { result } = renderHook(() => useServerUrl())
            expect(result.current.serverUrl).toBe(null)
            expect(result.current.baseUrl).toBe('http://localhost:3000')
        })

        it('loads serverUrl from localStorage', () => {
            localStorage.setItem('hapi_hub_url', 'https://example.com')
            const { result } = renderHook(() => useServerUrl())
            expect(result.current.serverUrl).toBe('https://example.com')
            expect(result.current.baseUrl).toBe('https://example.com')
        })

        it('prioritizes URL param over localStorage', () => {
            localStorage.setItem('hapi_hub_url', 'https://stored.com')
            window.location.search = '?hub=https://param.com'
            const { result } = renderHook(() => useServerUrl())
            expect(result.current.serverUrl).toBe('https://param.com')
        })

        it('setServerUrl updates state and localStorage', async () => {
            const { result } = renderHook(() => useServerUrl())

            await waitFor(() => {
                const setResult = result.current.setServerUrl('https://new.com')
                expect(setResult.ok).toBe(true)
            })

            await waitFor(() => {
                expect(result.current.serverUrl).toBe('https://new.com')
            })

            expect(localStorage.getItem('hapi_hub_url')).toBe('https://new.com')
        })

        it('setServerUrl returns error for invalid URL', () => {
            const { result } = renderHook(() => useServerUrl())
            const setResult = result.current.setServerUrl('invalid')
            expect(setResult.ok).toBe(false)
        })

        it('clearServerUrl removes state and localStorage', async () => {
            localStorage.setItem('hapi_hub_url', 'https://example.com')
            const { result } = renderHook(() => useServerUrl())
            expect(result.current.serverUrl).toBe('https://example.com')

            await waitFor(() => {
                result.current.clearServerUrl()
            })

            await waitFor(() => {
                expect(result.current.serverUrl).toBe(null)
            })

            expect(localStorage.getItem('hapi_hub_url')).toBe(null)
        })

        it('removes invalid stored URL', () => {
            localStorage.setItem('hapi_hub_url', 'invalid-url')
            const { result } = renderHook(() => useServerUrl())
            expect(result.current.serverUrl).toBe(null)
            expect(localStorage.getItem('hapi_hub_url')).toBe(null)
        })
    })
})
