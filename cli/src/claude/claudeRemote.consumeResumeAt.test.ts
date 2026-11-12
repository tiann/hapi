import { describe, expect, it, vi } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk/types';

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

const queryMock = vi.fn();

describe('claudeRemote one-shot boundary flags', () => {
    // A fork child's --resume-session-at truncates at spawn time only. The flag
    // must be consumed from the session's claudeArgs once the native boundary
    // has materialized (init arrives on the forked session), otherwise a later
    // relaunch - model change, reconnect - re-applies the boundary and drops
    // the turns the child added after the fork while the hub keeps them. The
    // pending-rewind re-arm is the exception: the runner re-writes the flag per
    // respawn until the durable intent settles, so consuming here cannot break
    // rewind crash consistency.
    it('consumes --resume-session-at from claudeArgs once the forked session initializes', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        // Mirror of the launcher's session.claudeArgs for a fork child spawn.
        let claudeArgs = ['--resume', 'source-session-id', '--fork-session', '--resume-session-at', 'boundary-uuid'];
        let updateCalls = 0;

        queryMock.mockImplementation((config: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                // The SessionStart hook must be yielded BEFORE consuming the
                // prompt: on the fork path claudeRemote only pushes the first
                // prompt once the hook unlocked initial delivery.
                yield {
                    type: 'system',
                    subtype: 'hook_response',
                    hook_name: 'SessionStart:fork',
                    outcome: 'success'
                } as unknown as SDKMessage;
                // Consume the pushed first prompt like the real SDK does.
                const promptIterator = config.prompt[Symbol.asyncIterator]();
                const next = await promptIterator.next();
                void next;
                yield {
                    type: 'system',
                    subtype: 'init',
                    session_id: 'child-native-session'
                } as unknown as SDKMessage;
                // Stream ends: the respawn attempt is over.
            }
        }));

        try {
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [...claudeArgs],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () =>
                    { return { message: 'Reply with exactly: PONG3', mode: { permissionMode: 'bypassPermissions' } }; },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onUpdateClaudeArgs: (update) => {
                    updateCalls += 1;
                    const next = update(claudeArgs);
                    if (next) claudeArgs = next;
                }
            });

            // The boundary materialized with init: the args update must have
            // fired exactly once and stripped only the resume-at flag.
            expect(updateCalls).toBe(1);
            expect(claudeArgs).not.toContain('--resume-session-at');
            expect(claudeArgs).toContain('--resume');
            expect(claudeArgs).toContain('--fork-session');
        } finally {
            querySpy.mockRestore();
            queryMock.mockReset();
        }
    });
});