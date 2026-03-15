import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AcpStdioTransport } from './AcpStdioTransport';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process');

function makeFakeProcess() {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
    stdout.setEncoding = vi.fn();
    const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
    stderr.setEncoding = vi.fn();
    const proc = new EventEmitter() as EventEmitter & {
        stdin: typeof stdin;
        stdout: typeof stdout;
        stderr: typeof stderr;
        pid: number;
    };
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.pid = 12345;
    return proc;
}

describe('AcpStdioTransport.sendRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects immediately when signal is already aborted', async () => {
        const fakeProc = makeFakeProcess();
        vi.mocked(childProcess.spawn).mockReturnValue(fakeProc as unknown as ReturnType<typeof childProcess.spawn>);

        const transport = new AcpStdioTransport({ command: 'gemini' });
        const controller = new AbortController();
        controller.abort();

        await expect(
            transport.sendRequest('session/prompt', {}, { timeoutMs: Infinity, signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('clears the timeout timer when signal is already aborted', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        const fakeProc = makeFakeProcess();
        vi.mocked(childProcess.spawn).mockReturnValue(fakeProc as unknown as ReturnType<typeof childProcess.spawn>);

        const transport = new AcpStdioTransport({ command: 'gemini' });
        const controller = new AbortController();
        controller.abort();

        await expect(
            transport.sendRequest('session/prompt', {}, { timeoutMs: 1000, signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });

        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });

    it('rejects when signal fires after request is sent', async () => {
        const fakeProc = makeFakeProcess();
        vi.mocked(childProcess.spawn).mockReturnValue(fakeProc as unknown as ReturnType<typeof childProcess.spawn>);

        const transport = new AcpStdioTransport({ command: 'gemini' });
        const controller = new AbortController();

        const requestPromise = transport.sendRequest('session/prompt', {}, { timeoutMs: Infinity, signal: controller.signal });

        controller.abort();

        await expect(requestPromise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('resolves normally when response arrives before abort', async () => {
        const fakeProc = makeFakeProcess();
        vi.mocked(childProcess.spawn).mockReturnValue(fakeProc as unknown as ReturnType<typeof childProcess.spawn>);

        const transport = new AcpStdioTransport({ command: 'gemini' });
        const controller = new AbortController();

        const requestPromise = transport.sendRequest('session/prompt', {}, { timeoutMs: Infinity, signal: controller.signal });

        // Simulate Gemini CLI responding with id=1
        fakeProc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }) + '\n');

        await expect(requestPromise).resolves.toEqual({ stopReason: 'end_turn' });
    });
});
