import { afterEach, describe, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn()
}));

const spawnState = vi.hoisted(() => ({
    exitHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    closeHandlers: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
    stdinWrite: vi.fn<(chunk: string) => boolean>(() => true),
    exitCode: null as number | null
}));

vi.mock('./agentCliGuard', () => ({
    registerActiveAcpTransport: guard.register,
    unregisterActiveAcpTransport: guard.unregister
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        spawnState.exitHandlers = [];
        spawnState.closeHandlers = [];
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
                if (event === 'close') {
                    spawnState.closeHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
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
        spawnState.closeHandlers = [];
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
        spawnState.closeHandlers = [];
    });

    test('rejects new requests after the ACP process exits instead of throwing from stdin.write', async () => {
        const transport = new AcpStdioTransport({ command: 'gemini' });
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
        const transport = new AcpStdioTransport({ command: 'agent', args: ['acp'] });
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
            /ACP process exited \(code=1, signal=null\)\. stderr: Cannot use this model: grok-4\.5\[fast=true\]/
        );
    });

    test('keeps the head of long stderr so Cannot use this model survives Available models lists', async () => {
        const transport = new AcpStdioTransport({ command: 'agent', args: ['acp'] });
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

    test('reports Cannot use this model stderr via onStderrError with Cursor text intact', () => {
        const transport = new AcpStdioTransport({ command: 'agent', args: ['acp'] });
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

    test('rejects pending requests when stdin.write throws', async () => {
        spawnState.stdinWrite.mockImplementation(() => {
            throw new Error('WritableIterable is closed');
        });

        const transport = new AcpStdioTransport({ command: 'gemini' });
        await expect(transport.sendRequest('initialize')).rejects.toThrow('WritableIterable is closed');
        await expect(transport.sendRequest('session/new')).rejects.toThrow('WritableIterable is closed');
    });
});
