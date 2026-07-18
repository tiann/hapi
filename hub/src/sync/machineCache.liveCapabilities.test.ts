import { describe, expect, it } from 'bun:test'
import { CURRENT_MACHINE_CAPABILITIES, MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { Machine } from '@hapi/protocol/types'
import { RpcRegistry } from '../socket/rpcRegistry'
import { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { Store } from '../store'

function makePublisher(): EventPublisher {
    return new EventPublisher({ broadcast: () => {} } as never, () => 'default')
}

describe('MachineCache live capabilities', () => {
    it('overlays registered RPCs onto machine metadata for API consumers', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'Teemo',
            {
                host: 'Teemo',
                platform: 'win32',
                happyCliVersion: '0.23.0',
            },
            null,
            'default',
        )
        const registry = new RpcRegistry()
        const cache = new MachineCache(store, makePublisher(), registry)
        cache.reloadAll()

        expect(cache.getMachine('Teemo')?.metadata?.capabilities).toBeUndefined()

        registry.register(
            { id: 'sock-1' } as never,
            `Teemo:${MACHINE_CAPABILITIES.CursorChatStoreStatus}`,
        )

        const machine = cache.getMachine('Teemo') as Machine
        expect(machine.metadata?.capabilities).toEqual([
            MACHINE_CAPABILITIES.CursorChatStoreStatus,
        ])
        expect(CURRENT_MACHINE_CAPABILITIES).toContain(MACHINE_CAPABILITIES.CursorChatStoreStatus)
    })
})
