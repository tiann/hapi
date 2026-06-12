import { describe, expect, it, vi } from 'vitest'
import { runLocalRemoteLoop, type LoopLauncher, type SessionMode } from '../loopBase'

// runLocalRemoteLoop only ever touches session.onModeChange, so a minimal fake
// session suffices.
function fakeSession() {
    return { onModeChange: vi.fn() }
}

type Reason = 'switch' | 'exit'

function launcher(...reasons: Reason[]): LoopLauncher<ReturnType<typeof fakeSession>> {
    let i = 0
    return vi.fn(async () => reasons[Math.min(i++, reasons.length - 1)])
}

async function run(opts: {
    startingMode?: SessionMode
    runLocal: LoopLauncher<ReturnType<typeof fakeSession>>
    runRemote: LoopLauncher<ReturnType<typeof fakeSession>>
    runPty?: LoopLauncher<ReturnType<typeof fakeSession>>
}) {
    const session = fakeSession()
    await runLocalRemoteLoop({
        session: session as never,
        startingMode: opts.startingMode,
        logTag: 'test',
        runLocal: opts.runLocal,
        runRemote: opts.runRemote,
        runPty: opts.runPty,
    })
    return session
}

describe('runLocalRemoteLoop mode selection', () => {
    it('a non-PTY session hands off local→SDK remote even when a runPty launcher is registered', async () => {
        // The regression: claude always registers runPty, so a normal local
        // session pressing space must still reach the SDK remote launcher, not
        // PTY (which is opt-in).
        const runLocal = launcher('switch')
        const runRemote = launcher('exit')
        const runPty = launcher('exit')

        const session = await run({ startingMode: 'local', runLocal, runRemote, runPty })

        expect(runRemote).toHaveBeenCalledTimes(1)
        expect(runPty).not.toHaveBeenCalled()
        // The external mode reported is 'remote'.
        expect(session.onModeChange).toHaveBeenCalledWith('remote')
    })

    it('defaults (no startingMode) behave as a local→remote session', async () => {
        const runLocal = launcher('switch')
        const runRemote = launcher('exit')
        const runPty = launcher('exit')

        await run({ runLocal, runRemote, runPty })

        expect(runRemote).toHaveBeenCalledTimes(1)
        expect(runPty).not.toHaveBeenCalled()
    })

    it('a PTY session toggles local↔pty and never uses the SDK remote launcher', async () => {
        // pty → (switch) local → (switch) pty → (exit)
        const runPty = launcher('switch', 'exit')
        const runLocal = launcher('switch')
        const runRemote = launcher('exit')

        const session = await run({ startingMode: 'pty', runLocal, runRemote, runPty })

        expect(runPty).toHaveBeenCalledTimes(2)
        expect(runRemote).not.toHaveBeenCalled()
        // PTY is reported to the hub/UI as 'remote'.
        expect(session.onModeChange).toHaveBeenCalledWith('remote')
    })
})
