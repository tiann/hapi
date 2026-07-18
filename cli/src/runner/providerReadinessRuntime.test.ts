import { describe, expect, it, vi } from 'vitest'
import {
    PROVIDER_CAPABILITIES,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessMap,
} from '@hapi/protocol'
import {
    connectAndPublishProviderReadiness,
    createProviderReadinessPublisher,
    runWithProviderSpawnReadiness,
    type ProviderReadinessSource,
} from './providerReadinessRuntime'
import { buildMachineMetadata } from '@/agent/sessionFactory'
import type { MachineMetadata } from '@/api/types'

const NOW = 1_800_000_000_000

function entry(
    flavor: AgentFlavor,
    overrides: Partial<ProviderReadiness> = {},
): ProviderReadiness {
    return {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck: 'command',
        version: '1.2.3',
        ...PROVIDER_CAPABILITIES[flavor],
        checkedAt: NOW,
        ...overrides,
    }
}

function source(flavor: AgentFlavor, readiness: ProviderReadiness): ProviderReadinessSource {
    let snapshot: ProviderReadinessMap = { [flavor]: readiness }
    return {
        probe: vi.fn(async () => {
            snapshot = { ...snapshot, [flavor]: readiness }
            return readiness
        }),
        snapshot: vi.fn(() => snapshot),
        refreshDue: vi.fn(async () => ({ changed: false, snapshot })),
    }
}

describe('runWithProviderSpawnReadiness', () => {
    it('returns before worktree creation, launch reservation, or child spawn when fresh auth fails', async () => {
        const readiness = entry('grok', {
            status: 'not-authenticated',
            authenticated: false,
            authCheck: 'credential-file',
        })
        const readinessSource = source('grok', readiness)
        const publish = vi.fn(async () => undefined)
        const createWorktree = vi.fn(async () => undefined)
        const reserveLaunch = vi.fn(async () => undefined)
        const spawnHappyCLI = vi.fn(async () => ({ type: 'success' as const }))

        const result = await runWithProviderSpawnReadiness({
            flavor: 'grok',
            selection: { model: 'grok-4.5', effort: 'high', mode: 'safe-yolo' },
            source: readinessSource,
            publish,
            now: NOW,
        }, async () => {
            await createWorktree()
            await reserveLaunch()
            return await spawnHappyCLI()
        })

        expect(result).toMatchObject({
            type: 'error',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code',
        })
        expect(createWorktree).not.toHaveBeenCalled()
        expect(reserveLaunch).not.toHaveBeenCalled()
        expect(spawnHappyCLI).not.toHaveBeenCalled()
        expect(publish).toHaveBeenCalledOnce()
    })

    it('rejects an unreported selection before entering the spawn body', async () => {
        const onReady = vi.fn(async () => ({ type: 'success' as const }))

        const result = await runWithProviderSpawnReadiness({
            flavor: 'grok',
            selection: { model: 'unreported-model' },
            source: source('grok', entry('grok')),
            now: NOW,
        }, onReady)

        expect(result).toMatchObject({ type: 'error', code: 'provider-model-unavailable' })
        expect(onReady).not.toHaveBeenCalled()
    })

    it('accepts request-token authentication without weakening the remaining readiness checks', async () => {
        const onReady = vi.fn(async () => ({ type: 'success' as const, sessionId: 'token-session' }))
        const readiness = entry('claude', {
            status: 'not-authenticated',
            authenticated: false,
        })

        const result = await runWithProviderSpawnReadiness({
            flavor: 'claude',
            selection: {
                model: 'sonnet',
                requestTokenAuth: true,
            },
            source: source('claude', readiness),
            now: NOW,
        }, onReady)

        expect(result).toEqual({ type: 'success', sessionId: 'token-session' })
        expect(onReady).toHaveBeenCalledOnce()
    })

    it('rejects unreported effective defaults before entering the spawn body', async () => {
        const cases = [
            {
                flavor: 'agy' as const,
                readiness: entry('agy', { models: ['Gemini 3.5 Flash (Low)'] }),
                code: 'provider-model-unavailable'
            },
            {
                flavor: 'claude-deepseek' as const,
                readiness: entry('claude-deepseek', {
                    efforts: { auto: ['auto', 'low', 'medium', 'high'] }
                }),
                code: 'provider-effort-unavailable'
            },
            {
                flavor: 'grok' as const,
                readiness: entry('grok', { modes: ['safe-yolo'] }),
                code: 'provider-mode-unavailable'
            }
        ]

        for (const testCase of cases) {
            const onReady = vi.fn(async () => ({ type: 'success' as const }))
            const result = await runWithProviderSpawnReadiness({
                flavor: testCase.flavor,
                selection: {},
                source: source(testCase.flavor, testCase.readiness),
                now: NOW,
            }, onReady)

            expect(result).toMatchObject({ type: 'error', code: testCase.code })
            expect(onReady).not.toHaveBeenCalled()
        }
    })

    it('continues on fresh valid readiness even when best-effort publication rejects', async () => {
        const onReady = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }))
        const publish = vi.fn(async () => { throw new Error('hub unavailable') })

        const result = await runWithProviderSpawnReadiness({
            flavor: 'grok',
            selection: { model: 'grok-4.5', effort: 'high', mode: 'safe-yolo' },
            source: source('grok', entry('grok')),
            publish,
            now: NOW,
        }, onReady)

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' })
        expect(onReady).toHaveBeenCalledOnce()
        expect(publish).toHaveBeenCalledOnce()
        await Promise.resolve()
    })

    it('fails closed without exposing a probe exception', async () => {
        const readinessSource = source('grok', entry('grok'))
        readinessSource.probe = vi.fn(async () => { throw new Error('raw provider output') })
        const onReady = vi.fn(async () => ({ type: 'success' as const }))

        const result = await runWithProviderSpawnReadiness({
            flavor: 'grok',
            selection: {},
            source: readinessSource,
            now: NOW,
        }, onReady)

        expect(result).toMatchObject({ type: 'error', code: 'provider-probe-failed' })
        expect(JSON.stringify(result)).not.toContain('raw provider output')
        expect(onReady).not.toHaveBeenCalled()
    })
})

