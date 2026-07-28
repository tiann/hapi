import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Machine } from '@/types/api'
import { getMachineTitle, useMachineLabels } from './useMachineLabels'

function makeMachine(id: string, metadata: Machine['metadata']): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata,
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
    }
}

describe('getMachineTitle', () => {
    it('prefers displayName, then host, then the id prefix', () => {
        expect(getMachineTitle(makeMachine('abcdef123456', { displayName: 'Work', host: 'mac' } as Machine['metadata']))).toBe('Work')
        expect(getMachineTitle(makeMachine('abcdef123456', { host: 'mac' } as Machine['metadata']))).toBe('mac')
        expect(getMachineTitle(makeMachine('abcdef123456', null))).toBe('abcdef12')
    })
})

describe('useMachineLabels', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns live titles and caches them', () => {
        const machines = [makeMachine('machine-1', { host: 'MacBook Pro' } as Machine['metadata'])]
        const { result } = renderHook(() => useMachineLabels(machines))

        expect(result.current['machine-1']).toBe('MacBook Pro')
        expect(JSON.parse(window.localStorage.getItem('hapi-machine-labels')!)).toEqual({ 'machine-1': 'MacBook Pro' })
    })

    it('keeps the cached label when the machine is absent from the list', () => {
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'gone-machine': 'MacBook Pro' }))
        const { result } = renderHook(() => useMachineLabels([]))

        expect(result.current['gone-machine']).toBe('MacBook Pro')
    })

    it('prefers the live title over a stale cached one', () => {
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'machine-1': 'old-name' }))
        const machines = [makeMachine('machine-1', { host: 'new-name' } as Machine['metadata'])]
        const { result } = renderHook(() => useMachineLabels(machines))

        expect(result.current['machine-1']).toBe('new-name')
    })
})
