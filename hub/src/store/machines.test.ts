import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { mergeMachineMetadata } from './machines'

describe('machine metadata backfill', () => {
    it('merges incoming metadata over stored fields on re-registration', () => {
        const store = new Store(':memory:')
        const created = store.machines.getOrCreateMachine('machine-1', null, null, 'ns')
        expect(created.metadata).toBeNull()

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            { host: 'MacBook Pro', platform: 'darwin' },
            null,
            'ns'
        )

        expect(refreshed.metadata).toEqual({ host: 'MacBook Pro', platform: 'darwin' })
        expect(refreshed.metadataVersion).toBe(created.metadataVersion + 1)
    })

    it('preserves hub-side fields the CLI never sends', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine('machine-1', { displayName: 'Workstation', host: 'old-host' }, null, 'ns')

        const refreshed = store.machines.getOrCreateMachine('machine-1', { host: 'new-host' }, null, 'ns')

        expect(refreshed.metadata).toEqual({ displayName: 'Workstation', host: 'new-host' })
    })

    it('does not write when the merge changes nothing', () => {
        const store = new Store(':memory:')
        const created = store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'ns')

        const again = store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'ns')

        expect(again.metadataVersion).toBe(created.metadataVersion)
        expect(again.updatedAt).toBe(created.updatedAt)
    })
})

describe('mergeMachineMetadata', () => {
    it('returns undefined for non-object incoming metadata', () => {
        expect(mergeMachineMetadata({ host: 'a' }, null)).toBeUndefined()
        expect(mergeMachineMetadata({ host: 'a' }, 'host')).toBeUndefined()
        expect(mergeMachineMetadata({ host: 'a' }, ['host'])).toBeUndefined()
    })

    it('returns undefined when the merge is a no-op', () => {
        expect(mergeMachineMetadata({ host: 'a' }, { host: 'a' })).toBeUndefined()
    })
})
