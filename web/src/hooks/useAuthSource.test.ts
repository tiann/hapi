import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

    it('persists a discovered session under its own Hub, never exposes the previous credential to the new Hub', () => {
        const other = 'https://discovered.example'
        localStorage.setItem(TOKEN_KEY, 'old-hub-token')
        const snapshots: Array<{ hub: string; source: unknown }> = []
        const { result, rerender } = renderHook(({ hub }) => {
            const value = useAuthSource(hub)
            snapshots.push({ hub, source: value.authSource })
            return value
        }, { initialProps: { hub: BASE } })
        act(() => result.current.setPasskeySession('new-session', other))
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'old-hub-token' })
        expect(localStorage.getItem(`hapi_passkey_session::${other}`)).toBe('new-session')
        rerender({ hub: other })
        expect(result.current.authSource).toEqual({ type: 'passkey', session: 'new-session' })
        expect(snapshots.filter((s) => s.hub === other).some((s) => JSON.stringify(s.source).includes('old-hub-token'))).toBe(false)
        expect(localStorage.getItem(PASSKEY_KEY)).toBeNull()
    })

    it('removes old pairing URL credentials when discovery selects another Hub', () => {
        window.history.replaceState(null, '', '/?hub=https://hub.example.com&token=link-token')
        const { result, rerender } = renderHook(({ hub }) => useAuthSource(hub), { initialProps: { hub: BASE } })
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'link-token' })
        act(() => result.current.setPasskeySession('new-session', 'https://new.example'))
        expect(window.location.search).toBe('')
        rerender({ hub: 'https://new.example' })
        expect(result.current.authSource).toEqual({ type: 'passkey', session: 'new-session' })
        expect(localStorage.getItem('hapi_access_token::https://new.example')).toBeNull()
    })
})
