import { describe, it, expect, vi, afterEach } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage, SDKUserMessage } from '@/claude/sdk/types';
import type { ClaudeSteerTarget } from './claudeRemote';

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

/**
 * Fake Claude process: records stdin messages and emits whatever the test
 * scripts, so replay/result ordering can be driven explicitly.
 */
function createFakeClaude() {
    const stdin: SDKUserMessage[] = [];
    const outbox: Array<SDKMessage | Error | null> = [];
    let wake: (() => void) | null = null;
    let options: Record<string, unknown> | null = null;
    const emit = (message: SDKMessage | Error | null) => {
        outbox.push(message);
        wake?.();
        wake = null;
    };
    const query = ({ prompt, options: queryOptions }: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
        options = queryOptions;
        void (async () => {
            for await (const message of prompt) {
                stdin.push(message);
            }
        })();
        return {
            async *[Symbol.asyncIterator]() {
                while (true) {
                    while (outbox.length === 0) {
                        await new Promise<void>((resolve) => { wake = resolve; });
                    }
                    const next = outbox.shift()!;
                    if (next === null) return;
                    if (next instanceof Error) throw next;
                    yield next;
                }
            },
            setPermissionMode: async () => {},
            getContextUsage: async () => ({})
        };
    };
    return {
        stdin,
        emit,
        query,
        options: () => options,
        replay: (message: SDKUserMessage) => emit({
            type: 'user',
            uuid: message.uuid,
            isReplay: true,
            message: message.message
        } as SDKMessage),
        result: () => emit({ type: 'result', subtype: 'success' } as SDKMessage),
        close: () => emit(null),
        fail: (error: Error) => emit(error)
    };
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function startRemote(firstMessage = 'Run the tests') {
    const fake = createFakeClaude();
    const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(fake.query as unknown as typeof claudeSdk.query);
    const { claudeRemote } = await import('./claudeRemote');
    const targets: Array<ClaudeSteerTarget | null> = [];
    const relayed: SDKMessage[] = [];
    const thinking: boolean[] = [];
    const onReady = vi.fn();
    const onResultAccepted = vi.fn();
    let delivered = false;
    const run = claudeRemote({
        sessionId: null,
        path: process.cwd(),
        allowedTools: [],
        hookSettingsPath: '/tmp/hook.json',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        // One prompt, then park until the stream closes.
        nextMessage: async () => {
            if (!delivered) {
                delivered = true;
                return { message: firstMessage, mode: { permissionMode: 'default' } };
            }
            return null;
        },
        onReady,
        onResultAccepted,
        isAborted: () => false,
        onSessionFound: () => {},
        onThinkingChange: (value) => thinking.push(value),
        onMessage: (message) => relayed.push(message),
        onSteerTargetChange: (target) => targets.push(target)
    });
    await waitFor(() => fake.stdin.length === 1);
    return {
        fake,
        run,
        targets,
        relayed,
        thinking,
        onReady,
        onResultAccepted,
        currentTarget: () => targets.at(-1) ?? null,
        restore: () => querySpy.mockRestore()
    };
}

describe('claudeRemote steering', () => {
    let restore: (() => void) | null = null;
    afterEach(() => {
        restore?.();
        restore = null;
    });

    it('injects a steered message into the running turn and acks it by its echo', async () => {
        const remote = await startRemote();
        restore = remote.restore;
        const { fake } = remote;
        expect(fake.options()?.replayUserMessages).toBe(true);
        fake.replay(fake.stdin[0]!);

        const target = remote.currentTarget();
        expect(target).not.toBeNull();
        const delivery = target!.steer('Also run lint');
        expect(delivery).not.toBeNull();
        await waitFor(() => fake.stdin.length === 2);
        expect(fake.stdin[1]!.message.content).toBe('Also run lint');
        expect(fake.stdin[1]!.uuid).toEqual(expect.any(String));
        expect(fake.stdin[1]!.uuid).not.toBe(fake.stdin[0]!.uuid);

        fake.replay(fake.stdin[1]!);
        await expect(delivery!.delivered).resolves.toBe(true);

        fake.result();
        await waitFor(() => remote.onReady.mock.calls.length === 1);
        expect(remote.currentTarget()).toBeNull();
        expect(target!.steer('too late')).toBeNull();
        // Echoes are acks only, never relayed as chat messages.
        expect(remote.relayed.filter((message) => message.type === 'user')).toEqual([]);

        fake.close();
        await remote.run;
    });

    it('keeps the turn open when the result arrives before Claude picks up a steer', async () => {
        const remote = await startRemote();
        restore = remote.restore;
        const { fake } = remote;
        fake.replay(fake.stdin[0]!);
        const delivery = remote.currentTarget()!.steer('Then summarize')!;
        await waitFor(() => fake.stdin.length === 2);

        // Text-only turn: no tool boundary, so Claude finishes first and runs
        // a follow-up turn for the steered message.
        fake.result();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(remote.onReady).not.toHaveBeenCalled();
        expect(remote.thinking.at(-1)).toBe(true);
        expect(remote.currentTarget()).not.toBeNull();

        fake.replay(fake.stdin[1]!);
        await expect(delivery.delivered).resolves.toBe(true);
        fake.result();
        await waitFor(() => remote.onReady.mock.calls.length === 1);
        expect(remote.thinking.at(-1)).toBe(false);
        expect(remote.currentTarget()).toBeNull();

        fake.close();
        await remote.run;
    });

    it('retires the completed prompt when the stream fails during a steer follow-up turn', async () => {
        const remote = await startRemote();
        restore = remote.restore;
        const { fake } = remote;
        fake.replay(fake.stdin[0]!);
        const delivery = remote.currentTarget()!.steer('Then summarize')!;
        await waitFor(() => fake.stdin.length === 2);

        fake.result();
        await waitFor(() => remote.onResultAccepted.mock.calls.length === 1);
        expect(remote.onReady).not.toHaveBeenCalled();

        fake.fail(new Error('Claude exited'));
        await expect(remote.run).rejects.toThrow('Claude exited');
        await expect(delivery.delivered).resolves.toBe(false);
        expect(remote.currentTarget()).toBeNull();
    });

    it('closes the steer target when query setup throws', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(() => {
            throw new Error('Fallback model cannot be the same as the main model');
        });
        restore = () => querySpy.mockRestore();
        const { claudeRemote } = await import('./claudeRemote');
        const targets: Array<ClaudeSteerTarget | null> = [];
        let delivered = false;
        await expect(claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                if (delivered) return null;
                delivered = true;
                return { message: 'Run the tests', mode: { permissionMode: 'default' } };
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onSteerTargetChange: (target) => targets.push(target)
        })).rejects.toThrow('Fallback model');

        expect(targets).toHaveLength(2);
        expect(targets[1]).toBeNull();
        expect(targets[0]!.steer('stranded')).toBeNull();
    });

    it('reports an unacknowledged steer as undelivered when the stream closes', async () => {
        const remote = await startRemote();
        restore = remote.restore;
        const { fake } = remote;
        const delivery = remote.currentTarget()!.steer('Never seen')!;
        await waitFor(() => fake.stdin.length === 2);

        fake.close();
        await remote.run;
        await expect(delivery.delivered).resolves.toBe(false);
        expect(remote.currentTarget()).toBeNull();
    });

    it('does not offer a steer target for a slash command turn', async () => {
        const remote = await startRemote('/compact');
        restore = remote.restore;
        expect(remote.targets).toEqual([]);
        remote.fake.close();
        await remote.run;
    });
});
