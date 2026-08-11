import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('SyncEngine restartMachineRunner', () => {
    it('refuses Restart on unsupervised hosts (stop would leave runner offline)', async () => {
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
                { host: 'laptop', platform: 'linux', happyCliVersion: '0.20.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'manual-runner', time: Date.now() })

            const result = await engine.restartMachineRunner('manual-runner', 'default')
            expect(result.type).toBe('error')
            if (result.type === 'error') {
                expect(result.code).toBe('restart_unsupported')
            }
            expect(stopRunner).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('stop-runners for a supervised online machine (banner escape hatch)', async () => {
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
                'supervised-runner',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    supervisedRestart: true,
                },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'supervised-runner', time: Date.now() })

            const result = await engine.restartMachineRunner('supervised-runner', 'default')
            expect(result).toEqual({
                type: 'success',
                message: 'Runner stop requested; supervisor will relaunch',
            })
            expect(stopRunner).toHaveBeenCalledWith('supervised-runner')
        } finally {
            engine.stop()
        }
    })
})
