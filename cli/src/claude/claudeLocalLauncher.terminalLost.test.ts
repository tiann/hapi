import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@/api/types'
import { markTerminalLost, __resetTerminalLossStateForTests } from '@/agent/terminalLossState'

// Once the terminal is lost (SIGHUP), the local child's exit-handling path
// needs to treat abnormal death as a trigger for switching to remote mode —
// while still distinguishing the death cause: a SIGHUP-correlated death
// should switch, but the user exiting claude normally (e.g. /exit) should
// still end the session. This suite exercises the real BaseLocalLauncher
// (not mocked) so the exit-reason contract itself is covered, not just that
// claudeLocalLauncher calls some mock.
//
// Judgment rule: terminalLost already being set AT THE MOMENT the local
// child exits is the sole signal for
// "switch to remote" — independent of exit code/signal. A real claude child
// can exit gracefully (code=0, no signal) when its PTY disappears, so "clean
// resolve = user typed /exit" is not a safe inference once the terminal is
// known gone. Only when terminalLost is NOT set does a clean exit mean a
// genuine user /exit.

const harness = vi.hoisted(() => ({
    claudeLocalImpl: async (_opts: Record<string, unknown>): Promise<void> => {}
}))

vi.mock('./claudeLocal', () => ({
    claudeLocal: (opts: Record<string, unknown>) => harness.claudeLocalImpl(opts)
}))

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: async () => ({
        cleanup: async () => {},
        onNewSession: () => {}
    })
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() }
}))

import { claudeLocalLauncher } from './claudeLocalLauncher'

function createSessionStub(overrides?: { startedBy?: 'terminal' | 'runner'; startingMode?: 'local' | 'remote' }) {
    let metadata: Metadata = { path: '/tmp/test', host: 'localhost' }
    return {
        sessionId: 'test-session',
        path: '/tmp/test',
        startedBy: overrides?.startedBy ?? 'terminal',
        startingMode: overrides?.startingMode ?? 'local',
        claudeEnvVars: {},
        claudeArgs: [] as string[],
        getModel: () => undefined,
        mcpServers: {},
        allowedTools: [],
        hookSettingsPath: 'settings.json',
        localHookSettingsPath: 'settings.json',
        queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
        client: {
            sendClaudeSessionMessage: () => {},
            sendSessionEvent: () => {},
            updateMetadata: (handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            },
            rpcHandlerManager: { registerHandler: () => {} }
        },
        addSessionFoundCallback: () => {},
        removeSessionFoundCallback: () => {},
        consumeOneTimeFlags: vi.fn(),
        recordLocalLaunchFailure: vi.fn()
    }
}

describe('claudeLocalLauncher terminal-loss local→remote switch', () => {
    beforeEach(() => {
        __resetTerminalLossStateForTests()
    })

    afterEach(() => {
        __resetTerminalLossStateForTests()
    })

    it('a plain terminal-started local session still ends the session on normal claude exit (baseline, unaffected)', async () => {
        harness.claudeLocalImpl = async () => {}
        const session = createSessionStub()

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('exit')
    })

    it('abnormal local-child death after terminalLost switches to remote instead of ending the session', async () => {
        markTerminalLost()
        harness.claudeLocalImpl = async () => {
            throw new Error('Process terminated with signal: SIGHUP')
        }
        const session = createSessionStub()

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('switch')
        // Not surfaced as a launch failure — this is a controlled handoff,
        // not a crash.
        expect(session.recordLocalLaunchFailure).not.toHaveBeenCalled()
        // A terminal-loss switch must consume one-time flags exactly like
        // any other local→remote switch (RPC-triggered doSwitch, or a
        // queued message triggering doSwitch in BaseLocalLauncher) — those
        // paths call session.consumeOneTimeFlags() unconditionally once the
        // in-flight launch resolves. Skipping it only for the terminal-loss
        // path would leave one-time flags (most importantly --fork-session)
        // still armed, so the remote relaunch this switch leads into could
        // re-consume them and re-fork a session that was already forked.
        expect(session.consumeOneTimeFlags).toHaveBeenCalled()
    })

    it('abnormal local-child death after terminalLost switches even for a plain terminal/local session (would otherwise "exit")', async () => {
        markTerminalLost()
        harness.claudeLocalImpl = async () => {
            throw new Error('Process exited with code: 1')
        }
        const session = createSessionStub({ startedBy: 'terminal', startingMode: 'local' })

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('switch')
    })

    it('terminalLost + a clean code=0 child exit switches to remote, does not end the session', async () => {
        // Actual claude reacts to the PTY going away by exiting gracefully
        // with code=0/signal=null (not a signal kill) — so claudeLocal()
        // resolves without throwing, same shape as a real `/exit`. Once
        // terminalLost is set, the terminal is gone and no user could have
        // typed /exit, so ANY child exit at that point — clean resolve or
        // thrown signal/non-zero — must be read as "terminal died out from
        // under the child" and redirected to remote, never as session end.
        // A same-tick race (user types /exit right as the terminal dies) is
        // resolved in favor of the safer side: keep the session alive.
        markTerminalLost()
        harness.claudeLocalImpl = async () => {}
        const session = createSessionStub()

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('switch')
        // Same invariant as the abnormal-death case above: this switch must
        // consume one-time flags exactly like any other local→remote
        // switch, or the remote relaunch could re-consume them.
        expect(session.consumeOneTimeFlags).toHaveBeenCalled()
        expect(session.recordLocalLaunchFailure).not.toHaveBeenCalled()
    })

    it('without terminalLost, an abnormal local-child death for a terminal/local session still ends the session (unrelated crash)', async () => {
        harness.claudeLocalImpl = async () => {
            throw new Error('Process terminated with signal: SIGKILL')
        }
        const session = createSessionStub({ startedBy: 'terminal', startingMode: 'local' })

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('exit')
        expect(session.recordLocalLaunchFailure).toHaveBeenCalled()
    })

    it('without terminalLost, a runner-started session still switches on abnormal death (pre-existing behavior preserved)', async () => {
        harness.claudeLocalImpl = async () => {
            throw new Error('Process terminated with signal: SIGTERM')
        }
        const session = createSessionStub({ startedBy: 'runner', startingMode: 'remote' })

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('switch')
    })

    it('a terminal-loss switch consumes --fork-session so the remote relaunch does not re-fork', async () => {
        // Regression guard against "consumeOneTimeFlags is skipped on
        // terminal-loss switch" coming back: if that flag survives the switch,
        // the remote relaunch that follows would see --fork-session still
        // present in claudeArgs and branch off the already-forked native
        // session id a second time.
        markTerminalLost()
        harness.claudeLocalImpl = async () => {
            throw new Error('Process terminated with signal: SIGHUP')
        }
        const session = createSessionStub()
        session.claudeArgs = ['--fork-session']
        session.consumeOneTimeFlags = vi.fn(() => {
            session.claudeArgs = session.claudeArgs.filter((arg: string) => arg !== '--fork-session')
        })

        const result = await claudeLocalLauncher(session as never)

        expect(result).toBe('switch')
        expect(session.consumeOneTimeFlags).toHaveBeenCalled()
        expect(session.claudeArgs).not.toContain('--fork-session')
    })
})
