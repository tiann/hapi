import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { HubUpgradeOffer } from '@hapi/protocol/upgradeChannel'

describe('SyncEngine fleet upgrade', () => {
    it('upgradeMachineRunner sends runner-self-upgrade RPC for npm channel', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => offer },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'stale',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    capabilities: ['runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'stale', time: Date.now() })

            const result = await engine.upgradeMachineRunner('stale', 'default')
            expect(result.type).toBe('success')
            expect(runnerSelfUpgrade).toHaveBeenCalledWith('stale', offer)
        } finally {
            engine.stop()
        }
    })

    it('refuses upgrade when channel is off', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            {
                getUpgradeOffer: () => ({
                    channel: 'off',
                    targetVersion: '0.24.0',
                    targetCapabilities: [],
                }),
            },
        )

        try {
            engine.getOrCreateMachine(
                'stale',
                { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'stale', time: Date.now() })
            const result = await engine.upgradeMachineRunner('stale', 'default')
            expect(result).toEqual({
                type: 'error',
                message: 'Fleet upgrade disabled (HAPI_UPGRADE_CHANNEL=off)',
                code: 'upgrade_unavailable',
            })
        } finally {
            engine.stop()
        }
    })

    it('refuses hub-artifact upgrade when machine arch is missing', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
        }
        const store = new Store(':memory:')
        const prepareArtifactOffer = mock(async () => offer)
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => offer, prepareArtifactOffer },
        )

        try {
            engine.getOrCreateMachine(
                'no-arch',
                {
                    host: 'teemo',
                    platform: 'win32',
                    happyCliVersion: '0.20.0',
                    capabilities: ['runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'no-arch', time: Date.now() })
            const result = await engine.upgradeMachineRunner('no-arch', 'default')
            expect(result).toEqual({
                type: 'error',
                message: 'Machine platform/arch unavailable for hub-artifact upgrade',
                code: 'upgrade_unavailable',
            })
            expect(prepareArtifactOffer).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('prepares hub-artifact for the runner platform/arch, not the hub host', async () => {
        const baseOffer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
        }
        const prepared: HubUpgradeOffer = {
            ...baseOffer,
            artifact: {
                url: '/cli/upgrade/cli-artifact',
                sha256: 'abc',
                platform: 'darwin',
                arch: 'arm64',
                sizeBytes: 10,
            },
        }
        const store = new Store(':memory:')
        const prepareArtifactOffer = mock(async () => prepared)
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => baseOffer, prepareArtifactOffer },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'hub-artifact',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'mac',
                {
                    host: 'mac',
                    platform: 'darwin',
                    arch: 'arm64',
                    happyCliVersion: '0.20.0',
                    capabilities: ['runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'mac', time: Date.now() })
            const result = await engine.upgradeMachineRunner('mac', 'default')
            expect(result.type).toBe('success')
            expect(prepareArtifactOffer).toHaveBeenCalledWith(baseOffer, 'darwin', 'arm64')
            expect(runnerSelfUpgrade).toHaveBeenCalledWith('mac', prepared)
        } finally {
            engine.stop()
        }
    })

    it('refuses upgrade when runner lacks runner-self-upgrade capability', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => offer },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'too-old',
                { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0', capabilities: [] },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'too-old', time: Date.now() })

            const result = await engine.upgradeMachineRunner('too-old', 'default')
            expect(result).toEqual({
                type: 'error',
                message: 'Runner does not support self-upgrade; upgrade the CLI manually and restart the runner',
                code: 'upgrade_unavailable',
            })
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('skips auto fleet upgrade when runner advertised versionHandoffDisabled', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => offer },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'opt-out',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    capabilities: [],
                    versionHandoffDisabled: true,
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'opt-out', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 10))
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })
})
