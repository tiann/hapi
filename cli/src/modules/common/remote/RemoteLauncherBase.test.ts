import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { RemoteLauncherBase, type LaunchOutcome } from './RemoteLauncherBase'
import { markTerminalLost, __resetTerminalLossStateForTests } from '@/agent/terminalLossState'

const inkHarness = vi.hoisted(() => ({ renderCalls: 0 }))

vi.mock('ink', () => ({
    render: vi.fn(() => {
        inkHarness.renderCalls++
        return { unmount: () => {} }
    })
}))

vi.mock('@/ui/terminalState', () => ({
    restoreTerminalState: vi.fn()
}))

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

    public getHasTTY(): boolean {
        return this.hasTTY
    }
    public runSetupTerminal(handlers: Parameters<RemoteLauncherBase['setupTerminal']>[0]): void {
        this.setupTerminal(handlers)
    }
    public runFinalizeTerminal(): void {
        this.finalizeTerminal()
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

// Once the controlling terminal is gone (terminalLost, set by the SIGHUP
// handler), a RemoteLauncherBase
// entered afterwards must not act as if it still owns a TTY — even though
// process.stdout.isTTY / process.stdin.isTTY on the (now slave-side-dead)
// fd can still read `true` at this point. ClaudeRemoteLauncher constructs a
// fresh launcher on every local→remote switch, so this is exactly the path
// hit by the SIGHUP-triggered switch.
describe('RemoteLauncherBase TTY gating after terminal loss', () => {
    const originalStdoutIsTTY = process.stdout.isTTY
    const originalStdinIsTTY = process.stdin.isTTY
    const originalSetRawMode = (process.stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode

    afterEach(() => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY })
        if (originalSetRawMode) {
            Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: originalSetRawMode })
        } else {
            delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode
        }
        vi.restoreAllMocks()
        inkHarness.renderCalls = 0
    })

    it('still treats a live terminal as hasTTY when terminalLost is not set (baseline)', () => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })

        const launcher = new TestLauncher()

        expect(launcher.getHasTTY()).toBe(true)
    })

    it('reports hasTTY=false once terminalLost is set, even though the fd still reads isTTY=true', () => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        markTerminalLost()

        const launcher = new TestLauncher()

        expect(launcher.getHasTTY()).toBe(false)
    })

    it('setupTerminal() does not clear the screen, render ink, or touch stdin raw mode once terminalLost is set', () => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        const setRawModeStub = vi.fn()
        Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawModeStub })
        const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin)
        const clearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {})
        markTerminalLost()

        const launcher = new TestLauncher()
        launcher.runSetupTerminal({ onExit: async () => {}, onSwitchToLocal: async () => {} })

        expect(clearSpy).not.toHaveBeenCalled()
        expect(inkHarness.renderCalls).toBe(0)
        expect(resumeSpy).not.toHaveBeenCalled()
        expect(setRawModeStub).not.toHaveBeenCalled()
    })

    it('finalizeTerminal() does not pause stdin once terminalLost is set (no live terminal to restore)', () => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        const pauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin)
        markTerminalLost()

        const launcher = new TestLauncher()
        launcher.runFinalizeTerminal()

        expect(pauseSpy).not.toHaveBeenCalled()
    })

    // The two tests above only cover terminalLost being set BEFORE the
    // launcher is constructed. In production a launcher instance is
    // long-lived across the SIGHUP event: it is constructed while the
    // terminal is still alive, and only later — mid-lifetime, from the
    // SIGHUP handler — does the terminal go away. If hasTTY is computed
    // once in the constructor and never revisited, a launcher built before
    // SIGHUP keeps acting as if it still has a live terminal for the rest
    // of its life, even after markTerminalLost() flips.
    it('short-circuits console.clear/ink render/setRawMode once terminalLost flips AFTER construction (hasTTY must be re-evaluated live, not cached at construction time)', () => {
        __resetTerminalLossStateForTests()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        const setRawModeStub = vi.fn()
        Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawModeStub })
        const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin)
        const clearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {})

        // Constructed while the terminal is still alive.
        const launcher = new TestLauncher()
        expect(launcher.getHasTTY()).toBe(true)

        // The terminal disappears sometime later, mid-lifetime — this is
        // what the SIGHUP handler does to an already-running launcher.
        markTerminalLost()

        launcher.runSetupTerminal({ onExit: async () => {}, onSwitchToLocal: async () => {} })

        expect(clearSpy).not.toHaveBeenCalled()
        expect(inkHarness.renderCalls).toBe(0)
        expect(resumeSpy).not.toHaveBeenCalled()
        expect(setRawModeStub).not.toHaveBeenCalled()
    })
})
