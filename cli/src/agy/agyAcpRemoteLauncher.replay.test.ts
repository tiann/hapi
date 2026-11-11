import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSdkBackend } from '@/agent/backends/acp';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import agySteeredTurn from '@/agent/backends/acp/__fixtures__/agy-steered-turn.json';
import { AgySession } from './session';
import type { AgyMode } from './types';
import { AgyAcpRemoteLauncher } from './agyAcpRemoteLauncher';

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

type Frame = { t: number; direction: string; message: Record<string, unknown> };
const frames = agySteeredTurn.frames as Frame[];
const promptText = (frame: Frame) =>
    ((frame.message.params as { prompt: Array<{ text: string }> }).prompt)[0]!.text;
const requests = frames.filter((frame) => frame.direction === 'client->agy');
const mainPrompt = promptText(requests[0]!);
const steerText = promptText(requests[1]!);
const resultOf = (id: number) => (frames.find((frame) => frame.message.id === id && 'result' in frame.message)!
    .message as { result: unknown }).result;
const updatesBetween = (from: number, to: number) => frames
    .filter((frame) => frame.direction === 'agy->client' && frame.message.method === 'session/update'
        && frame.t > from && frame.t < to);
const resultTime = (id: number) => frames.find((frame) => frame.message.id === id && 'result' in frame.message)!.t;
// Recorded seconds play back as 50 ms each.
const MS_PER_SECOND = 50;
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * MS_PER_SECOND));

/**
 * Plays agy's side of the recorded steered turn: the frames before the steer,
 * the early answer to the interrupted request once the steer arrives, then
 * the rest of the turn and the steer's answer.
 */
class ReplayTransport {
    private notify: (method: string, params: unknown) => void = () => {};
    private steerArrived!: () => void;
    private readonly steerReceived = new Promise<void>((resolve) => { this.steerArrived = resolve; });
    readonly methods: string[] = [];

    onNotification(handler: (method: string, params: unknown) => void): void {
        this.notify = handler;
    }
    onStderrError(): void {}
    registerRequestHandler(): void {}
    isAlive(): boolean {
        return true;
    }
    sendNotification(method: string): void {
        this.methods.push(method);
    }
    async close(): Promise<void> {}

    /** Plays the frames with their recorded spacing, starting from `from`. */
    private async play(updates: Frame[], from: number): Promise<number> {
        let at = from;
        for (const frame of updates) {
            await sleep(frame.t - at);
            at = frame.t;
            this.notify('session/update', frame.message.params);
        }
        return at;
    }

    async sendRequest(method: string): Promise<unknown> {
        this.methods.push(method);
        switch (method) {
            case 'initialize':
                return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
            case 'session/new':
                return {
                    sessionId: 'agy-conv-1',
                    models: { availableModels: [{ modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }], currentModelId: 'gemini-3.8-flash-low' }
                };
            case 'session/prompt':
                await this.play(updatesBetween(requests[0]!.t, requests[1]!.t), requests[0]!.t);
                await this.steerReceived;
                return resultOf(104);
            default:
                return {};
        }
    }

    sendRequestWithDispatch(method: string): { dispatched: Promise<void>; completed: Promise<unknown> } {
        this.methods.push(method);
        this.steerArrived();
        const completed = (async () => {
            const last = await this.play(updatesBetween(requests[1]!.t, resultTime(105)), requests[1]!.t);
            await sleep(resultTime(105) - last);
            return resultOf(105);
        })();
        return { dispatched: Promise.resolve(), completed };
    }
}

function makeClient() {
    const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
    return {
        sessionId: 'hapi-session',
        rpcHandlerManager: {
            handlers,
            registerHandler: vi.fn((method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                handlers.set(method, handler);
            }),
            unregisterHandler: vi.fn()
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        getMetadata: vi.fn(() => null),
        keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
    };
}

describe('AgyAcpRemoteLauncher replaying a recorded agy 1.5.2 steered turn', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('places the steer, the answer and the usage as agy reported them', async () => {
        const transport = new ReplayTransport();
        vi.spyOn(AcpStdioTransport, 'create').mockResolvedValue(transport as unknown as AcpStdioTransport);
        const queue = new MessageQueue2<AgyMode>((mode) => hashObject(mode));
        const client = makeClient();
        const session = new AgySession({
            api: {} as never,
            client: client as unknown as ApiSessionClient,
            path: '/tmp/agy-project',
            logPath: '/tmp/agy.log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            permissionMode: 'always-proceed'
        });
        const mode: AgyMode = { permissionMode: 'always-proceed' };
        queue.push(mainPrompt, mode, 'first');
        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => new AcpSdkBackend({ command: 'agy', args: ['acp'], flavor: 'agy' })
        });
        const run = launcher.launch();

        // Steer once agy reports the running tool call.
        await vi.waitFor(() => expect(client.sendAgentMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'tool-call', callId: 'call_1' })
        ), { timeout: 5000 });
        queue.push(steerText, mode, 'steer-1');
        const steer = client.rpcHandlerManager.handlers.get(RPC_METHODS.SteerQueuedMessage)!;
        expect(await steer({ localId: 'steer-1' })).toEqual({ steered: true });

        await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }), { timeout: 10_000 });
        queue.close();
        await run;

        const order = (fn: { mock: { invocationCallOrder: number[] } }, index: number) => fn.mock.invocationCallOrder[index]!;
        const sent = client.sendAgentMessage.mock.calls.map(([message]) => message as { type: string; message?: string });
        const answerIndex = sent.findIndex((message) => message.type === 'message' && message.message?.includes('BANANA'));
        const steerConsumed = client.emitMessagesConsumed.mock.calls.findIndex(([ids, opts]) =>
            (ids as string[])[0] === 'steer-1' && (opts as { steered?: boolean } | undefined)?.steered === true);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['first']);
        expect(steerConsumed).toBeGreaterThanOrEqual(0);
        expect(answerIndex).toBeGreaterThanOrEqual(0);
        // The steer enters the transcript at agy's echo, before the answer to it.
        expect(order(client.emitMessagesConsumed, steerConsumed)).toBeLessThan(order(client.sendAgentMessage, answerIndex));
        const summaries = sent.filter((message) => message.type === 'round-summary');
        expect(summaries).toMatchObject([{
            type: 'round-summary',
            summary: {
                provider: 'agy',
                model: 'gemini-3.8-flash-low',
                agy_usage: {
                    input_tokens: 15172 + 15286,
                    output_tokens: 44 + 14,
                    thinking_tokens: 0,
                    cache_read_tokens: 0,
                    total_tokens: 15216 + 15300
                },
                duration_ms: expect.any(Number)
            }
        }]);
        // Generation time is the round minus the run_command window: in the
        // recording 12.63 s - 6.25 s = 6.38 s. When the test sends the steer
        // does not matter, since it moves the round's end and the tool's end
        // alike.
        const toolCall = frames.find((frame) => (frame.message.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === 'tool_call')!.t;
        const toolDone = frames.find((frame) => (frame.message.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === 'tool_call_update')!.t;
        const expected = ((resultTime(105) - requests[0]!.t) - (toolDone - toolCall)) * MS_PER_SECOND;
        const summary = (summaries[0] as unknown as { summary: { generation_ms: number; generation_output_tokens: number } }).summary;
        expect(Math.abs(summary.generation_ms - expected)).toBeLessThan(60);
        expect(summary.generation_output_tokens).toBe(44 + 14);
        expect(transport.methods.filter((method) => method === 'session/prompt')).toHaveLength(2);
        expect(transport.methods).not.toContain('session/cancel');
    }, 20_000);
});
