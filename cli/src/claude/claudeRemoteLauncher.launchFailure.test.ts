import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';
import type { EnhancedMode } from './loop';

// claudeRemote() wraps the actual Claude Agent SDK subprocess spawn (the
// external-process boundary for this launcher) -- mock it the same way
// cursorLegacyRemoteLauncher.test.ts mocks `spawn`, rather than mocking any
// internal collaborator.
const claudeRemoteMock = vi.fn();

vi.mock('./claudeRemote', () => ({
    claudeRemote: (opts: unknown) => claudeRemoteMock(opts)
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

function makeClient() {
    const handlers = new Map<string, RpcHandler>();
    let agentState: Record<string, unknown> = {};
    return {
        handlers,
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RpcHandler) => {
                handlers.set(method, handler);
            })
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn((handler: (state: any) => any) => {
            agentState = handler(agentState);
        }),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
}

function makeSession(queue: MessageQueue2<EnhancedMode>, client: ReturnType<typeof makeClient>): Session {
    return new Session({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hooks.json'
    });
}

// Fires the RPC handler registered for `switch` (mirrors a UI-triggered
// switch-to-local request). ClaudeRemoteLauncher.requestExit() sets
// `exitReason` synchronously before awaiting the abort, so calling this
// without awaiting it lets a test deterministically terminate the launcher's
// respawn loop from inside a claudeRemote() mock implementation.
function triggerSwitch(client: ReturnType<typeof makeClient>): void {
    const handler = client.handlers.get(RPC_METHODS.Switch);
    void handler?.(undefined);
}

// True once the launcher has sent the "give up on this message, drop it"
// banner (i.e. the immediate-failure cap fired at least once). Used as an
// *outcome-based* stop condition below, instead of a hardcoded call number --
// if a mutation changes when/whether the cap fires, the number of mock
// invocations before this becomes true changes too, so tests asserting an
// exact call count actually fail under that mutation rather than happening to
// reach the same hardcoded checkpoint regardless of production behavior.
function hasDropBanner(client: ReturnType<typeof makeClient>): boolean {
    return client.sendSessionEvent.mock.calls.some(
        ([event]: any[]) => typeof event?.message === 'string' && event.message.includes('Dropping the queued message')
    );
}

describe('claudeRemoteLauncher launch-failure recovery', () => {
    beforeEach(() => {
        claudeRemoteMock.mockReset();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
        process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = '0';
    });

    afterEach(() => {
        delete process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS;
    });

    it('restores the dequeued message into the queue when claudeRemote throws before onReady', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('hello', { permissionMode: 'default' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        let queueSizeOnSecondAttempt: number | undefined;
        let restoredMessageText: string | undefined;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;
            if (callCount === 1) {
                const msg = await opts.nextMessage();
                expect(msg?.message).toBe('hello');
                throw new Error('spawn failed');
            }

            // Second attempt: inspect queue state directly rather than
            // dequeuing again -- calling nextMessage() here would hang
            // forever under the pre-fix behavior, where the message was
            // silently dropped and nothing will ever push a new one.
            queueSizeOnSecondAttempt = session.queue.size();
            restoredMessageText = session.queue.queue[0]?.message;
            triggerSwitch(client);
            throw new Error('spawn failed again');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        expect(callCount).toBe(2);
        // The message that was already dequeued+acked on attempt 1 must be
        // restored to the queue before attempt 2, not silently dropped.
        expect(queueSizeOnSecondAttempt).toBe(1);
        expect(restoredMessageText).toBe('hello');
    });

    it('restores a joined batch as separate items with each original localId and order preserved', async () => {
        // MessageQueue2.collectBatch() joins same-mode messages into a single
        // `message` string for the SDK (`sameModeMessages.join('\n')`), but
        // still tracks each original item's localId for the ack it fires.
        // Restoring the joined string as one new queue item would silently
        // drop both original localIds, orphaning the retried prompt from its
        // hub row (and from cancel-by-localId). The restore must unshift each
        // original item individually, in reverse order, so the queue ends up
        // with the same two items in the same order with their own localIds
        // intact.
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('first', { permissionMode: 'default' }, 'local-id-1');
        queue.push('second', { permissionMode: 'default' }, 'local-id-2');

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        let queueItemsOnSecondAttempt: Array<{ message: string; localId: string | undefined }> | undefined;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;
            if (callCount === 1) {
                const msg = await opts.nextMessage();
                // Joined for the SDK, as before -- this part of the contract
                // does not change.
                expect(msg?.message).toBe('first\nsecond');
                throw new Error('spawn failed');
            }

            queueItemsOnSecondAttempt = session.queue.queue.map((item) => ({
                message: item.message,
                localId: item.localId
            }));
            triggerSwitch(client);
            throw new Error('spawn failed again');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        expect(callCount).toBe(2);
        expect(queueItemsOnSecondAttempt).toEqual([
            { message: 'first', localId: 'local-id-1' },
            { message: 'second', localId: 'local-id-2' }
        ]);
    });

    it('applies backoff between immediate failures and drops the message after repeated immediate failures instead of spinning forever', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        const client = makeClient();
        const session = makeSession(queue, client);

        const BACKOFF_MS = 50;
        process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = String(BACKOFF_MS);

        let callCount = 0;
        const SAFETY_CUTOFF = 20;

        claudeRemoteMock.mockImplementation(async () => {
            callCount += 1;
            if (hasDropBanner(client) || callCount > SAFETY_CUTOFF) {
                // Outcome-based stop: the cap already fired on a previous
                // attempt (proven by the drop banner), or the safety valve
                // tripped because it never did.
                triggerSwitch(client);
            }
            throw new Error('deterministic launch failure');
        });

        const start = Date.now();
        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);
        const elapsed = Date.now() - start;

        // 3 consecutive immediate failures hit the cap and drop the message
        // on call 3 (2 backoff waits happen first, between calls 1->2 and
        // 2->3; the cap-triggered drop on call 3 does not itself back off).
        // Call 4 observes the drop banner and ends the test. This is an
        // exact count, not a loose upper bound -- if the cap value or the
        // reachedReadyThisAttempt gating regresses, this number changes.
        expect(callCount).toBe(4);
        expect(elapsed).toBeGreaterThanOrEqual(2 * BACKOFF_MS);
        expect(elapsed).toBeLessThan(5_000);

        const messages = client.sendSessionEvent.mock.calls.map(([event]: any[]) => event);
        const dropBanner = messages.find(
            (event: any) => typeof event.message === 'string' && event.message.includes('Dropping the queued message')
        );
        expect(dropBanner).toBeDefined();
        expect(dropBanner!.message).toContain('3 times in a row');
    });

    it('resets the immediate-failure streak once onReady fires even if that same attempt later throws', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        const SAFETY_CUTOFF = 20;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;

            if (hasDropBanner(client) || callCount > SAFETY_CUTOFF) {
                triggerSwitch(client);
                throw new Error('ending test');
            }

            if (callCount === 1) {
                // Immediate failure, never reaches ready.
                throw new Error('first attempt failure');
            }
            if (callCount === 2) {
                // Reaches onReady this attempt (a real turn happened), then
                // still throws -- this must reset the immediate-failure
                // streak, because the failure is no longer "immediate".
                opts.onReady();
                throw new Error('second attempt failure post-ready');
            }

            // A brand new streak of deterministic immediate failures begins
            // here. If call 2's reset did not happen, the streak would
            // already be at 2 after call 2 and the cap would fire one call
            // sooner.
            throw new Error('post-reset streak failure');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        // call 1 = 1 immediate failure (streak -> 1)
        // call 2 = reaches onReady, then throws -> streak resets to 0 (NOT
        //   counted as an immediate failure despite throwing)
        // calls 3-5 = a fresh streak of 3 immediate failures -> cap fires on
        //   call 5, drop banner sent
        // call 6 = observes the drop banner and ends the test
        // This is an exact count: if the reset in call 2 did not happen, the
        // cap would fire on call 4 instead (5 total calls, not 6).
        expect(callCount).toBe(6);
    });

    it('resets the immediate-failure streak on a successful attempt that delivers a message but never reaches onReady', async () => {
        // claudeRemote.ts's /clear handling delivers the queued message to
        // the SDK (a real nextMessage() call, not a no-op park), then calls
        // onSessionReset()/onCompletionEvent() and returns successfully --
        // WITHOUT ever calling onReady(). onReady alone can't tell that apart
        // from a trivial no-op completion (the park-then-return-null case the
        // livelock fix guards against), so the reset must also fire on
        // "a message was actually delivered this attempt", not only on
        // "onReady fired this attempt".
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('/clear', { permissionMode: 'default' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        const SAFETY_CUTOFF = 20;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;

            if (hasDropBanner(client) || callCount > SAFETY_CUTOFF) {
                triggerSwitch(client);
                throw new Error('ending test');
            }

            if (callCount === 1) {
                // Immediate failure, never reaches ready.
                throw new Error('first attempt failure');
            }
            if (callCount === 2) {
                // Immediate failure again -- streak is now 2, one away from
                // the cap.
                throw new Error('second attempt failure');
            }
            if (callCount === 3) {
                // Mirrors claudeRemote.ts's /clear handling: the message is
                // delivered (a real nextMessage() call), then the attempt
                // returns successfully without calling onReady.
                await opts.nextMessage();
                return;
            }

            // A brand new streak of deterministic immediate failures begins
            // here. If call 3's successful /clear did not reset the streak,
            // it would still be at 2 and this single failure would already
            // hit the cap.
            throw new Error('post-clear streak failure');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        // call 1, 2 = 2 immediate failures (streak -> 2)
        // call 3 = delivers /clear, completes successfully without onReady ->
        //   streak resets to 0
        // calls 4-6 = a fresh streak of 3 immediate failures -> cap fires on
        //   call 6, drop banner sent
        // call 7 = observes the drop banner and ends the test
        // This is an exact count: if call 3 did not reset the streak, the cap
        // would fire on call 4 instead (5 total calls, not 7), and the drop
        // banner would falsely claim "3 times in a row" after just 1 failure
        // past the successful /clear.
        expect(callCount).toBe(7);
    });

    it('does not livelock when an isolated message repeatedly hits a deterministic launch failure', async () => {
        // Reproduces the hostile-review probe: an isolated message (e.g.
        // /compact, /clear) that keeps hitting a deterministic launch
        // failure oscillates between two nextMessage() shapes every other
        // attempt -- parked into `pending` (returns null, attempt ends
        // without throwing) vs. handed to the SDK from `pending` (attempt
        // throws). If the immediate-failure streak were reset on every
        // non-throwing attempt (rather than gated on reachedReadyThisAttempt),
        // this oscillation would reset the streak every other attempt and the
        // cap would never fire.
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.pushIsolateAndClear('/compact', { permissionMode: 'default' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        const SAFETY_CUTOFF = 20;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;

            if (hasDropBanner(client) || callCount > SAFETY_CUTOFF) {
                // Outcome-based stop: cap already fired (or the safety valve
                // tripped because it never did) -- stop here instead of
                // hanging on session.queue.waitForMessagesAndGetAsString()
                // blocking forever on the now-empty, non-closed queue.
                triggerSwitch(client);
                throw new Error('ending test');
            }

            // Mirror claudeRemote.ts's real "get initial message" step
            // (`initial = await opts.nextMessage(); if (!initial) return;`)
            // instead of a scripted per-call script, so the actual
            // pending/isolate parking logic in claudeRemoteLauncher.ts's
            // nextMessage() drives the oscillation, exactly as it does live.
            const initial = await opts.nextMessage();
            if (!initial) {
                return;
            }
            throw new Error('deterministic launch failure');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        // Must terminate via the cap+drop path well under the safety cutoff
        // -- if the reset gating regresses, this livelocks the
        // immediate-failure counter at 1<->0 forever and hits the cutoff
        // instead (the probe that found this bug observed 25 attempts with
        // the cap never firing).
        expect(callCount).toBeLessThan(SAFETY_CUTOFF);
        expect(hasDropBanner(client)).toBe(true);
    });
});
