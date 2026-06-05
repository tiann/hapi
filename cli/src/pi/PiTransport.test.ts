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
    emitter.pid = 12345;

    return emitter;
}

// Import after mock setup
const { PiTransport } = await import('./PiTransport');

describe('PiTransport', () => {
    let mockProcess: ReturnType<typeof createMockProcess>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockProcess = createMockProcess();
        mockSpawn.mockReturnValue(mockProcess);
    });

    describe('start()', () => {
        it('should spawn pi with correct args', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            expect(mockSpawn).toHaveBeenCalledWith('pi', ['--mode', 'rpc'], expect.objectContaining({
                cwd: '/work',
                stdio: ['pipe', 'pipe', 'pipe']
            }));
        });

        it('should emit error event on ENOENT', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const errorSpy = vi.fn();
            transport.onError(errorSpy);

            const spawnError = new Error('spawn pi ENOENT') as NodeJS.ErrnoException;
            spawnError.code = 'ENOENT';
            mockProcess.emit('error', spawnError);

            expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
            expect(errorSpy.mock.calls[0][0].message).toContain('not found');
        });
    });

    describe('send()', () => {
        it('should write JSON to stdin', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            transport.send({ type: 'prompt', message: 'hello' });
            expect(mockProcess.stdin.write).toHaveBeenCalledWith(
                JSON.stringify({ type: 'prompt', message: 'hello' }) + '\n'
            );
        });

        it('should handle EPIPE gracefully without throwing', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            mockProcess.stdin.write = vi.fn().mockImplementation(() => {
                const err = new Error('write EPIPE') as NodeJS.ErrnoException;
                err.code = 'EPIPE';
                throw err;
            });

            expect(() => transport.send({ type: 'prompt', message: 'test' })).not.toThrow();
        });
    });

    describe('onEvent()', () => {
        it('should parse valid JSONL from stdout and call handler', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } };
            mockProcess.stdout.emit('data', JSON.stringify(event) + '\n');

            expect(handler).toHaveBeenCalledWith(event);
        });

        it('should skip malformed JSON and not crash', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            mockProcess.stdout.emit('data', 'not-json\n');
            expect(handler).not.toHaveBeenCalled();
        });

        it('should handle multiple JSONL lines in one chunk', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            const event1 = { type: 'turn_start' };
            const event2 = { type: 'turn_end', message: {} };
            mockProcess.stdout.emit('data', JSON.stringify(event1) + '\n' + JSON.stringify(event2) + '\n');

            expect(handler).toHaveBeenCalledTimes(2);
            expect(handler).toHaveBeenCalledWith(event1);
            expect(handler).toHaveBeenCalledWith(event2);
        });
    });

    describe('kill()', () => {
        it('should send SIGTERM to the process', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            transport.kill();
            expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('should be a no-op when process is not running', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            expect(() => transport.kill()).not.toThrow();
        });
    });

    describe('onClose()', () => {
        it('should call handler when subprocess exits', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.emit('close', 1, null);
            expect(closeHandler).toHaveBeenCalledWith(1, null);
        });

        it('should call handler with signal when killed by signal', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.emit('close', null, 'SIGTERM');
            expect(closeHandler).toHaveBeenCalledWith(null, 'SIGTERM');
        });
    });

    describe('isRunning()', () => {
        it('should return false before start', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            expect(transport.isRunning()).toBe(false);
        });

        it('should return true after start', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();
            expect(transport.isRunning()).toBe(true);
        });

        it('should return false after process exits', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            mockProcess.emit('close', 0, null);
            expect(transport.isRunning()).toBe(false);
        });

        it('should return false after kill', () => {
            const transport = new PiTransport('pi', ['--mode', 'rpc'], '/work');
            transport.start();

            transport.kill();
            expect(transport.isRunning()).toBe(false);
        });
    });
});
