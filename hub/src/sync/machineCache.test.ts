import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'

function createCache() {
    const store = new Store(':memory:')
    const broadcast: SyncEvent[] = []
    const sseManager = { broadcast: (event: SyncEvent) => { broadcast.push(event) } } as unknown as SSEManager
    const publisher = new EventPublisher(sseManager, () => 'ns')
    const cache = new MachineCache(store, publisher)
    return { store, publisher, cache, broadcast }
}

function seedMachine(store: Store, metadata: unknown) {
    store.machines.getOrCreateMachine('machine-1', metadata, null, 'ns')
}

const BASE_METADATA = {
    host: 'workstation.local',
    platform: 'linux',
    happyCliVersion: '1.0.0',
    workspaceRoots: ['/home/user']
}

describe('MachineCache.renameMachine', () => {
    it('sets displayName without touching CLI-reported fields', async () => {
        const { store, cache } = createCache()
        seedMachine(store, BASE_METADATA)
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'Workstation')

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            ...BASE_METADATA,
            displayName: 'Workstation'
        })
    })

    it('replaces an existing displayName', async () => {
        const { store, cache } = createCache()
        seedMachine(store, { ...BASE_METADATA, displayName: 'Old' })
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'New')

        expect((store.machines.getMachine('machine-1')?.metadata as { displayName?: string })?.displayName).toBe('New')
    })

    it('removes the key when given an empty name rather than storing an empty string', async () => {
        const { store, cache } = createCache()
        seedMachine(store, { ...BASE_METADATA, displayName: 'Workstation' })
        cache.reloadAll()

        await cache.renameMachine('machine-1', '')

        const metadata = store.machines.getMachine('machine-1')?.metadata as Record<string, unknown>
        expect(metadata).toEqual(BASE_METADATA)
        expect('displayName' in metadata).toBe(false)
    })

    it('survives a CLI re-registration afterwards', async () => {
        const { store, cache } = createCache()
        seedMachine(store, BASE_METADATA)
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'Workstation')
        store.machines.getOrCreateMachine('machine-1', { ...BASE_METADATA, host: 'renamed-host' }, null, 'ns')

        const metadata = store.machines.getMachine('machine-1')?.metadata as Record<string, unknown>
        expect(metadata.displayName).toBe('Workstation')
        expect(metadata.host).toBe('renamed-host')
    })

    it('publishes machine-updated so clients refetch', async () => {
        const { store, publisher, cache } = createCache()
        seedMachine(store, BASE_METADATA)
        cache.reloadAll()

        const seen: string[] = []
        publisher.subscribe((event) => {
            if (event.type === 'machine-updated') {
                seen.push(event.machineId)
            }
        })

        await cache.renameMachine('machine-1', 'Workstation')

        expect(seen).toContain('machine-1')
    })

    it('throws when the machine is unknown', async () => {
        const { cache } = createCache()

        await expect(cache.renameMachine('missing', 'Nope')).rejects.toThrow('Machine not found')
    })

    it('preserves fields the metadata schema does not recognise', async () => {
        const { store, cache } = createCache()
        seedMachine(store, { ...BASE_METADATA, futureField: 'keep me' })
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'Workstation')

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            ...BASE_METADATA,
            futureField: 'keep me',
            displayName: 'Workstation'
        })
    })

    it('does not wipe stored metadata that fails schema validation', async () => {
        const { store, cache } = createCache()
        // A CLI can write metadata the hub never validates (machineHandlers takes
        // z.unknown()), so a row missing required fields is reachable in practice.
        seedMachine(store, { host: 'workstation.local' })
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'Workstation')

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            host: 'workstation.local',
            displayName: 'Workstation'
        })
    })

    it('renames a machine that has no metadata at all', async () => {
        const { store, cache } = createCache()
        seedMachine(store, null)
        cache.reloadAll()

        await cache.renameMachine('machine-1', 'Workstation')

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({ displayName: 'Workstation' })
    })

    it('writes against the stored version even when the cache is stale', async () => {
        const { store, cache } = createCache()
        seedMachine(store, BASE_METADATA)
        cache.reloadAll()

        // Another writer bumps the version behind the cache's back.
        store.machines.getOrCreateMachine('machine-1', { ...BASE_METADATA, host: 'other-writer' }, null, 'ns')

        await cache.renameMachine('machine-1', 'Workstation')

        expect((store.machines.getMachine('machine-1')?.metadata as { displayName?: string })?.displayName).toBe('Workstation')
    })
})
