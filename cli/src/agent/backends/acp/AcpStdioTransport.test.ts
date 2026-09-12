import { afterEach, describe, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
    recordChildPid: vi.fn(),
    getLockDir: vi.fn(() => '/tmp/test-hapi/locks/agent-acp-active'),
    isActive: vi.fn(() => true),
    describeState: vi.fn((childPid?: number | null) => ({
        lockDir: '/tmp/test-hapi/locks/agent-acp-active',
        inProcessCount: 1,
        childPid: childPid ?? null,
        childAlive: false,
        guardActive: true
    }))
}));

const spawnState = vi.hoisted(() => ({
    exitHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    closeHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    stdoutDataHandlers: [] as Array<(chunk: string) => void>,
    stdinEnd: vi.fn(),
    stdinWrite: vi.fn<(chunk: string) => boolean>(() => true),
    kill: vi.fn(),
    exitCode: null as number | null,
    pid: 424242 as number | undefined,
    spawnCallOrder: [] as string[]
}));

vi.mock('./agentCliGuard', () => ({
    registerActiveAcpTransport: (...args: unknown[]) => {
        spawnState.spawnCallOrder.push('register');
        return guard.register(...args);
    },
    unregisterActiveAcpTransport: guard.unregister,
    recordActiveAcpChildPid: guard.recordChildPid,
    getAgentAcpLockDir: guard.getLockDir,
    isAgentAcpTransportActive: guard.isActive,
    describeAgentAcpGuardState: guard.describeState
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => undefined)
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        spawnState.spawnCallOrder.push('spawn');
        spawnState.exitHandlers = [];
        spawnState.closeHandlers = [];
        spawnState.stdoutDataHandlers = [];
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        const proc = {
            get pid() {
                return spawnState.pid;
            },
            get exitCode() {
                return spawnState.exitCode;
            },
            stdout: {
                setEncoding: vi.fn(),
                on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                    if (event === 'data') {
                        spawnState.stdoutDataHandlers.push(handler as (chunk: string) => void);
                    }
                    handlers.set(`stdout:${event}`, [...(handlers.get(`stdout:${event}`) ?? []), handler]);
                })
            },
            stderr: {
                setEncoding: vi.fn(),
                on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                    handlers.set(`stderr:${event}`, [...(handlers.get(`stderr:${event}`) ?? []), handler]);
                })
            },
            stdin: {
                end: (...args: unknown[]) => spawnState.stdinEnd(...args),
                write: (chunk: string) => spawnState.stdinWrite(chunk)
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                if (event === 'exit') {
                    spawnState.exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
                }
                if (event === 'close') {
                    spawnState.closeHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
                }
                handlers.set(`proc:${event}`, [...(handlers.get(`proc:${event}`) ?? []), handler]);
            }),
            kill: (...args: unknown[]) => spawnState.kill(...args)
        };
        return proc;
    })
}));

import { AcpStdioTransport, isAcpIndeterminateError } from './AcpStdioTransport';
import { killProcessByChildProcess } from '@/utils/process';

function emitStdout(chunk: string): void {
    for (const handler of spawnState.stdoutDataHandlers) {
        handler(chunk);
    }
}

