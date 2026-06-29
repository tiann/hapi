import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring test for the launch retry loop in claudeRemoteLauncher (design §4.3,
 * AC4). The two predicates are unit-tested in utils/claudeResumeError.test.ts;
 * this exercises how the launcher acts on them inside runMainLoop:
 *   - unrecoverable error  -> stop immediately (no retry, exit)
 *   - recoverable error    -> retry up to MAX_LAUNCH_RETRIES, then stop
 *   - clean run after fails -> retry budget resets
 * This is the regression guard for the original "infinite respawn" bug.
 */

const harness = vi.hoisted(() => ({
    // Each entry is a behavior for the Nth claudeRemote() call.
    behaviors: [] as Array<() => Promise<void>>,
    callIndex: 0
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: async () => {
        const behavior = harness.behaviors[harness.callIndex] ?? (async () => {});
        harness.callIndex += 1;
        await behavior();
    }
}));

// Inner collaborators of runMainLoop that we do not exercise here. Mock them
// to no-ops so the test stays focused on the catch/retry branch.
vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} });
        isAborted = () => false;
        setOnPermissionRequest = () => {};
        getResponses = () => new Map();
        onMessage = () => {};
        reset = () => {};
        handleModeChange = () => {};
    }
}));

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        constructor(_send: unknown) {}
        enqueue = () => {};
        releaseToolCall = async () => {};
        flush = async () => {};
        destroy = () => {};
    }
}));

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        constructor(_meta: unknown, _responses: unknown) {}
        updateSessionId = () => {};
        resetParentChain = () => {};
        convert = () => null;
        convertSidechainUserMessage = () => null;
        generateInterruptedToolResult = () => null;
    }
}));

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({
    RemoteModeDisplay: () => null
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';

type SessionEvent = { type: string; message?: string };

function createSessionStub() {
    const events: SessionEvent[] = [];
    // waitForMessagesAndGetAsString is only reached on a *clean* claudeRemote
    // return (the loop awaits the next user message). Returning null ends the
    // session, so a clean run terminates the loop deterministically.
    const session = {
        sessionId: 'sess-1',
        path: '/tmp/test',
        allowedTools: [],
        mcpServers: {},
        hookSettingsPath: '/tmp/hook.json',
        claudeEnvVars: {},
        claudeArgs: [],
        logPath: '/tmp/test.log',
        onThinkingChange: () => {},
        queue: {
            size: () => 0,
            waitForMessagesAndGetAsString: async () => null
        },
        client: {
            rpcHandlerManager: { registerHandler: () => {} },
            sendClaudeSessionMessage: () => {},
            sendSessionEvent: (event: SessionEvent) => { events.push(event); }
        },
        addSessionFoundCallback: () => {},
        removeSessionFoundCallback: () => {},
        consumeOneTimeFlags: () => {},
        onSessionFound: () => {},
        clearSessionId: () => {}
    };
    return { session, events };
}

function messages(events: SessionEvent[]): string[] {
    return events.filter(e => e.type === 'message').map(e => e.message ?? '');
}

afterEach(() => {
    harness.behaviors = [];
    harness.callIndex = 0;
    vi.clearAllMocks();
});

describe('claudeRemoteLauncher launch retry wiring', () => {
    it('stops immediately on an unrecoverable resume error (no retry)', async () => {
        harness.behaviors = [
            async () => {
                throw new Error(
                    'Session sess-1 is currently running as a background agent (bg). ' +
                    'Use claude agents to find and attach to it, or add --fork-session to branch off a copy.'
                );
            }
        ];
        const { session, events } = createSessionStub();

        const exitReason = await claudeRemoteLauncher(session as never);

        // Exactly one attempt: the loop must break instead of looping.
        expect(harness.callIndex).toBe(1);
        expect(exitReason).toBe('exit');
        const msgs = messages(events);
        expect(msgs.some(m => m.startsWith('Cannot resume session:'))).toBe(true);
        // The real underlying reason must be surfaced (AC2), not swallowed.
        expect(msgs.some(m => m.includes('currently running as a background agent'))).toBe(true);
        // A recoverable "Process exited unexpectedly" retry message must NOT appear.
        expect(msgs.some(m => m.startsWith('Process exited unexpectedly'))).toBe(false);
    }, 15_000);

    it('retries a recoverable error up to MAX_LAUNCH_RETRIES then stops', async () => {
        // Always throw a transient (recoverable) error so the budget is the
        // only thing that stops the loop.
        const transient = async () => { throw new Error('Claude Code process exited with code 1'); };
        harness.behaviors = Array.from({ length: 10 }, () => transient);
        const { session, events } = createSessionStub();

        const exitReason = await claudeRemoteLauncher(session as never);

        // MAX_LAUNCH_RETRIES = 3: attempts are the initial try + 3 retries = 4,
        // and the 4th is where budgetExhausted trips and the loop breaks.
        expect(harness.callIndex).toBe(4);
        expect(exitReason).toBe('exit');
        const msgs = messages(events);
        const retries = msgs.filter(m => m.startsWith('Process exited unexpectedly'));
        expect(retries).toHaveLength(3);
        expect(msgs.some(m => m.includes('failed to start after 3 attempts'))).toBe(true);
    }, 15_000);

    it('resets the retry budget after a clean run', async () => {
        // The launch loop only ends when exitReason is set (the mocked
        // claudeRemote returns synchronously, so a clean run alone re-loops).
        // To prove the budget RESET, we burn 2 retries, do a clean run (reset),
        // then need a *full* fresh budget (3 more retries) before exhaustion.
        // If the reset were missing, exhaustion would trip far sooner.
        const transient = () => { throw new Error('Claude Code process exited with code 1'); };
        let cleanRunHappened = false;
        harness.behaviors = [
            async () => transient(),            // attempt 1: retry 1
            async () => transient(),            // attempt 2: retry 2
            async () => { cleanRunHappened = true; }, // attempt 3: clean -> budget reset
            async () => transient(),            // attempt 4: retry 1 (post-reset)
            async () => transient(),            // attempt 5: retry 2 (post-reset)
            async () => transient(),            // attempt 6: retry 3 (post-reset)
            async () => transient()             // attempt 7: budget exhausted -> break
        ];
        const { session, events } = createSessionStub();

        const exitReason = await claudeRemoteLauncher(session as never);

        expect(cleanRunHappened).toBe(true);
        // Without the reset, MAX_LAUNCH_RETRIES(=3) would trip at attempt 4
        // (2 pre + 1 post). The reset lets the loop reach attempt 7.
        expect(harness.callIndex).toBe(7);
        expect(exitReason).toBe('exit');
        const msgs = messages(events);
        // 2 retries before the clean run + 3 retries after = 5 transient messages.
        expect(msgs.filter(m => m.startsWith('Process exited unexpectedly'))).toHaveLength(5);
        // Exhaustion fires exactly once, on the post-reset budget.
        expect(msgs.filter(m => m.includes('failed to start after 3 attempts'))).toHaveLength(1);
    }, 15_000);
});
