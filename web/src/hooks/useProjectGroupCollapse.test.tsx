import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectGroupCollapseStorageKey, useProjectGroupCollapse } from './useProjectGroupCollapse'

function token(ns: string, uid = 1, exp = 100) {
    const payload = JSON.stringify({ ns, uid, exp })
    const bytes = new TextEncoder().encode(payload)
    return `header.${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.signature`
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('project collapse storage identity', () => {
    it('isolates Hubs, namespaces and users, while surviving token refresh', () => {
        const key = getProjectGroupCollapseStorageKey('https://hub.test/', token('default'))
        expect(key).not.toBeNull()
        expect(getProjectGroupCollapseStorageKey('https://hub.test', token('default', 1, 999))).toBe(key)
        expect(getProjectGroupCollapseStorageKey('https://other.test', token('default'))).not.toBe(key)
        expect(getProjectGroupCollapseStorageKey('https://hub.test', token('tenant'))).not.toBe(key)
        expect(getProjectGroupCollapseStorageKey('https://hub.test', token('default', 2))).not.toBe(key)
        expect(key).not.toContain('signature')
    })

    it('decodes non-ASCII namespaces and keeps Hub subpaths distinct', () => {
        expect(getProjectGroupCollapseStorageKey('https://hub.test', token('用户'))).toContain('用户')
        expect(getProjectGroupCollapseStorageKey('https://hub.test/hapi', token('default')))
            .not.toBe(getProjectGroupCollapseStorageKey('https://hub.test', token('default')))
    })

    it.each(['', 'broken', 'header.not-json.signature', 'header.e30.signature'])(
        'disables persistence rather than sharing an unknown identity: %s', value => {
            expect(getProjectGroupCollapseStorageKey('https://hub.test', value)).toBeNull()
        },
    )
})

describe('project collapse storage failures', () => {
    it.each(['broken-json', '[]', 'null', 'true', '"text"'])(
        'ignores malformed saved state: %s', value => {
            localStorage.setItem('scope', value)
            const { result } = renderHook(() => useProjectGroupCollapse('scope'))
            expect(result.current.collapseOverrides.size).toBe(0)
        },
    )

    it('accepts only boolean choices and safely handles unusual project keys', () => {
        localStorage.setItem('scope', '{"open":false,"closed":true,"invalid":"false","__proto__":true}')
        const { result } = renderHook(() => useProjectGroupCollapse('scope'))
        expect([...result.current.collapseOverrides]).toEqual([['open', false], ['closed', true], ['__proto__', true]])
        act(() => result.current.setManualCollapse('constructor', false))
        expect(JSON.parse(localStorage.getItem('scope')!).constructor).toBe(false)
    })

    it('never writes automatic reveals, including after a later manual toggle', () => {
        const { result } = renderHook(() => useProjectGroupCollapse('scope'))
        act(() => result.current.revealGroup('auto'))
        act(() => result.current.setManualCollapse('manual', false))
        expect(JSON.parse(localStorage.getItem('scope')!)).toEqual({ manual: false })
    })

    it('bounds saved history without pruning groups absent from current results', () => {
        const saved = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`group-${i}`, false]))
        localStorage.setItem('scope', JSON.stringify(saved))
        const { result } = renderHook(() => useProjectGroupCollapse('scope'))
        expect(result.current.collapseOverrides.size).toBe(2000)
        act(() => result.current.setManualCollapse('new', true))
        const restored = JSON.parse(localStorage.getItem('scope')!)
        expect(Object.keys(restored)).toHaveLength(2000)
        expect(restored['group-1']).toBeUndefined()
        expect(restored.new).toBe(true)
    })

    it('keeps an unscoped list usable without storing preferences', () => {
        const { result } = renderHook(() => useProjectGroupCollapse(null))
        act(() => result.current.setManualCollapse('group', false))
        expect(result.current.collapseOverrides.get('group')).toBe(false)
        expect(localStorage.length).toBe(0)
    })
})
