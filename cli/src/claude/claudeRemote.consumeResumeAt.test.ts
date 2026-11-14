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

describe('claudeRemote turn signals', () => {
    // /compact writes a <command-name> XML line into the JSONL that
    // isExternalUserMessage filters out, so readNativeTurns never yields a
    // turn for it. Publishing onInputSubmitted for it advertised a
    // rewind/fork point that later fails with 'No native history point'.
    it('does not publish a history point for the /compact command turn', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        queryMock.mockImplementation((config: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = config.prompt[Symbol.asyncIterator]();
                await promptIterator.next();
                yield {
                    type: 'system',
                    subtype: 'init',
                    session_id: 'native-compact'
                } as unknown as SDKMessage;
            }
        }));

        const submitted: string[] = [];
        const baseOpts = {
            sessionId: 'native-compact',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            allowedTools: [] as string[],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
            onThinkingChange: () => {},
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onInputSubmitted: (uuid: string) => { submitted.push(uuid); }
        };

        try {
            await claudeRemote({
                ...baseOpts,
                claudeArgs: undefined,
                nextMessage: async () => ({ message: '/compact', mode: { permissionMode: 'bypassPermissions' } })
            });
            expect(submitted).toEqual([]);

            // A real prompt keeps publishing its native entry uuid.
            await claudeRemote({
                ...baseOpts,
                claudeArgs: undefined,
                nextMessage: async () => ({ message: 'plain prompt', mode: { permissionMode: 'bypassPermissions' } })
            });
            expect(submitted).toHaveLength(1);
        } finally {
            querySpy.mockRestore();
            queryMock.mockReset();
        }
    });

    // A resume-at respawn (or fork child) starts query() before any prompt
    // exists and unlocks first delivery on SessionStart/init. The session is
    // IDLE until the first prompt is dequeued, so it must not report
    // thinking:true while waiting - hub busy-gates block history actions on a
    // session that is doing nothing.
    it('reports thinking only once the first prompt is dequeued on a resume-at spawn', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        const thinkingStates: boolean[] = [];
        let promptCount = 0;
        let releaseFirstPrompt: (value: { message: string; mode: { permissionMode: 'bypassPermissions' } }) => void = () => {};
        const firstPrompt = new Promise<{ message: string; mode: { permissionMode: 'bypassPermissions' } }>((resolve) => {
            releaseFirstPrompt = resolve;
        });

        queryMock.mockImplementation((config: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'system',
                    subtype: 'hook_response',
                    hook_name: 'SessionStart:resume',
                    outcome: 'success'
                } as unknown as SDKMessage;
                const promptIterator = config.prompt[Symbol.asyncIterator]();
                await promptIterator.next();
                yield {
                    type: 'system',
                    subtype: 'init',
                    session_id: 'native-resumed'
                } as unknown as SDKMessage;
            }
        }));

        try {
            const run = claudeRemote({
                sessionId: 'native-resumed',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: ['--resume', 'native-resumed', '--resume-session-at', 'boundary-uuid'],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    promptCount += 1;
                    if (promptCount === 1) return firstPrompt;
                    return { message: 'done', mode: { permissionMode: 'bypassPermissions' } };
                },
                onThinkingChange: (thinking: boolean) => { thinkingStates.push(thinking); },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            // Idle window: the spawn is promptless and the unlock is blocked
            // in the first nextMessage(). No turn is in flight yet.
            await vi.waitFor(() => { expect(promptCount).toBe(1); });
            expect(thinkingStates).not.toContain(true);

            releaseFirstPrompt({ message: 'first prompt', mode: { permissionMode: 'bypassPermissions' } });
            await run;
            expect(thinkingStates).toContain(true);
        } finally {
            querySpy.mockRestore();
            queryMock.mockReset();
        }
    });
});

describe('claudeRemote one-shot boundary flags', () => {
    // A fork child's spawn args carry the hub-built fork boundary; the
    // launcher derives it into the spawn args only while the child is
    // unbuilt and stops deriving it once the child session materialized
    // (deriveSpawnArgs). claudeRemote parses it into a first-class sdk
    // option for THIS spawn and never touches claudeArgs.
    it('parses the fork boundary into the sdk spawn options for the gated first spawn', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        let spawnOptions: Record<string, unknown> | null = null;

        queryMock.mockImplementation((config: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
            spawnOptions = config.options;
            return {
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
            };
        });

        try {
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: ['--resume', 'source-session-id', '--fork-session', '--resume-session-at', 'boundary-uuid'],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () =>
                    { return { message: 'Reply with exactly: PONG3', mode: { permissionMode: 'bypassPermissions' } }; },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            expect(spawnOptions).toBeTruthy();
            expect(spawnOptions!.resumeSessionAt).toBe('boundary-uuid');
            expect(spawnOptions!.forkSession).toBe(true);
        } finally {
            querySpy.mockRestore();
            queryMock.mockReset();
        }
    });
});

describe('claudeRemote boundary spawn options', () => {
    // The boundary is decided at spawn time by deriveSpawnArgs (launcher)
    // and parsed here into a first-class sdk option. claudeRemote neither
    // consumes nor re-arms it: the launcher re-derives the args for every
    // spawn from the durable intent, so post-init retries keep truncating
    // while a rewind is unproven and fork children drop the flag once their
    // session materialized.
    it('parses the derived boundary into the sdk spawn options', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');

        let spawnOptions: Record<string, unknown> | null = null;
        queryMock.mockImplementation((config: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
            spawnOptions = config.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'system',
                        subtype: 'hook_response',
                        hook_name: 'SessionStart:resume',
                        outcome: 'success'
                    } as unknown as SDKMessage;
                    const promptIterator = config.prompt[Symbol.asyncIterator]();
                    await promptIterator.next();
                    yield {
                        type: 'system',
                        subtype: 'init',
                        session_id: 'native-resumed'
                    } as unknown as SDKMessage;
                }
            };
        });

        try {
            await claudeRemote({
                sessionId: 'native-resumed',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: ['--resume', 'native-resumed', '--resume-session-at', 'boundary-uuid'],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => ({ message: 'first prompt after rewind', mode: { permissionMode: 'bypassPermissions' } }),
                onThinkingChange: () => {},
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            expect(spawnOptions).toBeTruthy();
            expect(spawnOptions!.resumeSessionAt).toBe('boundary-uuid');
        } finally {
            querySpy.mockRestore();
            queryMock.mockReset();
        }
    });
});
