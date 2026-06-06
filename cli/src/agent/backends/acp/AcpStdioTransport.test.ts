import { afterEach, describe, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn()
}));

vi.mock('./agentCliGuard', () => ({
    registerActiveAcpTransport: guard.register,
    unregisterActiveAcpTransport: guard.unregister
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        const proc = {
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
            stdin: { end: vi.fn(), write: vi.fn() },
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                handlers.set(`proc:${event}`, [...(handlers.get(`proc:${event}`) ?? []), handler]);
                if (event === 'exit') {
                    queueMicrotask(() => handler(0, null));
                }
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
