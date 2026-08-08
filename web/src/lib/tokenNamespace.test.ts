import { describe, expect, it } from 'vitest'
import { getTokenNamespace, isDefaultNamespaceToken } from './tokenNamespace'

function jwtWithNs(ns: string): string {
    return `x.${btoa(JSON.stringify({ ns }))}.x`
}

describe('getTokenNamespace', () => {
    it('reads ns from a JWT payload', () => {
        expect(getTokenNamespace(jwtWithNs('default'))).toBe('default')
        expect(getTokenNamespace(jwtWithNs('tenant'))).toBe('tenant')
    })

    it('returns null for missing or malformed tokens', () => {
        expect(getTokenNamespace(null)).toBeNull()
        expect(getTokenNamespace('')).toBeNull()
        expect(getTokenNamespace('not-a-jwt')).toBeNull()
    })
})

describe('isDefaultNamespaceToken', () => {
    it('is true only for the default namespace', () => {
        expect(isDefaultNamespaceToken(jwtWithNs('default'))).toBe(true)
        expect(isDefaultNamespaceToken(jwtWithNs('tenant'))).toBe(false)
        expect(isDefaultNamespaceToken(null)).toBe(false)
    })
})