describe('createProviderReadinessPublisher', () => {
    it('publishes only completed changed snapshots', async () => {
        const snapshot = { grok: entry('grok') }
        const readinessSource = source('grok', snapshot.grok)
        const publish = vi.fn(async () => undefined)
        const publisher = createProviderReadinessPublisher(readinessSource, publish)

        await expect(publisher.refreshAndPublish()).resolves.toBe(false)
        expect(publish).not.toHaveBeenCalled()

        readinessSource.refreshDue = vi.fn(async () => ({ changed: true, snapshot }))
        await expect(publisher.refreshAndPublish()).resolves.toBe(true)
        expect(publish).toHaveBeenCalledWith(snapshot)
    })

    it('retries a failed changed snapshot on the next unchanged heartbeat', async () => {
        const snapshot = { grok: entry('grok', { checkedAt: NOW + 1 }) }
        const readinessSource = source('grok', snapshot.grok)
        readinessSource.refreshDue = vi.fn()
            .mockResolvedValueOnce({ changed: true, snapshot })
            .mockResolvedValueOnce({ changed: false, snapshot })
        const publish = vi.fn()
            .mockRejectedValueOnce(new Error('transient metadata ack failure'))
            .mockResolvedValueOnce(undefined)
        const publisher = createProviderReadinessPublisher(readinessSource, publish)

        await expect(publisher.refreshAndPublish()).rejects.toThrow('transient metadata ack failure')
        await expect(publisher.refreshAndPublish()).resolves.toBe(true)
        expect(publish).toHaveBeenCalledTimes(2)
        expect(publish).toHaveBeenNthCalledWith(1, snapshot)
        expect(publish).toHaveBeenNthCalledWith(2, snapshot)
    })

    it('retries a failed pre-spawn publication on the next unchanged heartbeat', async () => {
        const snapshot = { grok: entry('grok', { checkedAt: NOW + 2 }) }
        const readinessSource = source('grok', snapshot.grok)
        const publish = vi.fn()
            .mockRejectedValueOnce(new Error('pre-spawn metadata ack failure'))
            .mockResolvedValueOnce(undefined)
        const publisher = createProviderReadinessPublisher(readinessSource, publish)

        await expect(publisher.publish(snapshot)).rejects.toThrow('pre-spawn metadata ack failure')
        await expect(publisher.refreshAndPublish()).resolves.toBe(true)
        expect(publish).toHaveBeenCalledTimes(2)
        expect(publish).toHaveBeenNthCalledWith(2, snapshot)
    })

    it('does not let an older publication success clear a newer failed generation', async () => {
        const older = { grok: entry('grok', { checkedAt: NOW + 2 }) }
        const current = { grok: entry('grok', { checkedAt: NOW + 3 }) }
        let releaseOlder!: () => void
        const readinessSource: ProviderReadinessSource = {
            probe: vi.fn(async () => current.grok),
            snapshot: vi.fn(() => current),
            refreshDue: vi.fn(async () => ({ changed: false, snapshot: current })),
        }
        const publish = vi.fn()
            .mockImplementationOnce(async () => await new Promise<void>((resolve) => {
                releaseOlder = resolve
            }))
            .mockRejectedValueOnce(new Error('newer metadata ack failure'))
            .mockResolvedValueOnce(undefined)
        const publisher = createProviderReadinessPublisher(readinessSource, publish)

        const olderPublication = publisher.publish(older)
        await expect(publisher.publish(current)).rejects.toThrow('newer metadata ack failure')
        releaseOlder()
        await olderPublication

        await expect(publisher.refreshAndPublish()).resolves.toBe(true)
        expect(publish).toHaveBeenCalledTimes(3)
        expect(publish).toHaveBeenNthCalledWith(3, current)
    })
})

