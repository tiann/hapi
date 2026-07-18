import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessIdentity } from '@/runner/processIdentity';
import { createLaunchSigningMaterial } from '@/runner/managedOutcomeMailbox';
import { createRunnerLifecycle, readManagedStopIntent } from './runnerLifecycle';

const controlClient = vi.hoisted(() => ({ submitManagedOutcome: vi.fn() }))
vi.mock('@/runner/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/runner/controlClient')>(),
    submitManagedOutcome: controlClient.submitManagedOutcome
}))

const homes: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks()
    controlClient.submitManagedOutcome.mockReset()
    delete process.env.HAPI_MANAGED_OUTCOME_FD
    delete process.env.HAPI_LAUNCH_NONCE
    delete process.env.HAPI_RUNNER_INSTANCE_ID
    delete process.env.HAPI_HOME
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
});

describe('readManagedStopIntent', () => {
    it('accepts only an exact launch, runner, PID, and birth-token binding', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-lifecycle-'))
        homes.push(home)
        const identity = await readProcessIdentity(process.pid)
        await writeFile(join(home, 'runner-sessions.v1.json'), JSON.stringify({ launches: {
            nonce: {
                runnerInstanceId: 'runner', pid: process.pid, birthToken: identity!.birthToken,
                recycleIntent: { pid: process.pid, birthToken: identity!.birthToken, reason: 'runner-recycle' }
            }
        } }))

        await expect(readManagedStopIntent({
            home, argv: ['hapi', '--hapi-launch-nonce', 'nonce', '--hapi-runner-instance', 'runner']
        })).resolves.toEqual({ stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle' })
        await expect(readManagedStopIntent({
            home, argv: ['hapi', '--hapi-launch-nonce', 'other', '--hapi-runner-instance', 'runner']
        })).resolves.toBeNull()
    })
})

describe('runner lifecycle cleanup', () => {
    function createSession(calls: string[], options: { flushError?: Error } = {}) {
        return {
            updateMetadata: () => { calls.push('metadata'); },
            sendSessionDeath: () => { calls.push('death'); },
            flush: async () => {
                calls.push('flush');
                if (options.flushError) throw options.flushError
            },
            close: async () => { calls.push('close'); }
        }
    }

    it('publishes terminal session cleanup even when provider cleanup fails', async () => {
        const calls: string[] = []
        const lifecycle = createRunnerLifecycle({
            session: createSession(calls) as never,
            logTag: 'test',
            onBeforeClose: async () => {
                calls.push('provider-cleanup')
                throw new Error('disconnect failed')
            }
        })

        await expect(lifecycle.cleanup()).rejects.toThrow('disconnect failed')
        expect(calls).toEqual(['provider-cleanup', 'metadata', 'death', 'flush', 'close'])
    })

    it('still closes the session when flushing its terminal state fails', async () => {
        const calls: string[] = []
        const lifecycle = createRunnerLifecycle({
            session: createSession(calls, { flushError: new Error('flush failed') }) as never,
            logTag: 'test'
        })

        await expect(lifecycle.cleanup()).rejects.toThrow('flush failed')
        expect(calls).toEqual(['metadata', 'death', 'flush', 'close'])
    })

    it('reports the exact managed outcome ID only after Runner acknowledgement', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-lifecycle-outcome-'))
        homes.push(home)
        const signing = createLaunchSigningMaterial()
        const signingPath = join(home, 'signing.json')
        await writeFile(signingPath, JSON.stringify({
            launchNonce: 'launch-ack',
            runnerInstanceId: 'runner-ack',
            privateKey: signing.privateKey
        }))
        process.env.HAPI_MANAGED_OUTCOME_FD = String(openSync(signingPath, 'r'))
        process.env.HAPI_LAUNCH_NONCE = 'launch-ack'
        process.env.HAPI_RUNNER_INSTANCE_ID = 'runner-ack'
        process.env.HAPI_HOME = home
        controlClient.submitManagedOutcome.mockResolvedValue({ acknowledged: true })
        const calls: string[] = []
        const acknowledged = vi.fn((receipt: { idempotencyKey: string }) => {
            calls.push(`ack:${receipt.idempotencyKey}`)
        })
        const lifecycle = createRunnerLifecycle({
            session: createSession(calls) as never,
            logTag: 'test',
            resolveManagedStopIntent: async () => null,
            onManagedOutcomeAcknowledged: acknowledged
        })

        await lifecycle.cleanup()

        expect(acknowledged).toHaveBeenCalledWith({
            launchNonce: 'launch-ack',
            idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
            outcome: { lifecycleState: 'archived' }
        })
        const outcomeId = acknowledged.mock.calls[0][0].idempotencyKey
        expect(controlClient.submitManagedOutcome).toHaveBeenCalledWith(expect.objectContaining({
            launchNonce: 'launch-ack',
            idempotencyKey: outcomeId,
            outcome: { lifecycleState: 'archived' },
            algorithm: 'Ed25519'
        }))
        expect(calls[0]).toBe(`ack:${outcomeId}`)
    })

    it('does not report managed outcome acknowledgement when Runner leaves it spooled', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-lifecycle-spool-'))
        homes.push(home)
        const signing = createLaunchSigningMaterial()
        const signingPath = join(home, 'signing.json')
        await writeFile(signingPath, JSON.stringify({
            launchNonce: 'launch-spool',
            runnerInstanceId: 'runner-spool',
            privateKey: signing.privateKey
        }))
        process.env.HAPI_MANAGED_OUTCOME_FD = String(openSync(signingPath, 'r'))
        process.env.HAPI_LAUNCH_NONCE = 'launch-spool'
        process.env.HAPI_RUNNER_INSTANCE_ID = 'runner-spool'
        process.env.HAPI_HOME = home
        controlClient.submitManagedOutcome.mockResolvedValue({ acknowledged: false })
        const acknowledged = vi.fn()
        const lifecycle = createRunnerLifecycle({
            session: createSession([]) as never,
            logTag: 'test',
            resolveManagedStopIntent: async () => null,
            onManagedOutcomeAcknowledged: acknowledged
        })

        await lifecycle.cleanup()

        expect(acknowledged).not.toHaveBeenCalled()
    })

    it('waits for an in-flight SIGTERM stop-intent read before classifying cleanup', async () => {
        const calls: string[] = []
        const metadataStates: Array<Record<string, unknown>> = []
        let resolveIntent!: (intent: { stoppedBy: 'runner-recycle'; stopReasonCode: 'runner-recycle' }) => void
        const intent = new Promise<{ stoppedBy: 'runner-recycle'; stopReasonCode: 'runner-recycle' }>((resolve) => {
            resolveIntent = resolve
        })
        const handlers = new Map<string, (...args: unknown[]) => void>()
        vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler)
            return process
        }) as never)
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never))
        const session = {
            updateMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                calls.push('metadata')
                metadataStates.push(updater({}))
            },
            sendSessionDeath: () => { calls.push('death') },
            flush: async () => { calls.push('flush') },
            close: async () => { calls.push('close') }
        }
        const lifecycle = createRunnerLifecycle({
            session: session as never,
            logTag: 'test',
            resolveManagedStopIntent: async () => intent
        })
        lifecycle.registerProcessHandlers()

        handlers.get('SIGTERM')?.()
        const concurrentProviderCleanup = lifecycle.cleanup()
        resolveIntent({ stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle' })

        await concurrentProviderCleanup
        await vi.waitFor(() => expect(exit).toHaveBeenCalled())
        expect(metadataStates[0]).toMatchObject({
            lifecycleState: 'stopped',
            stoppedBy: 'runner-recycle',
            stopReasonCode: 'runner-recycle'
        })
        expect(calls).toEqual(['metadata', 'death', 'flush', 'close'])
    })

    it('checks managed stop intent when provider cleanup wins the SIGTERM delivery race', async () => {
        const metadataStates: Array<Record<string, unknown>> = []
        const session = {
            updateMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                metadataStates.push(updater({}))
            },
            sendSessionDeath: () => {},
            flush: async () => {},
            close: async () => {}
        }
        const lifecycle = createRunnerLifecycle({
            session: session as never,
            logTag: 'test',
            resolveManagedStopIntent: async () => ({
                stoppedBy: 'runner-recycle',
                stopReasonCode: 'runner-recycle'
            })
        })

        await lifecycle.cleanup()

        expect(metadataStates[0]).toMatchObject({
            lifecycleState: 'stopped',
            stoppedBy: 'runner-recycle',
            stopReasonCode: 'runner-recycle'
        })
    })
})
