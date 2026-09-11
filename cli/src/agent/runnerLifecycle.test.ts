import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRunnerLifecycle } from './runnerLifecycle';
import type { RunnerLifecycle } from './runnerLifecycle';
import { isTerminalLost, __resetTerminalLossStateForTests } from './terminalLossState';

// Mock heavy deps
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        getLogPath: vi.fn(() => '/tmp/test.log'),
    },
}));

vi.mock('@/ui/terminalState', () => ({
    restoreTerminalState: vi.fn(),
}));

function createMockApiSession() {
    return {
        updateMetadata: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
    } as unknown as Parameters<typeof createRunnerLifecycle>[0]['session'];
}

function createMockApiSessionWithMetadataCapture() {
    const metadataWrites: Array<Record<string, unknown>> = []
    return {
        updateMetadata: vi.fn((handler: (m: Record<string, unknown>) => Record<string, unknown>) => {
            const next = handler({})
            metadataWrites.push(next)
            return next
        }),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        metadataWrites
    } as unknown as Parameters<typeof createRunnerLifecycle>[0]['session'] & {
        metadataWrites: Array<Record<string, unknown>>
    }
}

describe('createRunnerLifecycle', () => {
    let lifecycle: RunnerLifecycle;

    beforeEach(() => {
        vi.clearAllMocks();
        lifecycle = createRunnerLifecycle({
            session: createMockApiSession(),
            logTag: 'test',
        });
    });

    // --- D-9: hasExplicitSessionEndReason ---

    describe('hasExplicitSessionEndReason', () => {
        it('returns false initially', () => {
            expect(lifecycle.hasExplicitSessionEndReason()).toBe(false);
        });

        it('returns true after setSessionEndReason is called', () => {
            lifecycle.setSessionEndReason('completed');
            expect(lifecycle.hasExplicitSessionEndReason()).toBe(true);
        });

        it('returns false after markCrash — markCrash does NOT set explicit flag', () => {
            lifecycle.markCrash(new Error('boom'));
            expect(lifecycle.hasExplicitSessionEndReason()).toBe(false);
        });

        it('stays true once set — subsequent markCrash does not clear it', () => {
            lifecycle.setSessionEndReason('handoff');
            lifecycle.markCrash(new Error('late crash'));
            expect(lifecycle.hasExplicitSessionEndReason()).toBe(true);
        });
    });

    // --- markCrash sets reason to 'error' but not explicit ---

    describe('markCrash', () => {
        it('sets sessionEndReason to error via sendSessionDeath during cleanup', async () => {
            const session = createMockApiSession();
            const lc = createRunnerLifecycle({ session, logTag: 'test' });
            lc.markCrash(new Error('fatal'));

            // cleanup triggers sendSessionDeath — verify 'error' reason
            await lc.cleanup();
            expect(session.sendSessionDeath).toHaveBeenCalledWith('error');
        });
    });

    // --- setSessionEndReason + cleanup propagates correct reason ---

    describe('setSessionEndReason + cleanup', () => {
        it('sends explicit reason via sendSessionDeath during cleanup', async () => {
            const session = createMockApiSession();
            const lc = createRunnerLifecycle({ session, logTag: 'test' });
            lc.setSessionEndReason('completed');

            await lc.cleanup();
            expect(session.sendSessionDeath).toHaveBeenCalledWith('completed');
        });

        it('limits the final connected flush budget to one second', async () => {
            const session = createMockApiSession();
            const lc = createRunnerLifecycle({ session, logTag: 'test' });

            await lc.cleanup();

            expect(session.flush).toHaveBeenCalledWith({ timeoutMs: 1_000 });
        });

        it('keeps the socket open when confirmed cleanup times out and closes only after a retry is acknowledged', async () => {
            const session = createMockApiSession();
            session.flush = vi.fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            const lc = createRunnerLifecycle({ session, logTag: 'test' });
            lc.setArchiveReason('Cleared by /clear');
            lc.setSessionEndReason('cleared');

            await expect(lc.cleanupConfirmed({ timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
            expect(session.close).not.toHaveBeenCalled();

            await expect(lc.cleanupConfirmed({ timeoutMs: 5_000 })).resolves.toBeUndefined();
            expect(session.updateMetadata).toHaveBeenCalledTimes(1);
            expect(session.sendSessionDeath).toHaveBeenCalledTimes(1);
            expect(session.close).toHaveBeenCalledTimes(1);
        });
    });
});

// tiann/hapi#914: the runnerLifecycle's default archiveReason is now
// 'Hub restart' (was 'User terminated'). Out-of-band SIGTERM from the
// hub-restart cascade keeps that default. Explicit user actions
// (clicking Archive in the web UI, Ctrl-C in a local terminal,
// uncaught exception) reassign the reason before archive metadata is
// written.
describe('createRunnerLifecycle archiveReason defaults (tiann/hapi#914)', () => {
    it('uses Hub restart as the default archiveReason when no override is applied', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({
            session,
            logTag: 'test'
        })

        await lifecycle.cleanup()

        expect(session.metadataWrites).toHaveLength(1)
        expect(session.metadataWrites[0]).toMatchObject({
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'Hub restart'
        })
    })

    it('writes the operator-supplied reason when setArchiveReason is called (e.g. KillSession RPC)', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({
            session,
            logTag: 'test'
        })

        lifecycle.setArchiveReason('User terminated')
        await lifecycle.cleanup()

        expect(session.metadataWrites[0]).toMatchObject({
            archiveReason: 'User terminated'
        })
    })

    it('markCrash overrides the default reason to "Session crashed"', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({
            session,
            logTag: 'test'
        })

        lifecycle.markCrash(new Error('boom'))
        await lifecycle.cleanup()

        expect(session.metadataWrites[0]).toMatchObject({
            archiveReason: 'Session crashed'
        })
    })

    // tiann/hapi#914 review round 4: clean agent-loop completions
    // (runClaude / runCodex / runCursor / runGemini / runKimi /
    // runOpencode all call setSessionEndReason('completed') without
    // touching archiveReason) must not be archived as 'Hub restart'.
    // The setSessionEndReason setter flips the default when the runner
    // transitions to 'completed'.
    it('setSessionEndReason("completed") flips the default reason to "Session completed"', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({
            session,
            logTag: 'test'
        })

        lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanup()

        expect(session.metadataWrites[0]).toMatchObject({
            archiveReason: 'Session completed'
        })
    })

    it('an explicit setArchiveReason before setSessionEndReason("completed") still wins', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({
            session,
            logTag: 'test'
        })

        lifecycle.setArchiveReason('User terminated')
        lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanup()

        expect(session.metadataWrites[0]).toMatchObject({
            archiveReason: 'User terminated'
        })
    })
})

