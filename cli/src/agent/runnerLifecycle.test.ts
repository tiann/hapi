import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRunnerLifecycle } from './runnerLifecycle';
import type { RunnerLifecycle } from './runnerLifecycle';

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
        const session = makeFakeSession()
        const lifecycle = createRunnerLifecycle({
            session: session as unknown as Parameters<typeof createRunnerLifecycle>[0]['session'],
            logTag: 'test'
        })

        lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanup()

        expect(session.metadataWrites[0]).toMatchObject({
            archiveReason: 'Session completed'
        })
    })

    it('an explicit setArchiveReason before setSessionEndReason("completed") still wins', async () => {
        const session = makeFakeSession()
        const lifecycle = createRunnerLifecycle({
            session: session as unknown as Parameters<typeof createRunnerLifecycle>[0]['session'],
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
