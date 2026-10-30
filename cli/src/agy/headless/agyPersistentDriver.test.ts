import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgyHeadlessDriver } from './agyHeadlessDriver';
import { AgySession } from '../session';
import type { AgyMode } from '../types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

const modelLookup = vi.hoisted(() => vi.fn(async (_id: unknown, indexes: readonly number[]) => (
    new Map<number, string | null>(indexes.map((index) => [index, null]))
)));
vi.mock('../utils/agyConversationModel', () => ({ resolveAgyTurnModels: modelLookup }));
vi.mock('../utils/agySessionTitle', () => ({ readAgyConversationTitle: async () => null }));

const CONVERSATION = '12345678-1234-4234-8234-123456789abc';
const MODE: AgyMode = { permissionMode: 'request-review', model: 'gemini-4-argon', effort: 'medium' };
const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];

/** Pipes stay open after a result. Closing stdin or killing the process emits close once. */
class PersistentChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin: Writable;
    readonly prompts: string[] = [];
    exitCode: number | null = null;
    killed = false;
    closeOnStdinEnd = true;
    onPrompt?: (prompt: string, callback: (error?: Error | null) => void) => void;

    constructor() {
        super();
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                const line = JSON.parse(String(chunk)) as { event: string; message: { content: string } };
                expect(line.event).toBe('user');
                expect(String(chunk).endsWith('\n')).toBe(true);
                this.prompts.push(line.message.content);
                if (this.onPrompt) this.onPrompt(line.message.content, callback);
                else callback();
            },
            final: (callback) => {
                callback();
                if (this.closeOnStdinEnd) queueMicrotask(() => this.close(0));
            },
        });
    }

    get process(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
    }

    feed(event: unknown): void {
        this.stdout.write(JSON.stringify(event) + '\n');
    }

    accept(stepIndex = 0): void {
        this.feed({ event: 'step_update', step_update: {
            conversation_id: CONVERSATION, step_index: stepIndex, state: 'DONE', step_type: 'user_input',
        } });
    }

    result(response: string): void {
        this.feed({ event: 'result', result: {
            conversation_id: CONVERSATION, status: 'SUCCESS', response,
        } });
    }

    close(code = 0): void {
        if (this.exitCode !== null) return;
        this.exitCode = code;
        this.stdout.end();
        this.stderr.end();
        this.stdin.destroy();
        this.emit('close', code, null);
    }

    kill(): boolean {
        this.killed = true;
        this.close(0);
        return true;
    }
}

function createHarness(configureChild?: (child: PersistentChild, index: number) => void) {
    const sent: unknown[][] = [];
    const client = {
        sendAgySessionMessage: (...args: unknown[]) => { sent.push(args); },
        emitMessagesConsumed: vi.fn(),
        emitSessionReady: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        keepAlive: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    };
    const queue = new MessageQueue2<AgyMode>((mode) => JSON.stringify(mode));
    const session = new AgySession({
        api: {} as never, client: client as never, path: tmpdir(),
        logPath: `${tmpdir()}/agy-persistent.log`, sessionId: null,
        messageQueue: queue, onModeChange: () => {}, startedBy: 'runner',
    });
    const children: PersistentChild[] = [];
    const spawnAgy = vi.fn((args: string[]) => {
        const child = new PersistentChild();
        configureChild?.(child, children.length);
        children.push(child);
        return child.process;
    });
    const driver = new AgyHeadlessDriver({ session, spawnAgy });
    const launch = driver.launch();
    const stop = async () => {
        queue.close();
        session.stopKeepAlive();
        await session.kill();
        children.forEach((child) => child.close());
        await launch;
    };
    cleanups.push(stop);
    return { client, queue, session, children, spawnAgy, sent, launch };
}

function waitFor(check: () => void, timeout = 2500): Promise<void> {
    return vi.waitFor(check, { timeout, interval: 5 });
}

function readyCount(client: ReturnType<typeof createHarness>['client']): number {
    return client.sendSessionEvent.mock.calls.filter(([event]) => event.type === 'ready').length;
}

async function flushTasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    for (const cleanup of cleanups.splice(0)) await cleanup();
    modelLookup.mockReset();
    modelLookup.mockImplementation(async (_id, indexes) => new Map(indexes.map((index) => [index, null])));
});

