import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
    get spawn() { return mockSpawn; }
}));

type Launch = { command: string; args: string[] } | null;
const mockResolveNodeCliLaunch = vi.fn((command: string, _env?: unknown): Launch => ({ command, args: [] }));
vi.mock('@/agent/agentLaunchCommand', () => ({
    resolveNodeCliLaunch: (command: string, env?: unknown) => mockResolveNodeCliLaunch(command, env)
}));

const mockIsWindows = vi.fn(() => false);
const mockKillProcessByChildProcess = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@/utils/process', () => ({
    isWindows: () => mockIsWindows(),
    killProcessByChildProcess: (...args: unknown[]) => mockKillProcessByChildProcess(...args)
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
    // pid is read-only in ChildProcess, use type assertion for mock
    (emitter as any).pid = 12345;

    return emitter;
}

const { PiTransport } = await import('./piTransport');

describe('PiTransport', () => {
    let mockProcess: ReturnType<typeof createMockProcess>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockIsWindows.mockReturnValue(false);
        mockResolveNodeCliLaunch.mockImplementation((command: string) => ({ command, args: [] }));
        mockKillProcessByChildProcess.mockResolvedValue(true);
        mockProcess = createMockProcess();
        mockSpawn.mockReturnValue(mockProcess);
    });

    describe('start()', () => {
        it('should spawn pi with correct args', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            expect(mockSpawn).toHaveBeenCalledWith('pi', ['--mode', 'rpc'], expect.objectContaining({
                cwd: '/work',
                stdio: ['pipe', 'pipe', 'pipe']
            }));
        });

        it('starts the resolved launcher with its script ahead of the Pi args', () => {
            mockIsWindows.mockReturnValue(true);
            mockResolveNodeCliLaunch.mockReturnValue({
                command: 'C:\\Program Files\\nodejs\\node.exe',
                args: ['C:\\npm\\node_modules\\pi\\cli.js']
            });
            const env = { Path: 'C:\\npm' };
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '\\\\server\\share', env });
            transport.start();

            expect(mockResolveNodeCliLaunch).toHaveBeenCalledWith('pi', env);
            expect(mockSpawn).toHaveBeenCalledWith(
                'C:\\Program Files\\nodejs\\node.exe',
                ['C:\\npm\\node_modules\\pi\\cli.js', '--mode', 'rpc'],
                expect.objectContaining({ cwd: '\\\\server\\share', env, windowsHide: true })
            );
        });

        it('reports not-found without spawning when no runnable Pi is found', async () => {
            mockResolveNodeCliLaunch.mockReturnValue(null);
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            const errorSpy = vi.fn();
            transport.onError(errorSpy);
            transport.start();
            transport.send({ type: 'get_state' });

            expect(mockSpawn).not.toHaveBeenCalled();
            await new Promise((resolve) => process.nextTick(resolve));
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy.mock.calls[0][0].message).toContain('not found');
            await expect(transport.kill()).resolves.toBeUndefined();
        });

        it('should emit error event on ENOENT', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const errorSpy = vi.fn();
            transport.onError(errorSpy);

            const spawnError = new Error('spawn pi ENOENT') as NodeJS.ErrnoException;
            spawnError.code = 'ENOENT';
            mockProcess.emit('error', spawnError);

            expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
            expect(errorSpy.mock.calls[0][0].message).toContain('not found');
        });

        it('should ignore double-start call', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();
            expect(mockSpawn).toHaveBeenCalledTimes(1);

            transport.start();
            expect(mockSpawn).toHaveBeenCalledTimes(1);
        });
    });

    describe('send()', () => {
        it('should write JSON to stdin', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            transport.send({ type: 'prompt', message: 'hello' });
            expect(mockProcess.stdin.write).toHaveBeenCalledWith(
                JSON.stringify({ type: 'prompt', message: 'hello' }) + '\n'
            );
        });

        it('should handle EPIPE gracefully without throwing', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
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
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } };
            mockProcess.stdout.emit('data', JSON.stringify(event) + '\n');

            expect(handler).toHaveBeenCalledWith(event);
        });

        it('should skip malformed JSON and not crash', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            mockProcess.stdout.emit('data', 'not-json\n');
            expect(handler).not.toHaveBeenCalled();
        });

        it('should handle multiple JSONL lines in one chunk', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
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

        it('should buffer and reassemble split JSONL across chunks', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const handler = vi.fn();
            transport.onEvent(handler);

            const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } };
            const fullLine = JSON.stringify(event) + '\n';

            // Split the line into two chunks — no newline in first chunk
            mockProcess.stdout.emit('data', fullLine.slice(0, 20));
            expect(handler).not.toHaveBeenCalled();

            // Send the rest with newline
            mockProcess.stdout.emit('data', fullLine.slice(20));
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(event);
        });
    });

    describe('kill()', () => {
        it('should send SIGTERM to the process', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            transport.kill();
            expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
            expect(mockKillProcessByChildProcess).not.toHaveBeenCalled();
        });

        it('stops Pi together with its tools on Windows and resolves only after the stop settles', async () => {
            mockIsWindows.mockReturnValue(true);
            let finishStop!: (stopped: boolean) => void;
            mockKillProcessByChildProcess.mockReturnValue(new Promise<boolean>((resolve) => { finishStop = resolve; }));
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            let settled = false;
            const stopping = transport.kill().then(() => { settled = true; });
            await transport.kill();
            expect(mockKillProcessByChildProcess).toHaveBeenCalledTimes(1);
            expect(mockKillProcessByChildProcess).toHaveBeenCalledWith(mockProcess, true);
            expect(mockProcess.kill).not.toHaveBeenCalled();

            await Promise.resolve();
            expect(settled).toBe(false);
            finishStop(true);
            await stopping;
            expect(settled).toBe(true);
        });

        it('still terminates Pi through its handle when the Windows tree stop is not confirmed', async () => {
            mockIsWindows.mockReturnValue(true);
            mockKillProcessByChildProcess.mockResolvedValue(false);
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            await transport.kill();
            expect(mockProcess.kill).toHaveBeenCalledTimes(1);
        });

        it('still terminates Pi through its handle when the Windows tree stop throws', async () => {
            mockIsWindows.mockReturnValue(true);
            mockKillProcessByChildProcess.mockRejectedValue(new Error('powershell blocked'));
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            await transport.kill();
            expect(mockProcess.kill).toHaveBeenCalledTimes(1);
        });

        it('does not signal a Pi process that has already exited (PID may be reused)', async () => {
            mockIsWindows.mockReturnValue(true);
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();
            mockProcess.emit('close', 0, null);

            await transport.kill();
            expect(mockKillProcessByChildProcess).not.toHaveBeenCalled();
            expect(mockProcess.kill).not.toHaveBeenCalled();
        });

        it('does not signal a child that reported exit before close', async () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();
            (mockProcess as any).exitCode = 1;

            await transport.kill();
            expect(mockProcess.kill).not.toHaveBeenCalled();
        });

        it('should be a no-op when process is not running', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            expect(() => transport.kill()).not.toThrow();
        });
    });

    describe('onClose()', () => {
        it('does not report stdout end as a synthetic close before the real exit code', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();
            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.stdout.emit('end');
            expect(closeHandler).not.toHaveBeenCalled();
            mockProcess.emit('close', 7, null);
            mockProcess.emit('close', 7, null);
            expect(closeHandler).toHaveBeenCalledTimes(1);
            expect(closeHandler).toHaveBeenCalledWith(7, null);
        });

        it('should call handler when subprocess exits', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.emit('close', 1, null);
            expect(closeHandler).toHaveBeenCalledWith(1, null);
        });

        it('should call handler with signal when killed by signal', () => {
            const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: '/work' });
            transport.start();

            const closeHandler = vi.fn();
            transport.onClose(closeHandler);

            mockProcess.emit('close', null, 'SIGTERM');
            expect(closeHandler).toHaveBeenCalledWith(null, 'SIGTERM');
        });
    });
});
