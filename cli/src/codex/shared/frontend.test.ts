import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeReady } from './runtime';
import type { SharedLaunchOptions } from './launch';

const state = vi.hoisted(() => ({ existing: false, run: vi.fn(), spawn: vi.fn(), kill: vi.fn() }));
const runtime: RuntimeReady['runtime'] = { id: 'runtime', pid: 1, marker: 'start', endpoint: 'unix://private', command: '/resolved/codex',
    args: [], codexHome: '/isolated/codex', hub: 'hub', authHash: 'auth', sessions: { sid: { threadId: 'thread', namespace: 'ns', active: true } } };
vi.mock('node:child_process', () => ({ spawn: state.spawn, execFileSync: vi.fn() }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({ getSession: async () => ({ id: 'sid', namespace: 'ns', active: state.existing, metadata: { path: '/work' } }) }) } }));
vi.mock('@/persistence', () => ({ readRunnerState: async () => null }));
vi.mock('@/utils/process', () => ({ isProcessAlive: () => true, killProcessByChildProcess: state.kill }));
vi.mock('./registry', () => ({ findRuntime: async () => state.existing ? runtime : undefined, runtimeAlive: () => true }));
vi.mock('./runtime', () => ({ runSharedRuntime: state.run }));
vi.mock('../codexAppServerClient', () => ({ CodexAppServerClient: class {
    setServerRequestHandler() {} async connect() {} async initialize() {} async disconnect() {}
    async request() { return { threadId: 'thread' }; }
} }));
import { runSharedCodex } from './frontend';

const tty = [Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')];
beforeEach(() => {
    vi.clearAllMocks(); state.existing = false;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    state.spawn.mockImplementation(() => new EventEmitter());
    state.kill.mockImplementation(async (child: EventEmitter) => { child.emit('exit', 0); return true; });
    state.run.mockImplementation(async (_options: SharedLaunchOptions, ready?: (ready: RuntimeReady) => void, signal?: AbortSignal) => {
        ready?.({ sessionId: 'sid', runtime });
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
});
afterEach(() => {
    for (const [index, stream] of [process.stdin, process.stdout].entries()) {
        if (tty[index]) Object.defineProperty(stream, 'isTTY', tty[index]!);
        else Reflect.deleteProperty(stream, 'isTTY');
    }
});
describe('shared frontend execution ownership', () => {
    it.each([0, 1])('stops the owned execution when its primary TUI exits (%s)', async code => {
        const running = runSharedCodex({ workingDirectory: '/work' });
        const result = code ? expect(running).rejects.toThrow('terminal exited') : expect(running).resolves.toBeUndefined();
        await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
        const child = state.spawn.mock.results[0].value as EventEmitter; child.emit('exit', code);
        await result;
        expect((state.run.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    });
    it('detaches a secondary TUI without acquiring or ending execution ownership', async () => {
        state.existing = true;
        const running = runSharedCodex({ existingSessionId: 'sid', workingDirectory: '/work' });
        await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
        (state.spawn.mock.results[0].value as EventEmitter).emit('exit', 0);
        await running; expect(state.run).not.toHaveBeenCalled(); expect(state.kill).not.toHaveBeenCalled();
        expect(state.spawn.mock.calls[0][0]).toBe('/resolved/codex');
    });
    it('uses the ordinary Runner-owned wrapper without spawning a TUI', async () => {
        state.run.mockResolvedValueOnce(undefined);
        await runSharedCodex({ startedBy: 'runner', workingDirectory: '/work' });
        expect(state.run).toHaveBeenCalledOnce(); expect(state.spawn).not.toHaveBeenCalled();
    });
    it('stops the engine on TUI spawn error and leaves no execution on startup failure', async () => {
        state.run.mockRejectedValueOnce(new Error('startup failed'));
        await expect(runSharedCodex({ workingDirectory: '/work' })).rejects.toThrow('startup failed');
        expect(state.spawn).not.toHaveBeenCalled();
        const running = runSharedCodex({ workingDirectory: '/work' });
        const result = expect(running).rejects.toThrow('TUI unavailable');
        await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
        (state.spawn.mock.results[0].value as EventEmitter).emit('error', new Error('TUI unavailable'));
        await result; expect((state.run.mock.calls[1][2] as AbortSignal).aborted).toBe(true);
    });
    it('closes the TUI if its engine ends first', async () => {
        let finish!: () => void;
        state.run.mockImplementationOnce(async (_options: SharedLaunchOptions, ready: (ready: RuntimeReady) => void) => {
            ready({ sessionId: 'sid', runtime }); await new Promise<void>(resolve => { finish = resolve; });
        });
        const running = runSharedCodex({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce()); finish(); await running;
        expect(state.kill).toHaveBeenCalledOnce();
    });
});