describe('connectAndPublishProviderReadiness', () => {
    it('authoritatively replaces historical readiness on a new Runner connection', async () => {
        let metadata: MachineMetadata = buildMachineMetadata({
            grok: entry('grok', {
                status: 'ready',
                authenticated: true,
                checkedAt: NOW + 10_000,
            }),
        })
        const restarted = entry('grok', {
            status: 'not-authenticated',
            authenticated: false,
            checkedAt: NOW - 10_000,
        })
        const channel = {
            connect: vi.fn(),
            waitForConnected: vi.fn(async () => true),
            updateMachineMetadata: vi.fn(async (handler: (current: MachineMetadata | null) => MachineMetadata) => {
                metadata = handler(metadata)
            }),
        }

        await connectAndPublishProviderReadiness(channel, source('grok', restarted), 15_000)

        expect(metadata.providerReadiness?.grok).toMatchObject({
            status: 'not-authenticated',
            authenticated: false,
            checkedAt: NOW - 10_000,
        })
    })

    it('recomputes the authoritative snapshot on an initial retry after a newer concurrent probe', async () => {
        const initial = entry('grok', {
            status: 'not-authenticated',
            authenticated: false,
            checkedAt: NOW,
        })
        const newer = entry('grok', {
            status: 'ready',
            authenticated: true,
            checkedAt: NOW + 1,
        })
        let currentSnapshot: ProviderReadinessMap = { grok: initial }
        let metadata: MachineMetadata = buildMachineMetadata({
            grok: entry('grok', { checkedAt: NOW - 1 }),
        })
        const readinessSource: ProviderReadinessSource = {
            probe: vi.fn(async () => newer),
            snapshot: vi.fn(() => currentSnapshot),
            refreshDue: vi.fn(async () => ({ changed: false, snapshot: currentSnapshot })),
        }
        const channel = {
            connect: vi.fn(),
            waitForConnected: vi.fn(async () => true),
            updateMachineMetadata: vi.fn(async (handler: (current: MachineMetadata | null) => MachineMetadata) => {
                metadata = handler(metadata)
                currentSnapshot = { grok: newer }
                metadata = buildMachineMetadata(currentSnapshot, metadata)
                metadata = handler(metadata)
            }),
        }

        await connectAndPublishProviderReadiness(channel, readinessSource, 15_000)

        expect(readinessSource.snapshot).toHaveBeenCalledTimes(2)
        expect(metadata.providerReadiness?.grok).toMatchObject({
            status: 'ready',
            authenticated: true,
            checkedAt: NOW + 1,
        })
    })

    it('version-publishes the current snapshot only after the machine channel connects', async () => {
        const order: string[] = []
        let metadata: MachineMetadata = {
            ...buildMachineMetadata({
                grok: entry('grok', { checkedAt: NOW + 100 }),
            }),
            displayName: 'Studio Runner',
        }
        let metadataVersion = 4
        const channel = {
            connect: vi.fn(() => { order.push('connect') }),
            waitForConnected: vi.fn(async () => {
                order.push('connected')
                return true
            }),
            updateMachineMetadata: vi.fn(async (handler: (current: MachineMetadata | null) => MachineMetadata) => {
                order.push('metadata')
                metadata = handler(metadata)
                metadataVersion += 1
            }),
        }

        await expect(connectAndPublishProviderReadiness(
            channel,
            source('grok', entry('grok')),
            15_000,
        )).resolves.toBe(true)

        expect(order).toEqual(['connect', 'connected', 'metadata'])
        expect(metadataVersion).toBe(5)
        expect(metadata.providerReadiness?.grok?.status).toBe('ready')
        expect(metadata.providerReadiness?.grok?.checkedAt).toBe(NOW)
        expect(metadata.displayName).toBe('Studio Runner')
    })

    it('fails startup without writing metadata when the channel cannot connect', async () => {
        const channel = {
            connect: vi.fn(),
            waitForConnected: vi.fn(async () => false),
            updateMachineMetadata: vi.fn(async () => undefined),
        }

        await expect(connectAndPublishProviderReadiness(
            channel,
            source('grok', entry('grok')),
            1,
        )).rejects.toThrow('managed hub outcome path')
        expect(channel.updateMachineMetadata).not.toHaveBeenCalled()
    })

    it('refreshes and republishes the authoritative snapshot after reconnect', async () => {
        let reconnectHandler: (() => Promise<void> | void) | null = null
        let metadata: MachineMetadata = buildMachineMetadata()
        const readinessSource = source('grok', entry('grok'))
        const channel = {
            connect: vi.fn(),
            waitForConnected: vi.fn(async () => true),
            updateMachineMetadata: vi.fn(async (handler: (current: MachineMetadata | null) => MachineMetadata) => {
                metadata = handler(metadata)
            }),
            onConnected: vi.fn((handler: () => Promise<void> | void) => {
                reconnectHandler = handler
                return () => undefined
            }),
        }

        await connectAndPublishProviderReadiness(channel, readinessSource, 15_000)
        expect(channel.updateMachineMetadata).toHaveBeenCalledTimes(1)
        expect(reconnectHandler).not.toBeNull()

        await reconnectHandler!()

        expect(readinessSource.refreshDue).toHaveBeenCalledOnce()
        expect(channel.updateMachineMetadata).toHaveBeenCalledTimes(2)
        expect(metadata.providerReadiness?.grok?.status).toBe('ready')
    })

    it('leaves a failed reconnect publication dirty for the next unchanged heartbeat', async () => {
        let reconnectHandler: (() => Promise<void> | void) | null = null
        const snapshot = { grok: entry('grok', { checkedAt: NOW + 3 }) }
        const readinessSource = source('grok', snapshot.grok)
        readinessSource.refreshDue = vi.fn()
            .mockResolvedValueOnce({ changed: true, snapshot })
            .mockResolvedValueOnce({ changed: false, snapshot })
        const updateMachineMetadata = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('reconnect metadata ack failure'))
            .mockResolvedValueOnce(undefined)
        const channel = {
            connect: vi.fn(),
            waitForConnected: vi.fn(async () => true),
            updateMachineMetadata,
            onConnected: vi.fn((handler: () => Promise<void> | void) => {
                reconnectHandler = handler
                return () => undefined
            }),
        }
        const publisher = createProviderReadinessPublisher(readinessSource, async (current) => {
            await channel.updateMachineMetadata((metadata: MachineMetadata) => buildMachineMetadata(current, metadata))
        })

        await connectAndPublishProviderReadiness(channel, readinessSource, 15_000, publisher.publish)
        await reconnectHandler!()
        await expect(publisher.refreshAndPublish()).resolves.toBe(true)
        expect(updateMachineMetadata).toHaveBeenCalledTimes(3)
    })
})
