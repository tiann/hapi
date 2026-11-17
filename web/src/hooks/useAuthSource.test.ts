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
})
