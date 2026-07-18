import { afterEach, describe, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn()
}));

const spawnState = vi.hoisted(() => ({
    exitHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    stdoutDataHandlers: [] as Array<(chunk: string) => void>,
    stdinEnd: vi.fn(),
    stdinWrite: vi.fn<(chunk: string) => boolean>(() => true),
    kill: vi.fn(),
    exitCode: null as number | null
}));

vi.mock('./agentCliGuard', () => ({
    registerActiveAcpTransport: guard.register,
    unregisterActiveAcpTransport: guard.unregister
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => undefined)
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        spawnState.exitHandlers = [];
        spawnState.stdoutDataHandlers = [];
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        const proc = {
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
                handlers.set(`proc:${event}`, [...(handlers.get(`proc:${event}`) ?? []), handler]);
            }),
            kill: (...args: unknown[]) => spawnState.kill(...args)
        };
        return proc;
    })
}));

import { AcpStdioTransport } from './AcpStdioTransport';
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
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.stdinEnd.mockClear();
        spawnState.kill.mockClear();
        vi.mocked(killProcessByChildProcess).mockClear();
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
        spawnState.stdoutDataHandlers = [];
    });

    test('registers cross-process guard only for Cursor agent command', async () => {
        const transport = new AcpStdioTransport({ command: 'agent', args: ['acp'] });
        expect(guard.register).toHaveBeenCalledTimes(1);
        await transport.close();
        expect(guard.unregister).toHaveBeenCalledTimes(1);
    });

    test('does not register guard for non-agent ACP backends', () => {
        for (const command of ['gemini', 'opencode', 'kimi']) {
            guard.register.mockClear();
            guard.unregister.mockClear();
            new AcpStdioTransport({ command });
            expect(guard.register).not.toHaveBeenCalled();
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
        spawnState.stdoutDataHandlers = [];
    });

    test('ignores Cursor worktree banner and keeps JSON-RPC session alive', async () => {
        const transport = new AcpStdioTransport({ command: 'agent', args: ['acp'] });
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
        const transport = new AcpStdioTransport({ command: 'gemini' });
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
});

describe('AcpStdioTransport closed stdin writes', () => {
    afterEach(() => {
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
        spawnState.stdoutDataHandlers = [];
    });

    test('rejects new requests after the ACP process exits instead of throwing from stdin.write', async () => {
        const transport = new AcpStdioTransport({ command: 'gemini' });
        spawnState.exitCode = 1;
        spawnState.stdinWrite.mockImplementation(() => {
            throw new Error('WritableIterable is closed');
        });

        for (const handler of spawnState.exitHandlers) {
            handler(1, null);
        }

        await expect(transport.sendRequest('session/new')).rejects.toThrow(
            'ACP process exited (code=1, signal=null)'
        );
        expect(() => transport.sendNotification('session/cancel', {})).not.toThrow();
    });

    test('rejects pending requests when stdin.write throws', async () => {
        spawnState.stdinWrite.mockImplementation(() => {
            throw new Error('WritableIterable is closed');
        });

        const transport = new AcpStdioTransport({ command: 'gemini' });
        await expect(transport.sendRequest('initialize')).rejects.toThrow('WritableIterable is closed');
        await expect(transport.sendRequest('session/new')).rejects.toThrow('WritableIterable is closed');
    });
});