describe('AcpStdioTransport agent CLI guard', () => {
    afterEach(() => {
        guard.register.mockClear();
        guard.unregister.mockClear();
        guard.recordChildPid.mockClear();
        guard.getLockDir.mockClear();
        guard.isActive.mockClear();
        guard.describeState.mockClear();
        guard.describeState.mockImplementation((childPid?: number | null) => ({
            lockDir: '/tmp/test-hapi/locks/agent-acp-active',
            inProcessCount: 1,
            childPid: childPid ?? null,
            childAlive: false,
            guardActive: true
        }));
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.stdinEnd.mockClear();
        spawnState.kill.mockClear();
        vi.mocked(killProcessByChildProcess).mockClear();
        spawnState.exitCode = null;
        spawnState.pid = 424242;
        spawnState.spawnCallOrder = [];
        spawnState.exitHandlers = [];
        spawnState.closeHandlers = [];
        spawnState.stdoutDataHandlers = [];
    });

    test('registers cross-process guard only for Cursor agent command', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        expect(guard.register).toHaveBeenCalledTimes(1);
        expect(guard.recordChildPid).toHaveBeenCalledWith(424242);
        await transport.close();
        expect(guard.unregister).toHaveBeenCalledTimes(1);
        expect(guard.unregister).toHaveBeenCalledWith({ childPid: 424242 });
    });

    test('registers the ACP guard before spawn so list-models cannot race the new child', async () => {
        spawnState.spawnCallOrder = [];
        await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        expect(spawnState.spawnCallOrder.indexOf('register')).toBeGreaterThanOrEqual(0);
        expect(spawnState.spawnCallOrder.indexOf('spawn')).toBeGreaterThan(
            spawnState.spawnCallOrder.indexOf('register')
        );
    });

    test('keeps the ACP guard held across exit until close drains stdio', async () => {
        await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        guard.unregister.mockClear();

        for (const handler of spawnState.exitHandlers) {
            handler(143, null);
        }
        expect(guard.unregister).not.toHaveBeenCalled();

        for (const handler of spawnState.closeHandlers) {
            handler(143, null);
        }
        expect(guard.unregister).toHaveBeenCalledTimes(1);
        expect(guard.unregister).toHaveBeenCalledWith({ childPid: 424242 });
    });

    test('does not register guard for non-agent ACP backends', async () => {
        for (const command of ['gemini', 'opencode', 'kimi']) {
            guard.register.mockClear();
            guard.unregister.mockClear();
            guard.recordChildPid.mockClear();
            await AcpStdioTransport.create({ command });
            expect(guard.register).not.toHaveBeenCalled();
            expect(guard.recordChildPid).not.toHaveBeenCalled();
            expect(guard.unregister).not.toHaveBeenCalled();
        }
    });
});

