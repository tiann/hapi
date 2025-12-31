import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('Store namespace filtering', () => {
    it('filters sessions by namespace', () => {
        const store = new Store(':memory:')
        const sessionAlpha = store.getOrCreateSession('tag', { path: '/alpha' }, null, 'alpha')
        const sessionBeta = store.getOrCreateSession('tag', { path: '/beta' }, null, 'beta')

        const sessionsAlpha = store.getSessionsByNamespace('alpha')
        const ids = sessionsAlpha.map((session) => session.id)

        expect(ids).toContain(sessionAlpha.id)
        expect(ids).not.toContain(sessionBeta.id)
    })

    it('filters machines by namespace and blocks mismatches', () => {
        const store = new Store(':memory:')
        const machineAlpha = store.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'alpha')
        store.getOrCreateMachine('machine-2', { host: 'beta' }, null, 'beta')

        const machinesAlpha = store.getMachinesByNamespace('alpha')
        const ids = machinesAlpha.map((machine) => machine.id)

        expect(ids).toContain(machineAlpha.id)
        expect(ids).not.toContain('machine-2')
        expect(() => store.getOrCreateMachine('machine-1', { host: 'beta' }, null, 'beta')).toThrow()
    })
})
