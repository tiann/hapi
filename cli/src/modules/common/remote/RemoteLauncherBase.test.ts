import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { ReactElement } from 'react'
import { RemoteLauncherBase, type LaunchOutcome } from './RemoteLauncherBase'

// Concrete subclass that exposes the protected respawn loop so the real
// template-method logic (backoff, give-up bound, counter reset) can be driven
// directly — the per-launcher tests mock this method out, so without this the
// live loop is uncovered.
class TestLauncher extends RemoteLauncherBase {
    constructor() {
        super(undefined)
    }
    protected createDisplay(): ReactElement {
        throw new Error('unused in test')
    }
    protected async runMainLoop(): Promise<void> {}
    protected async cleanup(): Promise<void> {}

    public run(opts: Parameters<RemoteLauncherBase['runRespawnLoop']>[0]): Promise<void> {
        return this.runRespawnLoop(opts)
    }
    // Stop the `while (!this.exitReason)` loop from outside the scripted outcomes.
    public stop(): void {
        this.exitReason = 'exit'
    }
}

// Drive launchOnce from a scripted list of outcomes; once exhausted, end the
// loop so the test terminates deterministically.
function scriptedLaunchOnce(launcher: TestLauncher, outcomes: LaunchOutcome[]) {
    let i = 0
    return vi.fn(async (): Promise<LaunchOutcome> => {
        if (i >= outcomes.length) {
            launcher.stop()
            return { reachedReady: false }
        }
        return outcomes[i++]
    })
}

const fail = (): LaunchOutcome => ({ reachedReady: false, error: new Error('boom') })
const readyCrash = (): LaunchOutcome => ({ reachedReady: true, error: new Error('crash') })

describe('RemoteLauncherBase.runRespawnLoop', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('gives up after maxImmediateFailures consecutive launches that never reach ready', async () => {
        const launcher = new TestLauncher()
        const onLaunchFailure = vi.fn()
        const launchOnce = scriptedLaunchOnce(launcher, [fail(), fail(), fail(), fail(), fail()])

        await launcher.run({
            maxImmediateFailures: 3,
            respawnBackoffMs: 0,
            onLaunchStart: () => {},
            launchOnce,
            onLaunchFailure,
        })

        // Bounded: stops at the cap, does not consume the 4th/5th scripted outcome.
        expect(launchOnce).toHaveBeenCalledTimes(3)
        // Each failure surfaced, plus a final give-up message.
        const lastMsg = onLaunchFailure.mock.calls.at(-1)?.[0] as Error
        expect(lastMsg.message).toContain('failed to start after 3 attempts')
    })

    it('keeps mid-session crash recovery unbounded when launches reach ready', async () => {
        const launcher = new TestLauncher()
        const onLaunchFailure = vi.fn()
        const onLaunchSuccess = vi.fn()
        // Four crashes that EACH reached a ready prompt — a long-running session
        // that keeps crashing must never hit the give-up bound.
        const launchOnce = scriptedLaunchOnce(launcher, [
            readyCrash(), readyCrash(), readyCrash(), readyCrash(),
        ])

        await launcher.run({
            maxImmediateFailures: 3,
            respawnBackoffMs: 0,
            onLaunchStart: () => {},
            launchOnce,
            onLaunchSuccess,
            onLaunchFailure,
        })

        // Respawned past the cap (4 > 3) because the counter resets on ready.
        expect(launchOnce).toHaveBeenCalledTimes(5)
        expect(onLaunchSuccess).toHaveBeenCalledTimes(4)
        const gaveUp = onLaunchFailure.mock.calls.some(
            ([e]) => (e as Error).message.includes('failed to start after')
        )
        expect(gaveUp).toBe(false)
    })

    it('backs off between immediate failures but not after a ready crash', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        const launcher = new TestLauncher()
        const launchOnce = scriptedLaunchOnce(launcher, [fail(), readyCrash()])

        await launcher.run({
            maxImmediateFailures: 5,
            respawnBackoffMs: 250,
            onLaunchStart: () => {},
            launchOnce,
            onLaunchFailure: () => {},
        })

        const backoffWaits = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 250)
        // Exactly one backoff: after the immediate failure, none after the ready crash.
        expect(backoffWaits).toHaveLength(1)
    })

    it('aborts each launch before respawning so a stale queue read cannot consume the next message', async () => {
        const launcher = new TestLauncher()
        const consumedBy: number[] = []
        let queuedMessage: string | null = null
        const waiters: Array<{ launch: number; signal: AbortSignal }> = []
        let launch = 0

        const launchOnce = vi.fn(async (signal: AbortSignal): Promise<LaunchOutcome> => {
            launch++
            waiters.push({ launch, signal })
            if (launch === 1) {
                return readyCrash()
            }
            queuedMessage = 'next turn'
            for (const waiter of waiters) {
                if (!waiter.signal.aborted && queuedMessage) {
                    consumedBy.push(waiter.launch)
                    queuedMessage = null
                }
            }
            launcher.stop()
            return { reachedReady: true }
        })

        await launcher.run({
            respawnBackoffMs: 0,
            onLaunchStart: () => {},
            launchOnce,
            onLaunchFailure: () => {},
        })

        expect(consumedBy).toEqual([2])
    })
})

