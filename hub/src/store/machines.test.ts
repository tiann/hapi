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

    it('clears omitted runner ads when clearOmittedRunnerAds is set', () => {
        const merged = mergeMachineMetadata(
            {
                host: 'box',
                capabilities: ['stop-runner'],
                supervisedRestart: true,
                startedCliMtimeMs: 1,
                installedCliMtimeMs: 2,
                displayName: 'keep-me',
            },
            { host: 'box', supervisedRestart: false },
            { clearOmittedRunnerAds: true },
        )
        expect(merged).toEqual({
            host: 'box',
            supervisedRestart: false,
            displayName: 'keep-me',
        })
    })

    it('keeps sticky runner ads without clearOmittedRunnerAds (terminal bootstrap)', () => {
        const merged = mergeMachineMetadata(
            { host: 'box', capabilities: ['stop-runner'], supervisedRestart: true },
            { host: 'box' },
        )
        expect(merged).toBeUndefined()
    })
})

describe('runner metadata ad clear on re-registration', () => {
    it('drops sticky supervisedRestart and capabilities when runner re-registers without them', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'machine-1',
            {
                host: 'box',
                capabilities: ['stop-runner'],
                supervisedRestart: true,
                startedCliMtimeMs: 10,
            },
            { status: 'running', pid: 1 },
            'ns',
        )

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            { host: 'box', supervisedRestart: false },
            { status: 'running', pid: 2 },
            'ns',
        )

        expect(refreshed.metadata).toEqual({ host: 'box', supervisedRestart: false })
        expect(refreshed.metadata).not.toHaveProperty('capabilities')
        expect(refreshed.metadata).not.toHaveProperty('startedCliMtimeMs')
    })

    it('does not clear runner ads on terminal-only metadata refresh (no runnerState)', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'machine-1',
            { host: 'box', capabilities: ['stop-runner'], supervisedRestart: true },
            { status: 'running', pid: 1 },
            'ns',
        )

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            { host: 'box' },
            null,
            'ns',
        )

        expect(refreshed.metadata).toEqual({
            host: 'box',
            capabilities: ['stop-runner'],
            supervisedRestart: true,
        })
    })
})

describe('runner capabilities backfill', () => {
    it('merges registration-time capabilities into an existing machine', () => {
        const store = new Store(':memory:')
        const created = store.machines.getOrCreateMachine('machine-1', null, { status: 'offline', pid: 1 }, 'ns')
        expect(created.runnerState).toEqual({ status: 'offline', pid: 1 })

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            null,
            { status: 'offline', pid: 2, capabilities: { piExistingSessionResume: true } },
            'ns'
        )

        expect(refreshed.runnerState).toEqual({
            status: 'offline',
            pid: 1,
            capabilities: { piExistingSessionResume: true }
        })
        expect(refreshed.runnerStateVersion).toBe(created.runnerStateVersion + 1)
    })

    it('keeps live runner-state fields socket-owned on registration', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine('machine-1', null, { status: 'running', pid: 99 }, 'ns')

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            null,
            { status: 'offline', pid: 100, startedAt: 1, capabilities: { piExistingSessionResume: true } },
            'ns'
        )

        expect(refreshed.runnerState).toEqual({
            status: 'running',
            pid: 99,
            capabilities: { piExistingSessionResume: true }
        })
    })

    it('does not write when capabilities are unchanged or absent', () => {
        const store = new Store(':memory:')
        const created = store.machines.getOrCreateMachine(
            'machine-1',
            null,
            { status: 'running', capabilities: { piExistingSessionResume: true } },
            'ns'
        )

        const unchanged = store.machines.getOrCreateMachine(
            'machine-1',
            null,
            { status: 'offline', capabilities: { piExistingSessionResume: true } },
            'ns'
        )
        expect(unchanged.runnerStateVersion).toBe(created.runnerStateVersion)

        const noCaps = store.machines.getOrCreateMachine('machine-1', null, { status: 'offline' }, 'ns')
        expect(noCaps.runnerStateVersion).toBe(created.runnerStateVersion)
    })

    it('merges capabilities even when metadata also changes in the same call', () => {
        const store = new Store(':memory:')
        const created = store.machines.getOrCreateMachine('machine-1', { host: 'old-host' }, { status: 'offline', pid: 1 }, 'ns')

        const refreshed = store.machines.getOrCreateMachine(
            'machine-1',
            { host: 'new-host', happyCliVersion: '0.28.0' },
            { status: 'offline', pid: 2, capabilities: { piExistingSessionResume: true } },
            'ns'
        )

        expect(refreshed.metadata).toEqual({ host: 'new-host', happyCliVersion: '0.28.0' })
        expect(refreshed.metadataVersion).toBe(created.metadataVersion + 1)
        expect(refreshed.runnerState).toEqual({
            status: 'offline',
            pid: 1,
            capabilities: { piExistingSessionResume: true }
        })
        expect(refreshed.runnerStateVersion).toBe(created.runnerStateVersion + 1)
    })
})
