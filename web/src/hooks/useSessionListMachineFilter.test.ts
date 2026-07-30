import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_LIST_MACHINE_FILTER,
    getInitialSessionListMachineFilter,
} from './useSessionListMachineFilter'

describe('useSessionListMachineFilter helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to null (all machines) for missing or blank storage values', () => {
        expect(getInitialSessionListMachineFilter()).toBe(DEFAULT_SESSION_LIST_MACHINE_FILTER)
        expect(getInitialSessionListMachineFilter()).toBeNull()

        window.localStorage.setItem('hapi-session-list-machine-filter', '')
        expect(getInitialSessionListMachineFilter()).toBeNull()

        window.localStorage.setItem('hapi-session-list-machine-filter', '   ')
        expect(getInitialSessionListMachineFilter()).toBeNull()
    })

    it('reads a stored machine id', () => {
        window.localStorage.setItem('hapi-session-list-machine-filter', 'machine-1')

        expect(getInitialSessionListMachineFilter()).toBe('machine-1')
    })
})
