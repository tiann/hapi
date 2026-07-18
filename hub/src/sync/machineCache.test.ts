import { describe, expect, it } from 'bun:test'
import { PROVIDER_CAPABILITIES, type ProviderReadiness } from '@hapi/protocol'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'

const NOW = 1_800_000_000_000

function grokReadiness(overrides: Partial<ProviderReadiness> = {}): ProviderReadiness {
    return {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck: 'credential-file',
        version: '0.2.101',
        ...PROVIDER_CAPABILITIES.grok,
        checkedAt: NOW,
        ...overrides
    }
}

function metadata() {
    return {
        host: 'runner.example',
        platform: 'darwin',
        happyCliVersion: '1.2.3',
        providerReadiness: { grok: grokReadiness() }
    }
}

function publisher(): EventPublisher {
    return { emit: () => undefined } as unknown as EventPublisher
}

describe('MachineCache provider readiness metadata', () => {
    it('preserves strict provider readiness from storage through the cache', () => {
        const store = new Store(':memory:')
        const cache = new MachineCache(store, publisher())

        const machine = cache.getOrCreateMachine('machine-1', metadata(), null, 'default')

        expect(machine.metadata?.providerReadiness?.grok).toEqual(grokReadiness())
    })

    it('fails closed when stored machine metadata is malformed', () => {
        const store = new Store(':memory:')
        const cache = new MachineCache(store, publisher())
        store.machines.getOrCreateMachine('machine-1', { ...metadata(), unexpected: true }, null, 'default')

        expect(cache.refreshMachine('machine-1')?.metadata).toBeNull()
    })
})