describe('AcpStdioTransport plain-text stdout', () => {
    afterEach(() => {
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.stdinEnd.mockClear();
        vi.mocked(killProcessByChildProcess).mockClear();
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
        spawnState.closeHandlers = [];
        spawnState.stdoutDataHandlers = [];
    });

    test('ignores Cursor worktree banner and keeps JSON-RPC session alive', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const notifications: Array<{ method: string; params: unknown }> = [];
        transport.onNotification((method, params) => {
            notifications.push({ method, params });
        });

        const pending = transport.sendRequest('initialize', { protocolVersion: 1 });

        emitStdout('Using worktree: /home/heavygee/.cursor/worktrees/driver/acp\n');
        emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: 1 }
        })}\n`);

        await expect(pending).resolves.toEqual({ protocolVersion: 1 });
        expect(spawnState.stdinEnd).not.toHaveBeenCalled();
        expect(killProcessByChildProcess).not.toHaveBeenCalled();

        emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionUpdate: 'agent_message_chunk' }
        })}\n`);
        expect(notifications).toEqual([{
            method: 'session/update',
            params: { sessionUpdate: 'agent_message_chunk' }
        }]);

        await transport.close();
    });

    test('ignores non-object JSON lines without killing the session', async () => {
        const transport = await AcpStdioTransport.create({ command: 'gemini' });
        const pending = transport.sendRequest('initialize');

        emitStdout('42\n');
        emitStdout('"hello"\n');
        emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { ok: true }
        })}\n`);

        await expect(pending).resolves.toEqual({ ok: true });
        expect(spawnState.stdinEnd).not.toHaveBeenCalled();
        expect(killProcessByChildProcess).not.toHaveBeenCalled();
        await transport.close();
    });

    test('treats unknown non-JSON stdout as a fatal protocol error', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const pending = transport.sendRequest('initialize');

        expect(spawnState.stdoutDataHandlers.length).toBeGreaterThan(0);
        emitStdout('not-a-json-rpc-frame\n');
        expect(spawnState.stdinEnd).toHaveBeenCalled();

        await expect(pending).rejects.toThrow('Failed to parse JSON-RPC from ACP agent');
        expect(killProcessByChildProcess).toHaveBeenCalled();
        await expect(transport.sendRequest('session/new')).rejects.toThrow(
            'Failed to parse JSON-RPC from ACP agent'
        );
    });
});

describe('AcpStdioTransport closed stdin writes', () => {
    afterEach(() => {
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.stdinEnd.mockClear();
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
        spawnState.closeHandlers = [];
        spawnState.stdoutDataHandlers = [];
    });

    test('rejects new requests after process exit before close without writing stdin', async () => {
        const transport = await AcpStdioTransport.create({ command: 'gemini' });
        spawnState.exitCode = 1;
        spawnState.stdinWrite.mockClear();

        for (const handler of spawnState.exitHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/new')).rejects.toThrow(
            'ACP process exited (code=1, signal=null)'
        );
        expect(spawnState.stdinWrite).not.toHaveBeenCalled();
        expect(() => transport.sendNotification('session/cancel', {})).not.toThrow();
        expect(spawnState.stdinWrite).not.toHaveBeenCalled();

        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }
    });

    test('rejects new requests after the ACP process exits instead of throwing from stdin.write', async () => {
        const transport = await AcpStdioTransport.create({ command: 'gemini' });
        spawnState.exitCode = 1;
        spawnState.stdinWrite.mockImplementation(() => {
            throw new Error('WritableIterable is closed');
        });

        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/new')).rejects.toThrow(
            'ACP process exited (code=1, signal=null)'
        );
        expect(() => transport.sendNotification('session/cancel', {})).not.toThrow();
    });

    test('includes recent stderr on process close so callers can classify model rejection', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);
        expect(stderrHandlers.length).toBeGreaterThan(0);

        for (const handler of stderrHandlers) {
            handler('Cannot use this model: grok-4.5[fast=true]. Available models: auto, composer-2.5\n');
        }

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /ACP process exited \(code=1, signal=null(?:, childPid=\d+, lock=[^)]+)?\)\. stderr: Cannot use this model: grok-4\.5\[fast=true\]/
        );
    });

    test('accumulates split stderr chunks so Cannot use this model survives a catalog follow-up chunk', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        for (const handler of stderrHandlers) {
            handler('Cannot use this model: grok-4.5[fast=true]. Available models: auto, ');
            handler('composer-2.5, cursor-grok-4.5-high-fast\n');
        }

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /Cannot use this model: grok-4\.5\[fast=true\][\s\S]*Available models:[\s\S]*composer-2\.5/
        );
    });

    test('preserves Cannot use this model when the keyword itself is split across chunks', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        const seen: Array<{ type: string; message: string }> = [];
        transport.onStderrError((error) => {
            seen.push({ type: error.type, message: error.message });
        });

        for (const handler of stderrHandlers) {
            handler('Cannot use this mo');
            handler('del: grok-4.5[fast=true]. Available models: auto\n');
        }

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /Cannot use this model: grok-4\.5\[fast=true\]/
        );
        expect(seen.some((entry) => /Cannot use this model: grok-4\.5\[fast=true\]/.test(entry.message))).toBe(true);
    });

    test('waits for the model id before emitting Cannot use this model via onStderrError', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        const seen: string[] = [];
        transport.onStderrError((error) => {
            seen.push(error.message);
        });

        for (const handler of stderrHandlers) {
            handler('Cannot use this model: ');
            expect(seen).toEqual([]);
            handler('stale-id. Available models: auto\n');
        }

        expect(seen).toEqual([
            'Cannot use this model: stale-id. Available models: auto'
        ]);

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }
        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /Cannot use this model: stale-id/
        );
    });

    test('pins Cannot use this model head when Available models catalog exceeds the rolling window', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        const hugeCatalog = Array.from({ length: 2_000 }, (_, i) => `model-${i}`).join(', ');
        for (const handler of stderrHandlers) {
            handler(`Cannot use this model: stale-id. Available models: ${hugeCatalog}\n`);
        }

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /Cannot use this model: stale-id/
        );
    });

    test('keeps the head of long stderr so Cannot use this model survives Available models lists', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        const longCatalog = Array.from({ length: 400 }, (_, i) => `model-${i}`).join(', ');
        for (const handler of stderrHandlers) {
            handler(`Cannot use this model: stale-id. Available models: ${longCatalog}\n`);
        }

        spawnState.exitCode = 1;
        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/load')).rejects.toThrow(
            /Cannot use this model: stale-id/
        );
    });

    test('reports Cannot use this model stderr via onStderrError with Cursor text intact', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent', args: ['acp'] });
        const seen: Array<{ type: string; message: string; raw: string }> = [];
        transport.onStderrError((error) => {
            seen.push(error);
        });

        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        for (const handler of stderrHandlers) {
            handler('Cannot use this model: grok-4.5[fast=true]. Available models: auto\n');
        }

        expect(seen).toEqual([{
            type: 'model_not_found',
            message: 'Cannot use this model: grok-4.5[fast=true]. Available models: auto',
            raw: 'Cannot use this model: grok-4.5[fast=true]. Available models: auto'
        }]);
    });

    test.each([
        ['status 401', 'authentication'],
        ['status 404', 'model_not_found'],
        ['Cannot use this model: stale-id', 'model_not_found'],
        ['unexpected error', 'unknown']
    ])('reports newline-free %s stderr immediately', async (chunk, type) => {
        const transport = await AcpStdioTransport.create({ command: 'agent' });
        const seen: Array<{ type: string }> = [];
        transport.onStderrError((error) => seen.push(error));
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const handlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (value: string) => void);

        for (const handler of handlers) handler(chunk);

        expect(seen.map((error) => error.type)).toEqual([type]);
    });

    test('reports a completed non-HTTP/2 cancellation record', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent' });
        const seen: Array<{ type: string; message: string; raw: string }> = [];
        transport.onStderrError((error) => seen.push(error));
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const handlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (value: string) => void);

        for (const handler of handlers) handler('Error: request canceled by provider\n');

        expect(seen).toEqual([{
            type: 'unknown',
            message: 'Error: request canceled by provider',
            raw: 'Error: request canceled by provider'
        }]);
    });

    test('parses stall signatures split across stderr chunks without waiting for close', async () => {
        const transport = await AcpStdioTransport.create({ command: 'opencode' });
        const seen: Array<{ type: string; message: string; raw: string }> = [];
        transport.onStderrError((error) => {
            seen.push(error);
        });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const stderrHandlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (chunk: string) => void);

        for (const handler of stderrHandlers) {
            handler('provider unavailable, retry');
            handler('ing in 30 seconds\n');
            handler('Error: T: [canceled] ht');
            handler('tp/2 stream closed with error code CANCEL (0x8)');
        }

        expect(seen).toEqual([
            {
                type: 'unknown',
                message: 'The ACP agent is retrying after an upstream failure. The turn may be stalled.',
                raw: 'provider unavailable, retrying in 30 seconds'
            },
            {
                type: 'unknown',
                message: 'Upstream request was cancelled. The agent may be retrying or stalled.',
                raw: 'Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)'
            }
        ]);

        for (const handler of spawnState.closeHandlers) {
            handler(1, null);
        }

        expect(seen).toEqual([
            {
                type: 'unknown',
                message: 'The ACP agent is retrying after an upstream failure. The turn may be stalled.',
                raw: 'provider unavailable, retrying in 30 seconds'
            },
            {
                type: 'unknown',
                message: 'Upstream request was cancelled. The agent may be retrying or stalled.',
                raw: 'Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)'
            }
        ]);
    });

    test('bounds newline-free unclassified stderr tails', async () => {
        const transport = await AcpStdioTransport.create({ command: 'agent' });
        const proc = (transport as unknown as { process: {
            stderr: { on: ReturnType<typeof vi.fn> };
        } }).process;
        const handlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
            .filter((call) => call[0] === 'data')
            .map((call) => call[1] as (value: string) => void);

        for (const handler of handlers) handler('x'.repeat(20_000));

        const buffer = (transport as unknown as { stderrParseBuffer: string }).stderrParseBuffer;
        expect(buffer.length).toBeLessThanOrEqual(8_000);
    });

    test('bounds a stalled stdin dispatch and rejects both promises', async () => {
        vi.useFakeTimers();
        try {
            const transport = await AcpStdioTransport.create({ command: 'gemini' });
            const request = transport.sendRequestWithDispatch('session/prompt', {}, {
                timeoutMs: Infinity,
                dispatchTimeoutMs: 10
            });
            let dispatchError: unknown;
            let completedError: unknown;
            const dispatch = request.dispatched.catch((error) => { dispatchError = error; });
            const completed = request.completed.catch((error) => { completedError = error; });
            await vi.advanceTimersByTimeAsync(10);
            await dispatch;
            await completed;
            expect(isAcpIndeterminateError(dispatchError)).toBe(true);
            expect(isAcpIndeterminateError(completedError)).toBe(true);
            await transport.close();
        } finally {
            vi.useRealTimers();
        }
    });

    test('rejects pending requests when stdin.write throws', async () => {
        spawnState.stdinWrite.mockImplementation(() => {
            throw new Error('WritableIterable is closed');
        });

        const transport = await AcpStdioTransport.create({ command: 'gemini' });
        await expect(transport.sendRequest('initialize')).rejects.toThrow('WritableIterable is closed');
        await expect(transport.sendRequest('session/new')).rejects.toThrow('WritableIterable is closed');
    });
});
