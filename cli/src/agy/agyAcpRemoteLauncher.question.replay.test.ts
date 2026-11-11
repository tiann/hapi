import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import agyQuestionTurn from '@/agent/backends/acp/__fixtures__/agy-question-turn.json';
import { AgySession } from './session';
import type { AgyMode } from './types';
import { AgyAcpRemoteLauncher } from './agyAcpRemoteLauncher';
import { createAgyAcpBackend } from './utils/agyAcpBackend';

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

type Frame = { t: number; direction: string; message: Record<string, unknown> };
const frames = agyQuestionTurn.frames as Frame[];
const prompt = frames[0]!;
const promptText = ((prompt.message.params as { prompt: Array<{ text: string }> }).prompt)[0]!.text;
const elicitationIndex = frames.findIndex((frame) => frame.message.method === 'elicitation/create');
const result = frames.find((frame) => frame.direction === 'agy->client' && 'result' in frame.message)!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Plays agy's side of the recorded question turn and records the client's answer. */
class ReplayTransport {
    private notify: (method: string, params: unknown) => void = () => {};
    private readonly requestHandlers = new Map<string, (params: unknown, id: string | number | null) => Promise<unknown>>();
    initializeParams: Record<string, unknown> | null = null;
    answer: unknown = undefined;

    onNotification(handler: (method: string, params: unknown) => void): void {
        this.notify = handler;
    }
    onStderrError(): void {}
    registerRequestHandler(method: string, handler: (params: unknown, id: string | number | null) => Promise<unknown>): void {
        this.requestHandlers.set(method, handler);
    }
    isAlive(): boolean {
        return true;
    }
    sendNotification(): void {}
    async close(): Promise<void> {}

    async sendRequest(method: string, params?: unknown): Promise<unknown> {
        switch (method) {
            case 'initialize':
                this.initializeParams = params as Record<string, unknown>;
                return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
            case 'session/new':
                return { sessionId: 'agy-conv-1', models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
            case 'session/prompt':
                for (const [index, frame] of frames.entries()) {
                    if (frame.direction !== 'agy->client' || 'result' in frame.message) continue;
                    await tick();
                    if (index === elicitationIndex) {
                        const handler = this.requestHandlers.get('elicitation/create')!;
                        this.answer = await handler(frame.message.params, frame.message.id as string);
                        continue;
                    }
                    this.notify('session/update', frame.message.params);
                }
                return (result.message as { result: unknown }).result;
            default:
                return {};
        }
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

function agentRequests(client: ReturnType<typeof makeClient>): Record<string, { tool: string; arguments: unknown }> {
    const state = client.updateAgentState.mock.calls
        .reduce((current, [update]) => (update as (s: object) => object)(current), {} as object) as { requests?: Record<string, { tool: string; arguments: unknown }> };
    return state.requests ?? {};
}

describe('AgyAcpRemoteLauncher replaying a recorded agy 1.5.3 question', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('asks through the question card and answers agy with the chosen option', async () => {
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
            // Even here a question waits for the user.
            permissionMode: 'always-proceed'
        });
        queue.push(promptText, { permissionMode: 'always-proceed' }, 'first');
        const launcher = new AgyAcpRemoteLauncher(session, { createBackend: createAgyAcpBackend });
        const run = launcher.launch();

        await vi.waitFor(() => expect(agentRequests(client).call_q).toMatchObject({
            tool: 'AskUserQuestion',
            arguments: { questions: [{ question: 'Do you prefer RED or BLUE?', multiSelect: false, options: [{ label: '(Recommended) RED' }, { label: 'BLUE' }] }] }
        }), { timeout: 5000 });
        expect(transport.initializeParams).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } });
        expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call', callId: 'call_q', name: 'AskUserQuestion' }));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Permission)!({ id: 'call_q', approved: true, answers: { '0': ['BLUE'] } });
        await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }), { timeout: 10_000 });
        queue.close();
        await run;

        expect(transport.answer).toEqual({ action: 'accept', content: { q1: '2' } });
        expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'BLUE' }));
    }, 20_000);
});
