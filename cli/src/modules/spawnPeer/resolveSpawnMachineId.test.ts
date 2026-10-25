import { describe, expect, it } from 'vitest'
import {
    AmbiguousSpawnMachineError,
    isUuidMachineSelector,
    resolveSpawnMachineIdFromList,
} from './resolveSpawnMachineId'

const MACHINES = [
    {
        id: '5f5a87e8-25b2-4732-ba4c-aba95f695bd7',
        metadata: { host: 'oos-linux' },
    },
    {
        id: 'f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026',
        metadata: { host: 'proxmox', name: 'homelab' },
    },
    {
        id: 'Teemo',
        hostname: 'Teemo',
        metadata: { host: 'Teemo', displayName: 'windows-box' },
    },
]

describe('resolveSpawnMachineIdFromList', () => {
    it('returns exact UUID id matches', () => {
        expect(resolveSpawnMachineIdFromList(
            '5f5a87e8-25b2-4732-ba4c-aba95f695bd7',
            MACHINES
        )).toBe('5f5a87e8-25b2-4732-ba4c-aba95f695bd7')
    })

    it('passthrough UUID when not in the online list', () => {
        expect(resolveSpawnMachineIdFromList(
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            MACHINES
        )).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    })

    it('resolves hostname via metadata.host', () => {
        expect(resolveSpawnMachineIdFromList('oos-linux', MACHINES))
            .toBe('5f5a87e8-25b2-4732-ba4c-aba95f695bd7')
    })

    it('resolves metadata.name and displayName', () => {
        expect(resolveSpawnMachineIdFromList('homelab', MACHINES))
            .toBe('f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026')
        expect(resolveSpawnMachineIdFromList('windows-box', MACHINES))
            .toBe('Teemo')
    })

    it('resolves non-UUID machine ids by exact id', () => {
        expect(resolveSpawnMachineIdFromList('Teemo', MACHINES)).toBe('Teemo')
    })

    it('returns null for unknown hostnames', () => {
        expect(resolveSpawnMachineIdFromList('no-such-host', MACHINES)).toBeNull()
    })

    it('rejects ambiguous hostname / displayName matches', () => {
        const dupHosts = [
            {
                id: 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111',
                metadata: { host: 'shared-lab', displayName: 'lab' },
            },
            {
                id: 'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
                metadata: { host: 'other', name: 'shared-lab' },
            },
        ]
        expect(() => resolveSpawnMachineIdFromList('shared-lab', dupHosts))
            .toThrow(AmbiguousSpawnMachineError)
        expect(() => resolveSpawnMachineIdFromList('shared-lab', dupHosts))
            .toThrow(/matches 2 online runners/i)
    })

    it('trims whitespace', () => {
        expect(resolveSpawnMachineIdFromList('  oos-linux  ', MACHINES))
            .toBe('5f5a87e8-25b2-4732-ba4c-aba95f695bd7')
    })
})

describe('isUuidMachineSelector', () => {
    it('accepts RFC-shaped UUIDs', () => {
        expect(isUuidMachineSelector('5f5a87e8-25b2-4732-ba4c-aba95f695bd7')).toBe(true)
    })

    it('rejects hostnames', () => {
        expect(isUuidMachineSelector('oos-linux')).toBe(false)
    })
})
