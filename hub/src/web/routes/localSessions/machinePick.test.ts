import { describe, expect, it } from 'bun:test'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import { pickImportMachine } from './machinePick'

function machine(id: string, workspaceRoots: string[] = []): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: 'test', workspaceRoots },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function engine(machines: Machine[]): SyncEngine {
    return {
        getOnlineMachinesByNamespace: () => machines
    } as unknown as SyncEngine
}

describe('import machine selection', () => {
    const first = machine('m-1', ['/workspace/a'])
    const second = machine('m-2', ['/workspace/b'])

    it('prefers the requested machine when it is online', () => {
        expect(pickImportMachine({ engine: engine([first, second]), namespace: 'default', requestedMachineId: 'm-2' })?.id).toBe('m-2')
        expect(pickImportMachine({ engine: engine([first]), namespace: 'default', requestedMachineId: 'missing' })).toBeNull()
    })

    it('falls back to the unique online machine owning the cwd', () => {
        expect(pickImportMachine({ engine: engine([first, second]), namespace: 'default', cwd: '/workspace/b/sub' })?.id).toBe('m-2')
    })

    it('falls back to the first online machine when the cwd is ambiguous or absent', () => {
        const sharedOwnerA = machine('m-1', ['/shared'])
        const sharedOwnerB = machine('m-2', ['/shared', '/workspace/b'])
        expect(pickImportMachine({ engine: engine([sharedOwnerA, sharedOwnerB]), namespace: 'default', cwd: '/shared/x' })?.id).toBe('m-1')
        expect(pickImportMachine({ engine: engine([sharedOwnerA, sharedOwnerB]), namespace: 'default' })?.id).toBe('m-1')
    })

    it('returns null without an engine', () => {
        expect(pickImportMachine({ engine: null, namespace: 'default' })).toBeNull()
    })
})