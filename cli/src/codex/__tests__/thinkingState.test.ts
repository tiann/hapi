import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for the Codex thinking state lifecycle.
 *
 * The thinking indicator in the web UI is driven by session.onThinkingChange().
 * For the app-server path, the key contract is:
 *
 * 1. thinking=true BEFORE any network calls (user sends message)
 * 2. thinking stays true while the turn is in flight
 * 3. thinking=false when task_complete/turn_aborted/task_failed arrives
 * 4. thinking=false on abort (handleAbort)
 * 5. The finally block does NOT clear thinking while a turn is in flight
 *
 * Since CodexRemoteLauncher.launch() is deeply integrated, we test the
 * thinking state contract by simulating the event handler behavior.
 */

type ThinkingTracker = {
    thinking: boolean;
    turnInFlight: boolean;
    useAppServer: boolean;
    changes: boolean[]; // history of thinking state changes
};

/**
 * Simulates the thinking state logic from codexRemoteLauncher.ts
 * extracted to be testable in isolation.
 */
function createThinkingTracker(useAppServer: boolean): ThinkingTracker {
    const tracker: ThinkingTracker = {
        thinking: false,
        turnInFlight: false,
        useAppServer,
        changes: [],
    };
    return tracker;
}

function onThinkingChange(tracker: ThinkingTracker, value: boolean) {
    tracker.thinking = value;
    tracker.changes.push(value);
}

/** Simulates: user sends a message (line 839) */
function simulateMessageSent(tracker: ThinkingTracker) {
    onThinkingChange(tracker, true);
}

/** Simulates: startTurn resolves and sets turnInFlight (lines 920/960) */
function simulateStartTurn(tracker: ThinkingTracker) {
    if (tracker.useAppServer) {
        tracker.turnInFlight = true;
    }
}

/** Simulates: task_started event arrives (lines 418-426) */
function simulateTaskStarted(tracker: ThinkingTracker) {
    if (tracker.useAppServer) {
        tracker.turnInFlight = true;
    }
    if (!tracker.thinking) {
        onThinkingChange(tracker, true);
    }
}

/** Simulates: task_complete/turn_aborted/task_failed (lines 427-437) */
function simulateTaskComplete(tracker: ThinkingTracker) {
    if (tracker.useAppServer) {
        tracker.turnInFlight = false;
    }
    if (tracker.thinking) {
        onThinkingChange(tracker, false);
    }
}

/** Simulates: the finally block (lines 1025-1041) */
function simulateFinallyBlock(tracker: ThinkingTracker) {
    if (!tracker.useAppServer || !tracker.turnInFlight) {
        onThinkingChange(tracker, false);
    }
}

/** Simulates: handleAbort (lines 59-88) */
function simulateAbort(tracker: ThinkingTracker) {
    onThinkingChange(tracker, false);
}

/** Simulates: catch block on error (lines 975-1024) */
function simulateCatchBlock(tracker: ThinkingTracker) {
    if (tracker.useAppServer) {
        tracker.turnInFlight = false;
    }
}

describe('Codex thinking state lifecycle', () => {
    describe('app-server path', () => {
        it('sets thinking=true immediately when message is sent', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);

            expect(t.thinking).toBe(true);
            expect(t.changes).toEqual([true]);
        });

        it('keeps thinking=true through finally block while turn is in flight', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            // startTurn resolves immediately, finally block runs
            simulateFinallyBlock(t);

            // thinking should still be true because turnInFlight=true
            expect(t.thinking).toBe(true);
            expect(t.turnInFlight).toBe(true);
        });

        it('clears thinking when task_complete arrives', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            simulateFinallyBlock(t); // no-op for app-server with turnInFlight
            simulateTaskStarted(t);  // event from app-server
            simulateTaskComplete(t); // turn finishes

            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);
        });

        it('clears thinking on abort', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            simulateFinallyBlock(t);
            simulateTaskStarted(t);
            // user hits stop
            simulateAbort(t);

            expect(t.thinking).toBe(false);
        });

        it('clears thinking on turn_aborted event', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            simulateFinallyBlock(t);
            simulateTaskStarted(t);
            simulateTaskComplete(t); // turn_aborted uses same handler

            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);
        });

        it('clears thinking on error via catch + finally', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            // startTurn throws
            simulateCatchBlock(t);   // sets turnInFlight=false
            simulateFinallyBlock(t); // now runs because turnInFlight=false

            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);
        });

        it('thinking=true survives full normal turn lifecycle', () => {
            const t = createThinkingTracker(true);

            // 1. User sends message
            simulateMessageSent(t);
            expect(t.thinking).toBe(true);

            // 2. startTurn resolves, finally block runs
            simulateStartTurn(t);
            simulateFinallyBlock(t);
            expect(t.thinking).toBe(true); // still thinking!

            // 3. Events stream in
            simulateTaskStarted(t);
            expect(t.thinking).toBe(true);

            // 4. Turn completes
            simulateTaskComplete(t);
            expect(t.thinking).toBe(false);
        });
    });

    describe('MCP path', () => {
        it('sets thinking=true on message and false in finally block', () => {
            const t = createThinkingTracker(false);

            simulateMessageSent(t);
            expect(t.thinking).toBe(true);

            // MCP call is blocking, completes before finally
            simulateFinallyBlock(t);
            expect(t.thinking).toBe(false);
        });

        it('finally block always runs for MCP path regardless of turnInFlight', () => {
            const t = createThinkingTracker(false);
            t.turnInFlight = true; // shouldn't matter for MCP

            simulateMessageSent(t);
            simulateFinallyBlock(t);

            expect(t.thinking).toBe(false);
        });
    });
});
