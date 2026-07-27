import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
    get spawn() { return mockSpawn; }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

function createMockProcess(): ChildProcessWithoutNullStreams & EventEmitter {
    const emitter = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stdin = new EventEmitter() as any;
    stdin.write = vi.fn().mockReturnValue(true);
    stdin.end = vi.fn();
    const stdout = new EventEmitter() as any;
    stdout.setEncoding = vi.fn();
    const stderr = new EventEmitter() as any;
    stderr.setEncoding = vi.fn();

    emitter.stdin = stdin;
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    emitter.kill = vi.fn().mockReturnValue(true);
    (emitter as any).pid = 12345;

    return emitter;
}

const { OmpTransport } = await import('./ompTransport');

describe('OmpTransport', () => {
    let mockProcess: ReturnType<typeof createMockProcess>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockProcess = createMockProcess();
        mockSpawn.mockReturnValue(mockProcess);
    });

    describe('start()', () => {
        it('spawns omp with the given command + args', () => {
            const transport = new OmpTransport({ command: '/path/to/omp', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();
            expect(mockSpawn).toHaveBeenCalledWith('/path/to/omp', ['--mode', 'rpc'], expect.objectContaining({
                cwd: '/work',
                stdio: ['pipe', 'pipe', 'pipe']
            }));
        });

        it('ignores double-start', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            transport.start();
            expect(mockSpawn).toHaveBeenCalledTimes(1);
        });

        it('emits error + rejects readyPromise on ENOENT (no 10s wait)', async () => {
            // OCR round 2/3: spawn ENOENT must reject ready() immediately
            // instead of waiting out the timeout (close event is not guaranteed).
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();

            const errorSpy = vi.fn();
            transport.onError(errorSpy);

            const readyP = transport.ready(10_000);
            const spawnError = new Error('spawn omp ENOENT') as NodeJS.ErrnoException;
            spawnError.code = 'ENOENT';
            mockProcess.emit('error', spawnError);

            await expect(readyP).rejects.toThrow(/not found/i);
            expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
        });
    });

    describe('ready() + ready-frame gate', () => {
        it('buffers sends until ready frame arrives, then flushes', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();

            // Sent before ready — must be buffered, not written.
            transport.send({ type: 'new_session' });
            expect(mockProcess.stdin.write).not.toHaveBeenCalled();

            // Push ready frame on stdout.
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            await transport.ready();

            // Buffered command flushed after ready.
            expect(mockProcess.stdin.write).toHaveBeenCalledWith(
                JSON.stringify({ type: 'new_session' }) + '\n'
            );
        });

        it('resolves ready() immediately if already ready', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            await transport.ready();
            // Second await must resolve immediately.
            await expect(transport.ready()).resolves.toBeUndefined();
        });

        it('does not flush buffered commands to a killed transport (markReady guard)', async () => {
            // OCR round 5: if ready() timed out and transport is being torn down,
            // a late ready frame must not flush commands to a dying process.
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            transport.send({ type: 'new_session' });
            transport.kill();
            // Now push a late ready frame — markReady must no-op due to killed guard.
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            // Give the event loop a tick to process.
            await new Promise(r => setTimeout(r, 10));
            expect(mockProcess.stdin.write).not.toHaveBeenCalled();
        });

        it('rejects ready() on timeout', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            await expect(transport.ready(50)).rejects.toThrow(/did not signal ready/i);
        });
    });

    describe('send()', () => {
        it('writes JSON to stdin when ready', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            await transport.ready();

            transport.send({ type: 'prompt', message: 'hi' });
            expect(mockProcess.stdin.write).toHaveBeenCalledWith(
                JSON.stringify({ type: 'prompt', message: 'hi' }) + '\n'
            );
        });

        it('drops messages when transport not running', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            // Not started — send must be a no-op (no throw, no write).
            expect(() => transport.send({ type: 'prompt', message: 'x' })).not.toThrow();
        });

        it('handles EPIPE on write gracefully', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            await transport.ready();

            mockProcess.stdin.write = vi.fn().mockImplementation(() => {
                const err = new Error('write EPIPE') as NodeJS.ErrnoException;
                err.code = 'EPIPE';
                throw err;
            });
            expect(() => transport.send({ type: 'prompt', message: 'x' })).not.toThrow();
        });
    });

    describe('onEvent() — JSONL parsing', () => {
        it('parses valid JSONL and calls handler (ready frame consumed by transport)', async () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            await transport.ready();

            const handler = vi.fn();
            transport.onEvent(handler);

            const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } };
            mockProcess.stdout.emit('data', JSON.stringify(event) + '\n');
            expect(handler).toHaveBeenCalledWith(event);
        });

        it('does not forward the ready frame to the event handler', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            const handler = vi.fn();
            transport.onEvent(handler);
            mockProcess.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n');
            expect(handler).not.toHaveBeenCalled();
        });

        it('skips malformed JSON without crashing', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            const handler = vi.fn();
            transport.onEvent(handler);
            mockProcess.stdout.emit('data', 'not-json\n');
            expect(handler).not.toHaveBeenCalled();
        });

        it('reassembles split JSONL across chunks', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            const handler = vi.fn();
            transport.onEvent(handler);
            const event = { type: 'turn_start' };
            const full = JSON.stringify(event) + '\n';
            mockProcess.stdout.emit('data', full.slice(0, 10));
            expect(handler).not.toHaveBeenCalled();
            mockProcess.stdout.emit('data', full.slice(10));
            expect(handler).toHaveBeenCalledWith(event);
        });
    });

    describe('kill()', () => {
        it('sends SIGTERM', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            transport.kill();
            expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
        });
        it('is a no-op when not running', () => {
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            expect(() => transport.kill()).not.toThrow();
        });
    });

    describe('onClose()', () => {
        it('calls handler with real code/signal from close event (not stolen by stdout end)', () => {
            // OCR round 3: stdout 'end' must NOT call closeHandler with (null,null)
            // before 'close' delivers the real code/signal.
            const transport = new OmpTransport({ command: 'omp', args: [], cwd: '/work' });
            transport.start();
            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.stdout.emit('end');
            // Within the 1s fallback window, close fires with the real code.
            mockProcess.emit('close', 1, null);
            expect(closeHandler).toHaveBeenCalledWith(1, null);
        });
    });
});