// SIGHUP no longer falls through to the default OS behaviour
// (process death). It marks terminalLost and — unless the escape hatch is
// set — keeps the process (and session) alive.
describe('createRunnerLifecycle SIGHUP handling (session survival)', () => {
    const originalHangupEnv = process.env.HAPI_EXIT_ON_HANGUP
    // Track only the SIGHUP listeners this suite adds via
    // registerProcessHandlers() and remove exactly those in afterEach —
    // `process.removeAllListeners('SIGHUP')` would also strip any handler
    // the test host (vitest/bun) itself registered on this shared,
    // process-global emitter.
    let listenersBeforeTest: Array<(...args: unknown[]) => void> = []

    beforeEach(() => {
        __resetTerminalLossStateForTests()
        delete process.env.HAPI_EXIT_ON_HANGUP
        listenersBeforeTest = process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>
    })

    afterEach(() => {
        const listenersAfterTest = process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>
        for (const listener of listenersAfterTest) {
            if (!listenersBeforeTest.includes(listener)) {
                process.removeListener('SIGHUP', listener)
            }
        }
        __resetTerminalLossStateForTests()
        if (originalHangupEnv === undefined) {
            delete process.env.HAPI_EXIT_ON_HANGUP
        } else {
            process.env.HAPI_EXIT_ON_HANGUP = originalHangupEnv
        }
    })

    it('marks terminalLost on SIGHUP instead of exiting', () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })
        lifecycle.registerProcessHandlers({ surviveTerminalHangup: true })

        expect(isTerminalLost()).toBe(false)
        process.emit('SIGHUP')

        expect(isTerminalLost()).toBe(true)
        expect(session.close).not.toHaveBeenCalled()
        expect(session.sendSessionDeath).not.toHaveBeenCalled()
    })

    it('does not archive/close the session on plain SIGHUP', async () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })
        lifecycle.registerProcessHandlers({ surviveTerminalHangup: true })

        process.emit('SIGHUP')
        // give any (incorrectly) fired async cleanup a tick to run
        await Promise.resolve()

        expect(session.updateMetadata).not.toHaveBeenCalled()
    })

    it('HAPI_EXIT_ON_HANGUP=1 makes SIGHUP archive gracefully and exit', async () => {
        process.env.HAPI_EXIT_ON_HANGUP = '1'
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })
        lifecycle.registerProcessHandlers({ surviveTerminalHangup: true })

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit)

        process.emit('SIGHUP')
        // cleanupAndExit is async (fire-and-forget from the handler)
        await new Promise((resolve) => setImmediate(resolve))

        expect(session.metadataWrites[0]).toMatchObject({
            lifecycleState: 'archived',
            archivedBy: 'cli'
        })
        expect(session.metadataWrites[0].archiveReason).toEqual(expect.stringContaining('SIGHUP'))
        expect(session.sendSessionDeath).toHaveBeenCalled()
        expect(session.close).toHaveBeenCalled()
        expect(exitSpy).toHaveBeenCalled()

        exitSpy.mockRestore()
    })
})

