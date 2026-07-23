import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring test for unrecoverable resume errors in claudeRemoteLauncher
 * (fork-resume / #942). Recoverable immediate-failure / drop-message behavior
 * is covered by claudeRemoteLauncher.launchFailure.test.ts (main).
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
        clearSessionId: () => {},
        getModel: () => null
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
});
