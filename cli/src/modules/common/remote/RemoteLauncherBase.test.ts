import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