describe('Agy persistent stream lifecycle', () => {
    it('runs consecutive turns on one living process, using result rather than close as the boundary', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toEqual(['first']));
        const child = h.children[0]!;
        child.feed({ event: 'init', conversation_id: CONVERSATION, init: {} });
        child.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        expect(child.exitCode).toBeNull();
        expect(child.stdin.destroyed).toBe(false);
        h.queue.push('second', MODE, 'second-id');
        await waitFor(() => expect(child.prompts).toEqual(['first', 'second']));
        child.result('second answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(2));
        expect(h.spawnAgy).toHaveBeenCalledTimes(1);
        expect(h.client.emitMessagesConsumed.mock.calls).toEqual([[['first-id']], [['second-id']]]);
        expect(h.sent.map(([entry]) => (entry as { content: string }).content)).toEqual(['first answer', 'second answer']);
    });

    it('finishes asynchronous transcript sends before writing the next queued turn', async () => {
        let release!: (value: Map<number, string | null>) => void;
        const lookup = new Promise<Map<number, string | null>>((resolve) => { release = resolve; });
        releases.push(() => release(new Map([[2, 'Gemini 4 Argon']])));
        modelLookup.mockImplementationOnce(() => lookup);
        const h = createHarness();
        const mode: AgyMode = { permissionMode: 'request-review' };
        h.queue.push('first', mode, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        const child = h.children[0]!;
        child.feed({ event: 'init', conversation_id: CONVERSATION, init: {} });
        child.feed({ event: 'step_update', step_update: {
            conversation_id: CONVERSATION, step_index: 2, state: 'DONE',
            step_type: 'agent_response', text_delta: 'first answer',
        } });
        h.queue.push('second', mode, 'second-id');
        child.result('first answer');
        await waitFor(() => expect(modelLookup).toHaveBeenCalled());
        await flushTasks();
        expect(child.prompts).toEqual(['first']);
        expect(h.sent).toHaveLength(0);
        release(new Map([[2, 'Gemini 4 Argon']]));
        await waitFor(() => expect(child.prompts).toEqual(['first', 'second']));
        expect(h.sent).toHaveLength(1);
        child.result('second answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
    });

    it.each([
        ['model', { ...MODE, model: 'gemini-3.8-flash' }, '--model', 'gemini-3.8-flash'],
        ['effort', { ...MODE, effort: 'high' }, '--effort', 'high'],
        ['permission', { ...MODE, permissionMode: 'always-proceed' }, '--dangerously-skip-permissions', undefined],
    ] as const)('restarts on a queued %s change and resumes the adopted conversation', async (_name, nextMode, flag, value) => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        const first = h.children[0]!;
        first.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        h.queue.push('second', nextMode, 'second-id');
        await waitFor(() => expect(h.children[1]?.prompts).toEqual(['second']));
        expect(first.exitCode).not.toBeNull();
        const args = h.spawnAgy.mock.calls[1]![0];
        expect(args[args.indexOf('--conversation') + 1]).toBe(CONVERSATION);
        expect(args).toContain(flag);
        if (value !== undefined) expect(args[args.indexOf(flag) + 1]).toBe(value);
        h.children[1]!.result('second answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(2));
        expect(h.spawnAgy).toHaveBeenCalledTimes(2);
    });

    it('restores the unsent prompt when Stop interrupts a config restart', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        const first = h.children[0]!;
        first.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        first.closeOnStdinEnd = false;
        h.queue.push('not yet sent', { ...MODE, effort: 'high' }, 'second-id');
        await waitFor(() => expect(first.stdin.writableEnded).toBe(true));
        expect(h.session.thinking).toBe(true);
        const handler = h.client.rpcHandlerManager.registerHandler.mock.calls
            .find(([method]) => method === RPC_METHODS.Abort)?.[1] as (() => Promise<void>) | undefined;
        expect(handler).toBeDefined();
        await handler!();
        await waitFor(() => expect(h.session.thinking).toBe(false));
        expect(h.spawnAgy).toHaveBeenCalledTimes(1);
        expect(first.prompts).toEqual(['first']);
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'abort-restore', text: 'not yet sent' });
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['second-id']);
    });

    it('recovers from an idle process crash without replaying the completed turn', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        h.children[0]!.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        h.children[0]!.close(1);
        h.queue.push('second', MODE, 'second-id');
        await waitFor(() => expect(h.children[1]?.prompts).toEqual(['second']));
        expect(h.spawnAgy.mock.calls[1]![0]).toContain(CONVERSATION);
        h.children[1]!.result('second answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(2));
        expect(h.children.map((child) => child.prompts)).toEqual([['first'], ['second']]);
    });

    it.each([false, true])('handles stdin EPIPE with accepted=%s without replaying accepted work', async (accepted) => {
        const h = createHarness((child, index) => {
            if (index !== 0) return;
            child.onPrompt = (_prompt, callback) => {
                if (accepted) child.accept();
                callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
            };
        });
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        if (accepted) {
            await waitFor(() => expect(h.session.thinking).toBe(false));
            h.queue.push('second', MODE, 'second-id');
        }
        await waitFor(() => expect(h.children[1]?.prompts).toEqual([accepted ? 'second' : 'first']));
        h.children[1]!.result('answer');
        await waitFor(() => expect(h.session.thinking).toBe(false));
        expect(h.spawnAgy).toHaveBeenCalledTimes(2);
        expect(h.client.emitMessagesConsumed.mock.calls.filter(([ids]) => ids.includes('first-id'))).toHaveLength(1);
    });

    it('ignores an old process close while its replacement is running', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        const oldChild = h.children[0]!;
        oldChild.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        h.queue.push('second', { ...MODE, effort: 'high' }, 'second-id');
        await waitFor(() => expect(h.children[1]?.prompts).toHaveLength(1));
        oldChild.emit('close', 1, null);
        await flushTasks();
        expect(h.session.thinking).toBe(true);
        h.children[1]!.result('second answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(2));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['second-id']);
    });

    it('kills an idle warm process and stops the queue loop', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        h.children[0]!.result('answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        await h.session.kill();
        await h.launch;
        expect(h.children[0]!.exitCode).not.toBeNull();
        h.queue.push('never sent', MODE, 'later-id');
        await flushTasks();
        expect(h.children[0]!.prompts).toEqual(['first']);
        expect(h.spawnAgy).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('preserves a delivery before kill returns when queue wakeup races shutdown (warm=%s)', async (warm) => {
        const h = createHarness();
        if (warm) {
            h.queue.push('first', MODE, 'first-id');
            await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
            h.children[0]!.result('answer');
            await waitFor(() => expect(readyCount(h.client)).toBe(1));
        }
        h.queue.push('racing delivery', MODE, 'second-id');
        await h.session.kill();
        // Runner lifecycle may close the API immediately after kill resolves.
        const restored = h.client.sendSessionEvent.mock.calls.some(([event]) => (
            event.type === 'abort-restore' && event.text === 'racing delivery'
        ));
        expect(restored || h.queue.pendingLocalIds().includes('second-id')).toBe(true);
        if (restored) expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['second-id']);
        await h.launch;
        expect(h.children.flatMap((child) => child.prompts)).toEqual(warm ? ['first'] : []);
        expect(h.spawnAgy).toHaveBeenCalledTimes(warm ? 1 : 0);
    });

    it.each(['', '  \n\t '])('rejects empty prompts without retiring the warm process (%j)', async (prompt) => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        const child = h.children[0]!;
        child.result('first answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        h.queue.push(prompt, MODE, 'invalid-id');
        await waitFor(() => expect(readyCount(h.client)).toBe(2));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['invalid-id']);
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'abort-restore', text: prompt });
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'error', message: expect.stringContaining('non-empty prompt'),
        });
        expect(child.prompts).toEqual(['first']);
        expect(child.exitCode).toBeNull();
        expect(child.killed).toBe(false);
        h.queue.push('valid after rejection', MODE, 'third-id');
        await waitFor(() => expect(child.prompts).toEqual(['first', 'valid after rejection']));
        child.result('third answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(3));
        expect(h.spawnAgy).toHaveBeenCalledTimes(1);
    });

    it('retires and retries after a synchronous stdin.write throw before acceptance', async () => {
        const h = createHarness((child, index) => {
            if (index === 0) vi.spyOn(child.stdin, 'write').mockImplementationOnce(() => {
                throw new Error('synchronous write failure');
            });
        });
        h.queue.push('retry me', MODE, 'first-id');
        await waitFor(() => expect(h.children[1]?.prompts).toEqual(['retry me']));
        expect(h.children[0]!.exitCode).not.toBeNull();
        expect(h.children[0]!.prompts).toEqual([]);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        h.children[1]!.result('answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        expect(h.client.emitMessagesConsumed.mock.calls).toEqual([[['first-id']]]);
        expect(h.spawnAgy).toHaveBeenCalledTimes(2);
    });

    it('does not restore or abort a completed turn when a process error arrives afterward', async () => {
        const h = createHarness();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.children[0]?.prompts).toHaveLength(1));
        h.children[0]!.result('answer');
        await waitFor(() => expect(readyCount(h.client)).toBe(1));
        h.children[0]!.emit('error', new Error('late process failure'));
        h.children[0]!.close(1);
        await flushTasks();
        expect(h.client.sendSessionEvent.mock.calls.filter(([event]) => event.type === 'abort-restore')).toEqual([]);
        expect(h.client.sendSessionEvent.mock.calls.filter(([event]) => event.message === 'Turn aborted')).toEqual([]);
        expect(h.client.emitMessagesConsumed.mock.calls).toEqual([[['first-id']]]);
    });
});
