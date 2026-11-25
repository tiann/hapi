import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAuthSource } from './useAuthSource'

const BASE = 'https://hub.example.com'
const TOKEN_KEY = `hapi_access_token::${BASE}`
const PASSKEY_KEY = `hapi_passkey_session::${BASE}`

describe('useAuthSource passkey sessions', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => localStorage.clear())

    it('restores a stored passkey session when no access token is stored', () => {
        localStorage.setItem(PASSKEY_KEY, 'pk-session')
        const { result } = renderHook(() => useAuthSource(BASE))
        expect(result.current.authSource).toEqual({ type: 'passkey', session: 'pk-session' })
    })

    it('replaces a stale access token so it cannot shadow the passkey session', () => {
        localStorage.setItem(TOKEN_KEY, 'stale-token')
        const { result } = renderHook(() => useAuthSource(BASE))
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'stale-token' })

        act(() => result.current.setPasskeySession('pk-session'))
        expect(result.current.authSource).toEqual({ type: 'passkey', session: 'pk-session' })
        expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
        expect(localStorage.getItem(PASSKEY_KEY)).toBe('pk-session')

        act(() => result.current.setAccessToken('fresh-token'))
        expect(localStorage.getItem(PASSKEY_KEY)).toBeNull()

        act(() => result.current.clearAuth())
        expect(result.current.authSource).toBeNull()
        expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('uses only the destination credential after sign-out, ignoring old URL and late SDK data', () => {
        const originalUrl = window.location.href
        const originalTelegram = Object.getOwnPropertyDescriptor(window, 'Telegram')
        window.history.replaceState(null, '', '?token=fixture-original')
        const { result, rerender, unmount } = renderHook(({ hub }) => useAuthSource(hub), { initialProps: { hub: BASE } })
        try {
            expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'fixture-original' })
            act(() => result.current.clearAuth())
            const other = 'https://other.example.com'
            localStorage.setItem(`hapi_passkey_session::${other}`, 'other-session')
            Object.defineProperty(window, 'Telegram', { value: { WebApp: { initData: 'late-original-launch' } }, configurable: true })
            rerender({ hub: other })
            expect(result.current.authSource).toEqual({ type: 'passkey', session: 'other-session' })
            expect(localStorage.getItem(`hapi_access_token::${other}`)).toBeNull()
        } finally {
            unmount()
            window.history.replaceState(null, '', originalUrl)
            if (originalTelegram) Object.defineProperty(window, 'Telegram', originalTelegram)
            else Reflect.deleteProperty(window, 'Telegram')
        }
    })

    it('does not restart Telegram polling after explicit sign-out', () => {
        vi.useFakeTimers()
        const originalUrl = window.location.href
        const originalTelegram = Object.getOwnPropertyDescriptor(window, 'Telegram')
        window.history.replaceState(null, '', '?tgWebAppVersion=9.0')
        const { result, unmount } = renderHook(() => useAuthSource(BASE))
        try {
            expect(result.current.isLoading).toBe(true)
            act(() => result.current.clearAuth())
            Object.defineProperty(window, 'Telegram', { value: { WebApp: { initData: 'late-original-launch' } }, configurable: true })
            act(() => { vi.advanceTimersByTime(1000) })
            expect(result.current.authSource).toBeNull()
            expect(result.current.isLoading).toBe(false)
        } finally {
            unmount(); vi.useRealTimers()
            window.history.replaceState(null, '', originalUrl)
            if (originalTelegram) Object.defineProperty(window, 'Telegram', originalTelegram)
            else Reflect.deleteProperty(window, 'Telegram')
        }
    })
})
