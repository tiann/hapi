import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk/types';
import type { Metadata } from '@/api/types';

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

const { getLiveAgentKindMock } = vi.hoisted(() => ({
    getLiveAgentKindMock: vi.fn<(sessionId: string) => 'background' | 'interactive' | null>()
}));

vi.mock('@/claude/utils/getLiveAgentKind', () => ({
    getLiveAgentKind: getLiveAgentKindMock
}));

const queryMock = vi.fn();

function createAsyncStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const message of messages) {
                await Promise.resolve();
                yield message;
            }
        }
    };
}

const RESUME_ID = '6f0c4551-1111-4222-8333-444455556666';
const FORKED_ID = 'aaaa1111-2222-4333-8444-555566667777';

function initThenResult(sessionId: string): SDKMessage[] {
    return [
        {
            type: 'system',
            subtype: 'init',
            session_id: sessionId
        } as unknown as SDKMessage,
        {
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: sessionId
        } as unknown as SDKMessage
    ];
}

const ENV_KEYS_UNDER_TEST = ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = {};
    for (const key of ENV_KEYS_UNDER_TEST) {
        savedEnv[key] = process.env[key];
    }
});

afterEach(() => {
    // Restore any process.env keys we touched so cases don't leak into each other.
    for (const key of ENV_KEYS_UNDER_TEST) {
        const original = savedEnv[key];
        if (original === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = original;
        }
    }
});

describe('claudeRemote fork-on-live-session decision', () => {
    it('forks (forkSession=true) and records forkedFrom when the session is live', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        getLiveAgentKindMock.mockReturnValue('background');
        queryMock.mockReturnValueOnce(createAsyncStream(initThenResult(FORKED_ID)));

        const { claudeRemote } = await import('./claudeRemote');
        const foundCalls: Array<{ id: string; extras?: Partial<Metadata> }> = [];

        let nextCallCount = 0;
        await claudeRemote({
            sessionId: RESUME_ID,
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'ping', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: (id, extras) => {
                foundCalls.push({ id, extras });
            },
            onMessage: () => {}
        });

        try {
            expect(getLiveAgentKindMock).toHaveBeenCalledWith(RESUME_ID);
            const passedOptions = queryMock.mock.calls[0][0].options;
            expect(passedOptions.resume).toBe(RESUME_ID);
            expect(passedOptions.forkSession).toBe(true);
            expect(foundCalls).toEqual([{ id: FORKED_ID, extras: { forkedFrom: RESUME_ID } }]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);

    it('applies claudeEnvVars to process.env BEFORE probing liveness (regression)', async () => {
        // getLiveAgentKind execs `claude agents --json` off process.env, so the
        // probe must see the injected claude env (e.g. CLAUDE_CONFIG_DIR) the real
        // launch uses; otherwise it queries the default config and misses live
        // sessions. Capture process.env at the moment the probe runs.
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        let configDirAtProbe: string | undefined = 'NOT_CALLED';
        getLiveAgentKindMock.mockImplementation(() => {
            configDirAtProbe = process.env.CLAUDE_CONFIG_DIR;
            return null;
        });
        queryMock.mockReturnValueOnce(createAsyncStream(initThenResult(RESUME_ID)));

        const { claudeRemote } = await import('./claudeRemote');

        let nextCallCount = 0;
        await claudeRemote({
            sessionId: RESUME_ID,
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/x-cfg' },
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'ping', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {}
        });

        try {
            expect(getLiveAgentKindMock).toHaveBeenCalledWith(RESUME_ID);
            // The injected env must already be live when the probe runs.
            expect(configDirAtProbe).toBe('/tmp/x-cfg');
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);

    it('does NOT fork a dead session and records no forkedFrom (regression: AC7)', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        getLiveAgentKindMock.mockReturnValue(null);
        // A dead resume reuses the same session id.
        queryMock.mockReturnValueOnce(createAsyncStream(initThenResult(RESUME_ID)));

        const { claudeRemote } = await import('./claudeRemote');
        const foundCalls: Array<{ id: string; extras?: Partial<Metadata> }> = [];

        let nextCallCount = 0;
        await claudeRemote({
            sessionId: RESUME_ID,
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'ping', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: (id, extras) => {
                foundCalls.push({ id, extras });
            },
            onMessage: () => {}
        });

        try {
            const passedOptions = queryMock.mock.calls[0][0].options;
            expect(passedOptions.resume).toBe(RESUME_ID);
            expect(passedOptions.forkSession).toBe(false);
            expect(foundCalls).toEqual([{ id: RESUME_ID, extras: undefined }]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);
});
