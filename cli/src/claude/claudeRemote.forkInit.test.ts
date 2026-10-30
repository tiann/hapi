import { describe, it, expect, vi } from 'vitest';
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

async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

describe('claudeRemote fork bootstrap', () => {
    // A forked child starts query() before any prompt exists. Real SDK runs emit
    // SessionStart hooks but no `init` until the first prompt is sent, so the
    // child prompt must be accepted on the fork hook signal alone.
    it('pushes the first child prompt after SessionStart:fork even when init never arrives', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        let receivedPrompt: unknown;
        let promptClosed = false;

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();

                // Fork bootstrap: hooks arrive while no prompt has been pushed yet.
                yield { type: 'system', subtype: 'hook_started' } as unknown as SDKMessage;
                yield {
                    type: 'system',
                    subtype: 'hook_response',
                    hook_name: 'SessionStart:fork',
                    outcome: 'success'
                } as unknown as SDKMessage;

                // The fix must push the first child prompt here.
                const next = await promptIterator.next();
                receivedPrompt = next.value;
                promptClosed = true;
            }
        }));

        try {
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: ['--resume', 'source-session-id', '--fork-session'],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () =>
                    { return { message: 'Reply with exactly: PONG2', mode: { permissionMode: 'bypassPermissions' } }; },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            await waitFor(() => promptClosed);
            expect(receivedPrompt).toMatchObject({
                type: 'user',
                message: { role: 'user', content: 'Reply with exactly: PONG2' }
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });
});
