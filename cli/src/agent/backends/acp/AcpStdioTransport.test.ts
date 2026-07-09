import { afterEach, describe, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn()
}));

const spawnState = vi.hoisted(() => ({
    exitHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    stdinWrite: vi.fn<(chunk: string) => boolean>(() => true),
    exitCode: null as number | null
}));

vi.mock('./agentCliGuard', () => ({
    registerActiveAcpTransport: guard.register,
    unregisterActiveAcpTransport: guard.unregister
}));

vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
    spawn: vi.fn(() => {
        spawnState.exitHandlers = [];
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        const proc = {
            get exitCode() {
                return spawnState.exitCode;
            },
            stdout: {
                setEncoding: vi.fn(),
                on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
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
                end: vi.fn(),
                write: (chunk: string) => spawnState.stdinWrite(chunk)
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                if (event === 'exit') {
                    spawnState.exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
                }
                handlers.set(`proc:${event}`, [...(handlers.get(`proc:${event}`) ?? []), handler]);
            }),
            kill: vi.fn()
        };
        return proc;
    })
}));

import { AcpStdioTransport } from './AcpStdioTransport';

describe('AcpStdioTransport agent CLI guard', () => {
    afterEach(() => {
        guard.register.mockClear();
        guard.unregister.mockClear();
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
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

describe('AcpStdioTransport closed stdin writes', () => {
    afterEach(() => {
        spawnState.stdinWrite.mockReset();
        spawnState.stdinWrite.mockReturnValue(true);
        spawnState.exitCode = null;
        spawnState.exitHandlers = [];
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
