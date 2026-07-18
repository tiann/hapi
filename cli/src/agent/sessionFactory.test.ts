import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_CAPABILITIES } from '@hapi/protocol'
import { buildMachineMetadata, buildSessionMetadata, deliverSessionStartedToRunner } from './sessionFactory'

describe('buildMachineMetadata', () => {
    it('includes a validated provider readiness snapshot when supplied', () => {
        const metadata = buildMachineMetadata({
            grok: {
                status: 'ready',
                installed: true,
                authenticated: true,
                authCheck: 'credential-file',
                version: '0.2.101',
                ...PROVIDER_CAPABILITIES.grok,
                checkedAt: 123,
            },
        })

        expect(metadata.providerReadiness?.grok).toMatchObject({
            status: 'ready',
            version: '0.2.101',
            experimental: true,
        })
    })

    it('keeps readiness optional for direct terminal compatibility', () => {
        expect(buildMachineMetadata().providerReadiness).toBeUndefined()
    })
})

describe('buildSessionMetadata', () => {
    const originalHostname = process.env.HAPI_HOSTNAME

    afterEach(() => {
        if (originalHostname === undefined) {
            delete process.env.HAPI_HOSTNAME
        } else {
            process.env.HAPI_HOSTNAME = originalHostname
        }
    })

    it('uses HAPI_HOSTNAME for session metadata host when provided', () => {
        process.env.HAPI_HOSTNAME = 'custom-session-host'

        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123
        })

        expect(metadata.host).toBe('custom-session-host')
    })

    it('retries an identical managed webhook payload after a transient non-2xx result', async () => {
        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'runner',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123,
            metadataOverrides: {
                launchNonce: 'launch-1',
                runnerInstanceId: 'runner-1'
            }
        })
        const calls: Array<{ sessionId: string; metadata: typeof metadata }> = []
        const notify = vi.fn(async (sessionId: string, input: typeof metadata) => {
            calls.push({ sessionId, metadata: input })
            return calls.length === 1 ? { error: 'HTTP 500' } : { status: 'ok' }
        })
        const sleeps: number[] = []

        await expect(deliverSessionStartedToRunner({
            sessionId: 'session-1',
            metadata,
            notify,
            sleep: async (delayMs) => { sleeps.push(delayMs) }
        })).resolves.toEqual({ reported: true, attempts: 2 })

        expect(calls).toHaveLength(2)
        expect(calls[0]).toEqual({ sessionId: 'session-1', metadata })
        expect(calls[1]).toEqual({ sessionId: 'session-1', metadata })
        expect(calls[1]?.metadata).toBe(calls[0]?.metadata)
        expect(sleeps).toEqual([50])
    })

    it('keeps managed delivery alive across a bounded Runner replacement window', async () => {
        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'runner',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            metadataOverrides: {
                launchNonce: 'launch-2',
                runnerInstanceId: 'runner-2'
            }
        })
        const notify = vi.fn(async () => ({ error: 'Runner HTTP 500' }))
        const sleeps: number[] = []

        await expect(deliverSessionStartedToRunner({
            sessionId: 'session-2',
            metadata,
            notify,
            sleep: async (delayMs) => { sleeps.push(delayMs) }
        })).rejects.toThrow('after 18 attempts')

        expect(notify).toHaveBeenCalledTimes(18)
        expect(sleeps).toEqual([
            50, 100, 250, 500, 1_000, 2_000, 4_000,
            5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000
        ])
    })

    it('caps slow managed webhook attempts to one absolute replacement deadline', async () => {
        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'runner',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            metadataOverrides: {
                launchNonce: 'launch-slow',
                runnerInstanceId: 'runner-slow'
            }
        })
        let now = 0
        const requestBudgets: number[] = []
        const notify = vi.fn(async (_sessionId: string, _metadata: typeof metadata, maximumTimeoutMs?: number) => {
            requestBudgets.push(maximumTimeoutMs ?? Number.POSITIVE_INFINITY)
            now += Math.min(10_000, maximumTimeoutMs ?? 10_000)
            return { error: 'Runner request timed out' }
        })

        await expect(deliverSessionStartedToRunner({
            sessionId: 'session-slow',
            metadata,
            notify,
            now: () => now,
            deadlineMs: 60_000,
            sleep: async (delayMs) => { now += delayMs }
        })).rejects.toThrow('after 6 attempts')

        expect(now).toBe(60_000)
        expect(requestBudgets).toEqual([60_000, 49_950, 39_850, 29_600, 19_100, 8_100])
    })

    it('keeps unmanaged reporting single-attempt and best-effort', async () => {
        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1'
        })
        const notify = vi.fn(async () => { throw new Error('Runner is absent') })
        const sleep = vi.fn(async () => undefined)

        await expect(deliverSessionStartedToRunner({
            sessionId: 'terminal-session',
            metadata,
            notify,
            sleep
        })).resolves.toEqual({
            reported: false,
            attempts: 1,
            error: expect.objectContaining({ message: 'Runner is absent' })
        })
        expect(notify).toHaveBeenCalledTimes(1)
        expect(sleep).not.toHaveBeenCalled()
    })
})
