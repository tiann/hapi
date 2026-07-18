import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('SyncEngine restartMachineRunner', () => {
    it('stop-runners for an online machine (manual banner escape hatch)', async () => {
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
                'manual-runner',
                { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'manual-runner', time: Date.now() })

            const result = await engine.restartMachineRunner('manual-runner', 'default')
            expect(result).toEqual({ type: 'success', message: 'Runner restart requested' })
            expect(stopRunner).toHaveBeenCalledWith('manual-runner')
        } finally {
            engine.stop()
        }
    })
})