class AbortBarrierLauncher extends TestLauncher {
    public wire(
        rpc: { registerHandler: (method: string, handler: (params: unknown) => unknown) => void },
        onAbort: () => Promise<void>,
        onEntry?: () => void,
        onRejected?: () => void
    ): void {
        this.setupAbortHandlers(rpc as never, { onAbort, onSwitch: async () => {} }, onEntry, onRejected)
    }
    public barrier(): Promise<void> {
        return this.waitForAbortBarrier()
    }
}

describe('RemoteLauncherBase abort barrier', () => {
    function wired(onAbort: () => Promise<void>) {
        const launcher = new AbortBarrierLauncher()
        const handlers = new Map<string, (params: unknown) => unknown>()
        let controller = new AbortController()
        const restore = vi.fn(() => { if (controller.signal.aborted) controller = new AbortController() })
        launcher.wire({ registerHandler: (method, handler) => { handlers.set(method, handler) } },
            onAbort, () => controller.abort(), restore)
        return { launcher, handlers, restore, signal: () => controller.signal }
    }

    it('restores the dequeue signal and rethrows to the Abort caller when the teardown rejects', async () => {
        const { launcher, handlers, restore, signal } = wired(async () => { throw new Error('cancel failed') })

        await expect(handlers.get(RPC_METHODS.Abort)!({})).rejects.toThrow('cancel failed')

        expect(restore).toHaveBeenCalledTimes(1)
        expect(signal().aborted).toBe(false)
        // The failure is not boxed: the next dequeue is not made to throw.
        await expect(launcher.barrier()).resolves.toBeUndefined()
        // A later Stop still works and is serialized normally.
        await expect(handlers.get(RPC_METHODS.Abort)!({})).rejects.toThrow('cancel failed')
        expect(restore).toHaveBeenCalledTimes(2)
    })

    it('does not restore anything when the teardown succeeds', async () => {
        const { launcher, handlers, restore } = wired(async () => {})

        await handlers.get(RPC_METHODS.Abort)!({})

        expect(restore).not.toHaveBeenCalled()
        await expect(launcher.barrier()).resolves.toBeUndefined()
    })

    it('holds the barrier until the rejected teardown has restored the signal', async () => {
        let rejectTeardown!: () => void
        const { launcher, handlers, signal } = wired(() => new Promise<void>((_resolve, reject) => {
            rejectTeardown = () => reject(new Error('cancel failed'))
        }))

        const stopping = handlers.get(RPC_METHODS.Abort)!({}) as Promise<void>
        const rejection = expect(stopping).rejects.toThrow('cancel failed')
        expect(signal().aborted).toBe(true)
        let passed = false
        const waiting = launcher.barrier().then(() => { passed = true })
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(passed).toBe(false)

        rejectTeardown()
        await rejection
        await waiting
        expect(passed).toBe(true)
        expect(signal().aborted).toBe(false)
    })

    it.each([
        'opencode/opencodeRemoteLauncher.ts',
        'copilot/copilotRemoteLauncher.ts',
        'cursor/cursorAcpRemoteLauncher.ts',
        'cursor/cursorLegacyRemoteLauncher.ts',
        'grok/grokRemoteLauncher.ts',
        'dsh/dshRemoteLauncher.ts',
        'kimi/kimiRemoteLauncher.ts',
    ])('wires the rejected-cancel restore callback in %s', (file) => {
        const source = readFileSync(join(__dirname, '../../..', file), 'utf8')
        const call = source.slice(source.indexOf('this.setupAbortHandlers('))
        const args = call.slice(0, call.indexOf('this.abortController = new AbortController()') + 60)
        expect(args).toContain('() => this.abortController.abort()')
        expect(args).toContain('if (this.abortController.signal.aborted) this.abortController = new AbortController()')
    })
})
