import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'

describe('SyncEngine runner generation ensure', () => {
    it('calls stop-runner when skewed and on-disk CLI mtime differs', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const stopRunner = mock(async () => undefined)
            ;(engine as any).rpcGateway.stopRunner = stopRunner

            engine.getOrCreateMachine(
                'stale-runner',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    capabilities: [],
                    startedCliMtimeMs: 100,
                    installedCliMtimeMs: 200,
                },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'stale-runner', time: Date.now() })

            await new Promise((r) => setTimeout(r, 20))
            expect(stopRunner).toHaveBeenCalledWith('stale-runner')
        } finally {
            engine.stop()
        }
    })

    it('does not call stop-runner when skewed but binary mtime is unchanged', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const stopRunner = mock(async () => undefined)
            ;(engine as any).rpcGateway.stopRunner = stopRunner

            engine.getOrCreateMachine(
                'old-runner',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    startedCliMtimeMs: 100,
                    installedCliMtimeMs: 100,
                },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'old-runner', time: Date.now() })
            await new Promise((r) => setTimeout(r, 20))
            expect(stopRunner).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('does not call stop-runner when required capabilities are present', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const stopRunner = mock(async () => undefined)
            ;(engine as any).rpcGateway.stopRunner = stopRunner

            engine.getOrCreateMachine(
                'current-runner',
                {
                    host: 'oos',
                    platform: 'linux',
                    happyCliVersion: '0.23.0',
                    capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                    startedCliMtimeMs: 100,
                    installedCliMtimeMs: 200,
                },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'current-runner', time: Date.now() })
            await new Promise((r) => setTimeout(r, 20))
            expect(stopRunner).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })
})
