import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionTerminalInstanceId } from './terminalInstanceId'

describe('terminal instance id', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('persists one terminal id per session', () => {
        vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')

        const first = getSessionTerminalInstanceId('session-1')
        const second = getSessionTerminalInstanceId('session-1')

        expect(first).toBe('00000000-0000-4000-8000-000000000001')
        expect(second).toBe('00000000-0000-4000-8000-000000000001')
        expect(localStorage.getItem('hapi:terminal:instance:session-1')).toBe('00000000-0000-4000-8000-000000000001')
    })

    it('uses different ids for different sessions', () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')

        const sessionOne = getSessionTerminalInstanceId('session-1')
        const sessionTwo = getSessionTerminalInstanceId('session-2')

        expect(sessionOne).toBe('00000000-0000-4000-8000-000000000001')
        expect(sessionTwo).toBe('00000000-0000-4000-8000-000000000002')
        expect(localStorage.getItem('hapi:terminal:instance:session-1')).toBe('00000000-0000-4000-8000-000000000001')
        expect(localStorage.getItem('hapi:terminal:instance:session-2')).toBe('00000000-0000-4000-8000-000000000002')
    })
})
