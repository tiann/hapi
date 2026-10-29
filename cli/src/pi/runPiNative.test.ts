import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    event: null as null | ((value: { sessionId: string; event: Record<string, unknown> }) => void),
    close: null as null | ((code: number | null, signal: NodeJS.Signals | null) => void),
    kill: vi.fn(), bootstrap: vi.fn(), initialize: vi.fn(), cleanup: vi.fn(), suspend: vi.fn(),
    restore: vi.fn(), clients: [] as Array<Record<string, unknown>>, lifecycles: [] as Array<Record<string, unknown>>,
}));

vi.mock('./native/transport', () => ({ PiNativeTransport: class {
    start = vi.fn(async () => {});
    kill = mocks.kill;
    request = vi.fn(async () => ({}));
    onEvent(callback: typeof mocks.event) { mocks.event = callback; }
    onClose(callback: typeof mocks.close) { mocks.close = callback; }
    onError() {}
} }));
vi.mock('./native/session', () => ({ PiNativeSessionBridge: class {
    initialize = mocks.initialize;
    suspend = mocks.suspend;
    deactivate = vi.fn();
    handleEvent = vi.fn();
    constructor(readonly client: Record<string, unknown>, readonly nativeSessionId: string) { mocks.clients.push(client); }
} }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: mocks.bootstrap, bootstrapExistingSession: mocks.bootstrap }));
vi.mock('@/agent/runnerLifecycle', () => ({ createRunnerLifecycle: (options: Record<string, unknown>) => {
    mocks.lifecycles.push(options);
    return { cleanup: mocks.cleanup, setArchiveReason: vi.fn(), setSessionEndReason: vi.fn() };
} }));
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }));
vi.mock('@/ui/terminalState', () => ({ restoreTerminalState: mocks.restore }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('./titleExtension', () => ({ materializePiTitleExtension: vi.fn(async () => '/tmp/title-extension.ts') }));
import { runPiNative, shouldUsePiNativeTui } from './runPiNative';

const start = (id: string, generation: number) => ({ sessionId: id, event: {
    type: 'session_start', state: { sessionId: id, sessionGeneration: generation },
} });

describe('Pi native launch selection', () => {
    it('requires both TTYs and a terminal launch, retaining explicit remote and Runner paths', () => {
        expect(shouldUsePiNativeTui({}, { stdin: true, stdout: true })).toBe(true);
        for (const terminal of [{ stdin: false, stdout: true }, { stdin: true, stdout: false }, { stdin: false, stdout: false }]) {
            expect(shouldUsePiNativeTui({ startingMode: 'local' }, terminal)).toBe(false);
        }
        expect(shouldUsePiNativeTui({ startedBy: 'runner' }, { stdin: true, stdout: true })).toBe(false);
        expect(shouldUsePiNativeTui({ startingMode: 'remote' }, { stdin: true, stdout: true })).toBe(false);
    });
});

describe('Pi native HAPI binding lifecycle', () => {
    let running: Promise<void> | undefined;
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.event = null;
        mocks.close = null;
        mocks.clients.length = 0;
        mocks.lifecycles.length = 0;
        mocks.initialize.mockResolvedValue(undefined);
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.bootstrap.mockImplementation(async () => ({
            session: { sessionId: `hapi-${mocks.bootstrap.mock.calls.length}`, rpcHandlerManager: {}, hubArchived: false },
        }));
    });
    afterEach(async () => {
        mocks.close?.(0, null);
        await running;
        running = undefined;
    });

    it('rotates HAPI identities on native /new and preserves TUI terminal modes until exit', async () => {
        running = runPiNative({ workingDirectory: '/tmp' });
        await vi.waitFor(() => expect(mocks.event).toBeTypeOf('function'));
        mocks.event?.(start('native-1', 1));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
        mocks.event?.({ sessionId: 'native-1', event: { type: 'session_shutdown', reason: 'new' } });
        mocks.event?.(start('native-2', 2));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(2));
        expect(mocks.clients.map(client => client.sessionId)).toEqual(['hapi-1', 'hapi-2']);
        expect(mocks.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.lifecycles.every(options => options.restoreTerminal === false)).toBe(true);
        expect(mocks.restore).not.toHaveBeenCalled();
        expect(mocks.kill).not.toHaveBeenCalled();
    });

    it('rebinds /reload to the same HAPI row without replaying history', async () => {
        running = runPiNative({ workingDirectory: '/tmp' });
        await vi.waitFor(() => expect(mocks.event).toBeTypeOf('function'));
        mocks.event?.(start('native-1', 1));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
        mocks.event?.({ sessionId: 'native-1', event: { type: 'session_shutdown', reason: 'reload' } });
        mocks.event?.(start('native-1', 2));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(2));
        expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
        expect(mocks.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ sessionGeneration: 2 }), false);
    });

    it('skips a superseded startup before any HAPI identity is created', async () => {
        running = runPiNative({ workingDirectory: '/tmp' });
        await vi.waitFor(() => expect(mocks.event).toBeTypeOf('function'));
        mocks.event?.(start('native-1', 1));
        mocks.event?.({ sessionId: 'native-1', event: { type: 'session_shutdown', reason: 'new' } });
        mocks.event?.(start('native-2', 2));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
        expect(mocks.clients).toHaveLength(1);
        expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-2' }), true);
    });

    it('rotates HAPI rows for /tree even when the native session ID is unchanged', async () => {
        running = runPiNative({ workingDirectory: '/tmp' });
        await vi.waitFor(() => expect(mocks.event).toBeTypeOf('function'));
        mocks.event?.(start('native-1', 1));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
        mocks.event?.({ sessionId: 'native-1', event: { type: 'session_tree', state: { sessionId: 'native-1', sessionGeneration: 2 } } });
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(2));
        expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
    });

    it('cleans the native child and HAPI binding after a wrapper-level crash', async () => {
        const baseline = new Set(process.listeners('uncaughtException'));
        running = runPiNative({ workingDirectory: '/tmp' });
        await vi.waitFor(() => expect(mocks.event).toBeTypeOf('function'));
        mocks.event?.(start('native-1', 1));
        await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());
        const crash = process.listeners('uncaughtException').find(listener => !baseline.has(listener));
        expect(crash).toBeTypeOf('function');
        const result = running.catch(error => error as Error);
        running = undefined;
        crash!(new Error('test wrapper crash'), 'uncaughtException');
        await expect(result).resolves.toMatchObject({ message: 'Pi native session exited with code 1' });
        expect(mocks.kill).toHaveBeenCalled();
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(process.listeners('uncaughtException')).not.toContain(crash);
    });
});
