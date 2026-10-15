import { describe, it, expect, vi, afterEach } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage, SDKUserMessage } from '@/claude/sdk/types';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { claudeRemote, type SteerFunction } from './claudeRemote';

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

type Mode = { permissionMode: 'default' };

const result = {
    type: 'result',
    subtype: 'success',
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    session_id: 's-1'
} as unknown as SDKMessage;

function lifecycle(commandUuid: string | undefined, state: string): SDKMessage {
    return { type: 'command_lifecycle', command_uuid: commandUuid, state } as unknown as SDKMessage;
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

/** Lets the test play Claude: read the prompts hapi writes, emit stream messages. */
function startFakeClaude(initialMessage: string) {
    const prompts: SDKUserMessage[] = [];
    const output = new PushableAsyncIterable<SDKMessage>();
    const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation((({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        void (async () => {
            for await (const message of prompt) {
                prompts.push(message);
            }
        })();
        return output;
    }) as unknown as typeof claudeSdk.query);

    let nextCallCount = 0;
    let releaseNext: ((value: { message: string; mode: Mode } | null) => void) | null = null;
    const readyEvents: number[] = [];
    const thinking: boolean[] = [];
    const steerable: boolean[] = [];
    // Outcome of each steer, in the order they were reported.
    const outcomes: string[] = [];
    let steer: SteerFunction | null = null;

    const run = claudeRemote({
        sessionId: 'session-1',
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
                return { message: initialMessage, mode: { permissionMode: 'default' } };
            }
            return await new Promise((resolve) => { releaseNext = resolve; });
        },
        onReady: () => { readyEvents.push(Date.now()); },
        isAborted: () => false,
        onSessionFound: () => {},
        onThinkingChange: (value) => { thinking.push(value); },
        onMessage: () => {},
        onCompletionEvent: () => {},
        onSteerableChange: (value) => {
            steer = value;
            steerable.push(value !== null);
        }
    });

    return {
        prompts,
        readyEvents,
        thinking,
        steerable,
        outcomes,
        getSteer: () => steer,
        /** Steer through the current steer function, recording its outcome. */
        steer: (message: string, steerFn: SteerFunction | null = steer) => steerFn?.(message, {
            onStarted: () => { outcomes.push(`started:${message}`); },
            onDropped: () => { outcomes.push(`dropped:${message}`); }
        }) ?? false,
        emit: (message: SDKMessage) => output.push(message),
        /** Emit messages and let claudeRemote process them. */
        async play(...messages: SDKMessage[]) {
            for (const message of messages) {
                output.push(message);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        },
        async finish() {
            await waitFor(() => releaseNext !== null);
            releaseNext!(null);
            output.end();
            await run;
            querySpy.mockRestore();
        },
        /** The Claude process fails mid-turn. */
        async crash() {
            output.setError(new Error('Claude exited'));
            await expect(run).rejects.toThrow('Claude exited');
            querySpy.mockRestore();
        }
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

/** A fake Claude whose initial prompt has started, so lifecycle reports are on. */
async function startRunningTurn(initialMessage: string) {
    const claude = startFakeClaude(initialMessage);
    await waitFor(() => claude.prompts.length === 1);
    const initialUuid = claude.prompts[0].uuid;
    expect(initialUuid).toBeTruthy();
    await claude.play(lifecycle(initialUuid, 'queued'), lifecycle(initialUuid, 'started'));
    return { claude, initialUuid };
}

describe('claudeRemote mid-turn steering', () => {
    it('writes a steer into the running turn and reports it once Claude takes it', async () => {
        const { claude, initialUuid } = await startRunningTurn('Run the three steps');

        expect(claude.steer('Skip step three')).toBe(true);
        await waitFor(() => claude.prompts.length === 2);
        const steerPrompt = claude.prompts[1];
        expect(steerPrompt.message.content).toBe('Skip step three');
        expect(steerPrompt.uuid).toBeTruthy();
        expect(steerPrompt.uuid).not.toBe(initialUuid);

        await claude.play(lifecycle(steerPrompt.uuid, 'queued'));
        expect(claude.outcomes).toEqual([]);

        // Absorbed at the next tool boundary, before the turn's result.
        await claude.play(lifecycle(steerPrompt.uuid, 'started'), result);

        expect(claude.outcomes).toEqual(['started:Skip step three']);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.thinking.at(-1)).toBe(false);
        expect(claude.steerable).toEqual([true, false]);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('stays busy through the follow-up turn when the steer arrives after the last tool call', async () => {
        const { claude, initialUuid } = await startRunningTurn('Write an essay');

        const steer = claude.getSteer();
        expect(claude.steer('Add a sentence about coffee')).toBe(true);
        await waitFor(() => claude.prompts.length === 2);
        const steerUuid = claude.prompts[1].uuid;

        // The turn ends before the steer was absorbed: Claude runs it next.
        await claude.play(lifecycle(steerUuid, 'queued'), result, lifecycle(initialUuid, 'completed'));
        expect(claude.readyEvents).toHaveLength(0);
        expect(claude.thinking).not.toContain(false);
        expect(claude.getSteer()).toBe(steer);
        expect(claude.outcomes).toEqual([]);

        await claude.play(lifecycle(steerUuid, 'started'), result);
        expect(claude.outcomes).toEqual(['started:Add a sentence about coffee']);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.thinking.at(-1)).toBe(false);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('stays busy until every queued steer has run in its own follow-up turn', async () => {
        const { claude } = await startRunningTurn('Write an essay');

        expect(claude.steer('First follow-up')).toBe(true);
        expect(claude.steer('Second follow-up')).toBe(true);
        await waitFor(() => claude.prompts.length === 3);
        const [firstUuid, secondUuid] = [claude.prompts[1].uuid, claude.prompts[2].uuid];
        await claude.play(lifecycle(firstUuid, 'queued'), lifecycle(secondUuid, 'queued'), result);
        expect(claude.readyEvents).toHaveLength(0);

        // Claude runs the first one; the second is still queued behind it.
        await claude.play(lifecycle(firstUuid, 'started'), result, lifecycle(firstUuid, 'completed'));
        expect(claude.outcomes).toEqual(['started:First follow-up']);
        expect(claude.readyEvents).toHaveLength(0);
        expect(claude.thinking).not.toContain(false);

        // Two results later, a steer Claude still reports as queued is waited on.
        await claude.play(result);
        expect(claude.readyEvents).toHaveLength(0);

        await claude.play(lifecycle(secondUuid, 'started'), result);
        expect(claude.outcomes).toEqual(['started:First follow-up', 'started:Second follow-up']);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('reports a steer Claude cancels before it starts as dropped', async () => {
        const { claude } = await startRunningTurn('Write an essay');

        expect(claude.steer('Never mind')).toBe(true);
        await waitFor(() => claude.prompts.length === 2);
        await claude.play(lifecycle(claude.prompts[1].uuid, 'queued'), lifecycle(claude.prompts[1].uuid, 'cancelled'));
        expect(claude.outcomes).toEqual(['dropped:Never mind']);

        await claude.play(result);
        expect(claude.readyEvents).toHaveLength(1);

        await claude.finish();
    });

    it('reports unstarted steers as dropped when the Claude process fails', async () => {
        const { claude } = await startRunningTurn('Write an essay');

        expect(claude.steer('Taken')).toBe(true);
        expect(claude.steer('Still queued')).toBe(true);
        await waitFor(() => claude.prompts.length === 3);
        await claude.play(
            lifecycle(claude.prompts[1].uuid, 'queued'),
            lifecycle(claude.prompts[1].uuid, 'started'),
            lifecycle(claude.prompts[2].uuid, 'queued')
        );

        await claude.crash();

        expect(claude.outcomes).toEqual(['started:Taken', 'dropped:Still queued']);
        expect(claude.getSteer()).toBeNull();
    });

    it('treats a steer as taken at once when Claude reports no command lifecycle', async () => {
        const claude = startFakeClaude('Run the three steps');
        await waitFor(() => claude.prompts.length === 1);

        expect(claude.steer('Skip step three')).toBe(true);
        expect(claude.outcomes).toEqual(['started:Skip step three']);
        await claude.play(result);

        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('waits for a steer Claude never reports through one result only', async () => {
        const { claude } = await startRunningTurn('Write an essay');

        expect(claude.steer('Add a sentence about coffee')).toBe(true);
        await claude.play(result);
        expect(claude.readyEvents).toHaveLength(0);

        // Its lifecycle report went missing; the next result must not wait again.
        await claude.play(result);
        expect(claude.outcomes).toEqual(['started:Add a sentence about coffee']);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('rejects a steer once the turn has ended', async () => {
        const claude = startFakeClaude('Run the three steps');
        await waitFor(() => claude.prompts.length === 1);
        const steer = claude.getSteer();
        await claude.play(result);

        expect(claude.steer('Too late', steer)).toBe(false);
        expect(claude.prompts).toHaveLength(1);
        expect(claude.outcomes).toEqual([]);

        await claude.finish();
    });

    it('does not offer steering during /compact', async () => {
        const claude = startFakeClaude('/compact');
        await waitFor(() => claude.prompts.length === 1);
        expect(claude.getSteer()).toBeNull();
        await claude.play(result);

        expect(claude.steerable).toEqual([]);

        await claude.finish();
    });
});
