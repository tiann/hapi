import { describe, expect, it, mock } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { TransientArtifactBuildError } from '../upgrade/cliArtifact'
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

    it('upgradeMachineRunner cold-cache fallback honors live RPC capabilities', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const store = new Store(':memory:')
        const registry = new RpcRegistry()
        const engine = new SyncEngine(
            store,
            {} as never,
            registry,
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

            // Persist without advertising runner-self-upgrade — only the live RPC
            // registration proves the capability (npm CLIs historically omitted it).
            engine.getOrCreateMachine(
                'cold',
                {
                    host: 'teemo',
                    platform: 'win32',
                    arch: 'x64',
                    happyCliVersion: '0.20.0',
                },
                { status: 'running', pid: 1, startedAt: Date.now() },
                'default',
            )
            engine.handleMachineAlive({ machineId: 'cold', time: Date.now() })
            registry.register(
                { id: 'sock-cold' } as never,
                `cold:${MACHINE_CAPABILITIES.RunnerSelfUpgrade}`,
            )

            // Force the getMachineByNamespace miss → refreshMachine fallback path.
            // Persist active so the cold reload does not look offline (alive only
            // mutates the in-memory row).
            store.machines.updateMachineRunnerState(
                'cold',
                { status: 'running', pid: 1, startedAt: Date.now() },
                1,
                'default',
            )
            ;(engine as any).machineCache.machines.clear()

            const result = await engine.upgradeMachineRunner('cold', 'default')
            expect(result.type).toBe('success')
            expect(runnerSelfUpgrade).toHaveBeenCalledWith('cold', offer)
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
            targetGeneration: 'post-build-fingerprint',
            artifact: {
                url: '/cli/upgrade/cli-artifact',
                sha256: 'abc',
                platform: 'darwin',
                arch: 'arm64',
                sizeBytes: 10,
            },
        }
        const store = new Store(':memory:')
        const prepareArtifactOffer = mock(async (offer: HubUpgradeOffer) => ({
            ...offer,
            // Simulates ensureCliArtifact changing the fingerprint vs pre-build offer.
            targetGeneration: 'post-build-fingerprint',
            artifact: prepared.artifact,
        }))
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            {
                getUpgradeOffer: () => ({ ...baseOffer, targetGeneration: 'pre-build-fingerprint' }),
                prepareArtifactOffer,
            },
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
            expect(prepareArtifactOffer).toHaveBeenCalled()
            expect(runnerSelfUpgrade).toHaveBeenCalledWith(
                'mac',
                expect.objectContaining({ targetGeneration: 'post-build-fingerprint' }),
            )
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

    it('auto fleet upgrade fires on pure semver drift (set and forget)', async () => {
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
            { getUpgradeOffer: () => offer, getFleetUpgradePolicy: () => 'auto' },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            // Missing NO required capability, just behind on version.
            engine.getOrCreateMachine(
                'behind',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.23.1',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'behind', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 10))
            expect(runnerSelfUpgrade).toHaveBeenCalledWith('behind', offer)
        } finally {
            engine.stop()
        }
    })

    it('auto fleet upgrade skips a runner already at target version + capabilities', async () => {
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
            { getUpgradeOffer: () => offer, getFleetUpgradePolicy: () => 'auto' },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'already-current',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'current',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.24.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'current', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 10))
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('auto fleet upgrade does not chase the 0.0.0 fallback target', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.0.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer: () => offer, getFleetUpgradePolicy: () => 'auto' },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'unknown-target',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.23.1',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'unknown-target', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 10))
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('does not auto-fire when policy is not auto (alert/silent)', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'npm',
            targetVersion: '0.24.0',
            targetCapabilities: ['cursor-chat-store-status'],
            npmPackage: '@twsxtd/hapi',
        }
        const getUpgradeOffer = mock(() => offer)
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { getUpgradeOffer, getFleetUpgradePolicy: () => 'alert' },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'npm',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'behind',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'behind', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 10))
            // alert policy surfaces the banner but never self-initiates the RPC.
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
            // And must not resolve the offer (fingerprint) on the heartbeat path.
            expect(getUpgradeOffer).not.toHaveBeenCalled()

            // Manual upgrade still works under 'alert' (banner button path).
            const result = await engine.upgradeMachineRunner('behind', 'default')
            expect(result.type).toBe('success')
            expect(runnerSelfUpgrade).toHaveBeenCalledWith('behind', offer)
            expect(getUpgradeOffer).toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('rejects already-current when the machine still trails generation', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.25.1',
            targetGeneration: 'gen-hub',
            targetCapabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'cli-artifact-generation'],
            artifact: {
                url: '/cli/upgrade/cli-artifact',
                sha256: 'abc',
                platform: 'linux',
                arch: 'x64',
                sizeBytes: 1,
            },
        }
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            {
                getUpgradeOffer: () => offer,
                prepareArtifactOffer: async (base) => base,
            },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'already-current',
                message: 'Already at 0.25.1',
                channel: 'hub-artifact',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'stale-gen',
                {
                    host: 'homelab',
                    platform: 'linux',
                    arch: 'x64',
                    happyCliVersion: '0.25.1',
                    // Pre-generation runner: same semver, no fingerprint, no marker cap.
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'stop-runner'],
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'stale-gen', time: Date.now() })

            const result = await engine.upgradeMachineRunner('stale-gen', 'default')
            expect(result.type).toBe('error')
            if (result.type === 'error') {
                expect(result.code).toBe('upgrade_failed')
                expect(result.message).toMatch(/already-current but still trails/i)
            }
            expect(runnerSelfUpgrade).toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('refuses manual upgrade when runner advertised versionHandoffDisabled', async () => {
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
                'soup',
                {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                    versionHandoffDisabled: true,
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'soup', time: Date.now() })

            const result = await engine.upgradeMachineRunner('soup', 'default')
            expect(result).toEqual({
                type: 'error',
                message: 'Runner opted out of version handoff (soup/rebuild-only or HAPI_DISABLE_VERSION_HANDOFF=1); rematerialize soup or clear the opt-out',
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
            { getUpgradeOffer: () => offer, getFleetUpgradePolicy: () => 'auto' },
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

    it('auto fleet does not toast upgrade_deferred (mid-soup bun compile)', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.26.0',
            targetCapabilities: ['cursor-chat-store-status'],
            targetGeneration: 'new-fingerprint',
        }
        const store = new Store(':memory:')
        const sendToast = mock(async () => {})
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {}, sendToast } as never,
            {
                getUpgradeOffer: () => offer,
                getFleetUpgradePolicy: () => 'auto',
                prepareArtifactOffer: async () => {
                    throw new TransientArtifactBuildError(
                        'bun compile failed (source changed during build): Could not resolve: "./settingsStore"',
                    )
                },
            },
        )

        try {
            const runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'hub-artifact',
            }))
            ;(engine as any).rpcGateway.runnerSelfUpgrade = runnerSelfUpgrade

            engine.getOrCreateMachine(
                'teemo',
                {
                    host: 'Teemo',
                    platform: 'win32',
                    arch: 'x64',
                    happyCliVersion: '0.26.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'cli-artifact-generation'],
                    cliArtifactGeneration: 'old-fingerprint',
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'teemo', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(runnerSelfUpgrade).not.toHaveBeenCalled()
            expect(sendToast).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('auto fleet toasts stable Could not resolve (not mid-rebuild)', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.26.0',
            targetCapabilities: ['cursor-chat-store-status'],
            targetGeneration: 'new-fingerprint',
        }
        const store = new Store(':memory:')
        const sendToast = mock(async () => {})
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {}, sendToast } as never,
            {
                getUpgradeOffer: () => offer,
                getFleetUpgradePolicy: () => 'auto',
                prepareArtifactOffer: async () => {
                    // Plain Error: fingerprint unchanged during compile → permanent miss
                    throw new Error('bun compile failed: Could not resolve: "./settingsStore"')
                },
            },
        )

        try {
            ;(engine as any).rpcGateway.runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'hub-artifact',
            }))

            engine.getOrCreateMachine(
                'teemo-stable',
                {
                    host: 'Teemo',
                    platform: 'win32',
                    arch: 'x64',
                    happyCliVersion: '0.26.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'cli-artifact-generation'],
                    cliArtifactGeneration: 'old-fingerprint',
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'teemo-stable', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(sendToast).toHaveBeenCalledWith(
                'default',
                expect.objectContaining({
                    type: 'toast',
                    data: expect.objectContaining({
                        title: 'Runner upgrade failed',
                        body: expect.stringContaining('Could not resolve'),
                    }),
                }),
            )
        } finally {
            engine.stop()
        }
    })

    it('auto fleet toasts permanent artifact preparation failures', async () => {
        const offer: HubUpgradeOffer = {
            channel: 'hub-artifact',
            targetVersion: '0.26.0',
            targetCapabilities: ['cursor-chat-store-status'],
            targetGeneration: 'new-fingerprint',
        }
        const store = new Store(':memory:')
        const sendToast = mock(async () => {})
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {}, sendToast } as never,
            {
                getUpgradeOffer: () => offer,
                getFleetUpgradePolicy: () => 'auto',
                prepareArtifactOffer: async () => {
                    throw new Error('Missing tool archive for compile: ripgrep-win32-x64.tar.gz')
                },
            },
        )

        try {
            ;(engine as any).rpcGateway.runnerSelfUpgrade = mock(async () => ({
                status: 'started',
                message: 'ok',
                channel: 'hub-artifact',
            }))

            engine.getOrCreateMachine(
                'teemo',
                {
                    host: 'Teemo',
                    platform: 'win32',
                    arch: 'x64',
                    happyCliVersion: '0.26.0',
                    capabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'cli-artifact-generation'],
                    cliArtifactGeneration: 'old-fingerprint',
                },
                null,
                'default',
            )
            engine.handleMachineAlive({ machineId: 'teemo', time: Date.now() })
            await Promise.resolve()
            await new Promise((resolve) => setTimeout(resolve, 20))
            // EventPublisher → sseManager.sendToast(namespace, SyncEvent toast)
            expect(sendToast).toHaveBeenCalledWith(
                'default',
                expect.objectContaining({
                    type: 'toast',
                    data: expect.objectContaining({
                        title: 'Runner upgrade failed',
                        body: expect.stringContaining('Missing tool archive'),
                    }),
                }),
            )
        } finally {
            engine.stop()
        }
    })
})