// SIGHUP survival must be opt-in, not a blanket behaviour change for every
// runner flavor. Only a runner that explicitly asks for it
// (registerProcessHandlers({ surviveTerminalHangup: true })) should get a
// SIGHUP listener at all; every other flavor must keep the platform default
// (SIGHUP terminates the process) so an un-opted-in runner is not silently
// left "surviving" a signal nobody asked it to survive.
describe('createRunnerLifecycle SIGHUP opt-in gating', () => {
    let listenersBeforeTest: Array<(...args: unknown[]) => void> = []

    beforeEach(() => {
        __resetTerminalLossStateForTests()
        listenersBeforeTest = process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>
    })

    afterEach(() => {
        const listenersAfterTest = process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>
        for (const listener of listenersAfterTest) {
            if (!listenersBeforeTest.includes(listener)) {
                process.removeListener('SIGHUP', listener)
            }
        }
        __resetTerminalLossStateForTests()
    })

    it('does not register a SIGHUP listener when registerProcessHandlers() is called with no options', () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })

        lifecycle.registerProcessHandlers()

        const addedListeners = (process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>)
            .filter((listener) => !listenersBeforeTest.includes(listener))
        expect(addedListeners).toHaveLength(0)
    })

    it('does not register a SIGHUP listener when surviveTerminalHangup is explicitly false', () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })

        lifecycle.registerProcessHandlers({ surviveTerminalHangup: false })

        const addedListeners = (process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>)
            .filter((listener) => !listenersBeforeTest.includes(listener))
        expect(addedListeners).toHaveLength(0)
    })

    it('registers a SIGHUP listener when surviveTerminalHangup is true', () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })

        lifecycle.registerProcessHandlers({ surviveTerminalHangup: true })

        const addedListeners = (process.listeners('SIGHUP') as Array<(...args: unknown[]) => void>)
            .filter((listener) => !listenersBeforeTest.includes(listener))
        expect(addedListeners.length).toBeGreaterThan(0)
    })

    it('an un-opted-in runner keeps the platform default: SIGHUP does not mark terminalLost', () => {
        const session = createMockApiSessionWithMetadataCapture()
        const lifecycle = createRunnerLifecycle({ session, logTag: 'test' })
        lifecycle.registerProcessHandlers()

        // Emitting the signal on this process only proves whatever listeners
        // (if any) run — it cannot prove the kernel would actually terminate
        // an un-opted-in process for real. That is covered by the separate
        // real-process suite (runnerLifecycle.process.test.ts) using a
        // sibling fixture without the opt-in. This test only asserts that no
        // handler of ours reacts, i.e. we didn't register anything.
        process.emit('SIGHUP')

        expect(isTerminalLost()).toBe(false)
    })
})
