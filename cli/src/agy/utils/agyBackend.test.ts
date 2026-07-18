import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
    AgyPrintBackend,
    buildAgyAttemptLogFile,
    buildAgyPrintArgs,
    classifyAgyFailure,
    extractAgyConversationIdFromLog,
    isNativeAgyConversationId
} from './agyBackend';

describe('AgyPrintBackend', () => {
    it('creates a provider-native conversation before returning a new session id', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => true);
        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            queueMicrotask(() => {
                const logIndex = args.indexOf('--log-file');
                writeFileSync(args[logIndex + 1], 'I Created conversation de582684-d186-4170-81ba-982809b4e28a\n');
                stdout.write('HAPI_IDENTITY_READY\n');
                child.emit('close', 0, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile: join(tmp, 'agy.log'),
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => 'bootstrap'
        });

        await expect(backend.newSession({ cwd: tmp, mcpServers: [] }))
            .resolves.toBe('de582684-d186-4170-81ba-982809b4e28a');
        expect(spawnCommand.mock.calls[0][1]).toEqual(expect.arrayContaining([
            '--print', expect.stringContaining('HAPI lifecycle identity bootstrap')
        ]));
    });

    it('confirms a resumed conversation through agy before returning its native id', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const nativeId = 'de582684-d186-4170-81ba-982809b4e28a';
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => true);
        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            queueMicrotask(() => {
                const logIndex = args.indexOf('--log-file');
                writeFileSync(args[logIndex + 1], `I GetConversationDetail: found conversation ${nativeId}\n`);
                stdout.write('HAPI_IDENTITY_READY\n');
                child.emit('close', 0, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile: join(tmp, 'agy.log'),
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => 'resume-bootstrap'
        });

        await expect(backend.loadSession({ cwd: tmp, mcpServers: [], sessionId: nativeId }))
            .resolves.toBe(nativeId);
        expect(spawnCommand.mock.calls[0][1]).toEqual(expect.arrayContaining([
            '--conversation', nativeId,
            '--print', expect.stringContaining('HAPI lifecycle identity bootstrap')
        ]));
    });

    it('rejects resume when agy does not confirm the requested native conversation', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const requestedId = 'de582684-d186-4170-81ba-982809b4e28a';
        const differentId = '37c8073d-f9d7-45eb-b63f-6e64cda9dd71';
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => true);
        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            queueMicrotask(() => {
                const logIndex = args.indexOf('--log-file');
                writeFileSync(args[logIndex + 1], `I GetConversationDetail: found conversation ${differentId}\n`);
                child.emit('close', 0, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile: join(tmp, 'agy.log'),
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => 'resume-mismatch'
        });

        await expect(backend.loadSession({ cwd: tmp, mcpServers: [], sessionId: requestedId }))
            .rejects.toThrow('did not confirm the requested native conversation UUID');
    });

    it('closes stdin for agy --print so the CLI can finish non-interactively', async () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const stdinEnd = vi.spyOn(stdin, 'end');
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => {
            child.killed = true;
            return true;
        });

        const spawnCommand = vi.fn(() => {
            queueMicrotask(() => {
                stdout.write('OK\n');
                child.emit('close', 0, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            model: 'Gemini 3.5 Flash (High)',
            cwd: '/tmp/hapi-agy-test',
            spawnCommand: spawnCommand as never
        });

        const messages: unknown[] = [];
        await backend.prompt('agy-session-1', [{ type: 'text', text: '只输出 OK' }], (message) => {
            messages.push(message);
        });

        expect(stdinEnd).toHaveBeenCalledOnce();
        expect(spawnCommand).toHaveBeenCalledWith(
            'agy',
            expect.arrayContaining(['--print', '只输出 OK']),
            expect.objectContaining({ cwd: '/tmp/hapi-agy-test' })
        );
        expect(messages).toContainEqual({ type: 'text', text: 'OK' });
        expect(messages).toContainEqual({ type: 'turn_complete', stopReason: 'completed' });
    });

    it('correctly decodes UTF-8 multi-byte characters split across chunk boundaries', async () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => {
            child.killed = true;
            return true;
        });

        const spawnCommand = vi.fn(() => {
            queueMicrotask(() => {
                // "测试" in UTF-8:
                // "测": E6 B5 8B
                // "试": E8 AF 95
                // We split "测" across two chunks:
                // Chunk 1: E6 B5 (incomplete)
                // Chunk 2: 8B E8 AF 95 (rest of "测" + "试")
                stdout.write(Buffer.from([0xE6, 0xB5]));
                stdout.write(Buffer.from([0x8B, 0xE8, 0xAF, 0x95]));
                child.emit('close', 0, null);
            });
            return child;
        });

        const backend = new AgyPrintBackend({
            model: 'Gemini 3.5 Flash (High)',
            cwd: '/tmp/hapi-agy-test',
            spawnCommand: spawnCommand as never
        });

        const messages: unknown[] = [];
        await backend.prompt('agy-session-2', [{ type: 'text', text: 'test' }], (message) => {
            messages.push(message);
        });

        expect(messages).toContainEqual({ type: 'text', text: '测试' });
        expect(messages).toContainEqual({ type: 'turn_complete', stopReason: 'completed' });
    });

    it('builds agy --print args for native workspace, log, resume, timeout, and real safe-yolo', () => {
        expect(buildAgyPrintArgs({
            additionalDirectories: ['/tmp/uploads', ' ', '/tmp/uploads', '/tmp/base'],
            conversationId: 'de582684-d186-4170-81ba-982809b4e28a',
            logFile: '/tmp/hapi/agy.log',
            model: 'Gemini 3.5 Flash (High)',
            permissionMode: 'safe-yolo',
            prompt: 'hello',
            timeout: '90s'
        })).toEqual([
            '--add-dir', '/tmp/uploads',
            '--add-dir', '/tmp/base',
            '--log-file', '/tmp/hapi/agy.log',
            '--conversation', 'de582684-d186-4170-81ba-982809b4e28a',
            '--model', 'Gemini 3.5 Flash (High)',
            '--sandbox',
            '--dangerously-skip-permissions',
            '--print-timeout', '90s',
            '--print', 'hello'
        ]);
    });

    it('defaults native agy print mode to a bounded 30-minute timeout', () => {
        expect(buildAgyPrintArgs({ prompt: 'hello' })).toEqual([
            '--print-timeout', '30m',
            '--print', 'hello'
        ]);
    });

    it('preserves the HAPI_AGY_PRINT_TIMEOUT environment override', () => {
        const previous = process.env.HAPI_AGY_PRINT_TIMEOUT;
        process.env.HAPI_AGY_PRINT_TIMEOUT = '45m';
        try {
            expect(buildAgyPrintArgs({ prompt: 'hello' })).toContain('45m');
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_AGY_PRINT_TIMEOUT;
            } else {
                process.env.HAPI_AGY_PRINT_TIMEOUT = previous;
            }
        }
    });

    it('derives a sanitized attempt log path next to the base log', () => {
        expect(buildAgyAttemptLogFile('/tmp/session.log.agy.log', 'attempt:1')).toBe(
            '/tmp/session.log.agy.attempt_1.log'
        );
    });

    it('does not classify failures unless both timeout and refresh-network signals are present', () => {
        expect(classifyAgyFailure(
            'Error: timeout waiting for response',
            'ordinary model timeout'
        )).toBe('Error: timeout waiting for response');
        expect(classifyAgyFailure(
            'Error: request rejected',
            'token refresh failed due to network error: TLS timeout'
        )).toBe('Error: request rejected');
    });

    it('does not pass synthetic HAPI agy session ids as native conversations', () => {
        expect(isNativeAgyConversationId('agy-123')).toBe(false);
        expect(buildAgyPrintArgs({
            conversationId: 'agy-123',
            prompt: 'hello'
        })).not.toContain('--conversation');
    });

    it('extracts the native Antigravity conversation id from current agy log lines', () => {
        expect(extractAgyConversationIdFromLog([
            'I project: created project "x" (id=3759ca70-e427-4c4f-91da-d6f4c2f6d11b)',
            'I Created conversation de582684-d186-4170-81ba-982809b4e28a',
            'I Print mode: conversation=37c8073d-f9d7-45eb-b63f-6e64cda9dd71, sending message'
        ].join('\n'))).toBe('37c8073d-f9d7-45eb-b63f-6e64cda9dd71');
    });

    it('stores a native conversation id observed in the unique agy attempt log for later resume', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const logFile = join(tmp, 'agy.log');
        const attemptLogFile = join(tmp, 'agy.attempt-1.log');

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            killed: boolean;
            kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        child.killed = false;
        child.kill = vi.fn(() => {
            child.killed = true;
            return true;
        });

        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            queueMicrotask(() => {
                const logIndex = args.indexOf('--log-file');
                writeFileSync(args[logIndex + 1], 'I Created conversation de582684-d186-4170-81ba-982809b4e28a\n');
                stdout.write('OK\n');
                child.emit('close', 0, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile,
            model: 'Gemini 3.5 Flash (High)',
            cwd: tmp,
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => 'attempt-1'
        });

        await backend.prompt('agy-synthetic-session', [{ type: 'text', text: '只输出 OK' }], () => {});

        expect(spawnCommand.mock.calls[0][1]).toContain(attemptLogFile);
        expect(backend.getLastNativeConversationId()).toBe('de582684-d186-4170-81ba-982809b4e28a');
    });

    it('uses a different discoverable log file for every prompt invocation', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const ids = ['attempt-1', 'attempt-2'];
        const spawnedArgs: string[][] = [];
        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            spawnedArgs.push(args);
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const stdin = new PassThrough();
            const child = new EventEmitter() as EventEmitter & {
                stdout: PassThrough;
                stderr: PassThrough;
                stdin: PassThrough;
                killed: boolean;
                kill: (signal?: NodeJS.Signals) => boolean;
            };
            child.stdout = stdout;
            child.stderr = stderr;
            child.stdin = stdin;
            child.killed = false;
            child.kill = vi.fn(() => true);
            queueMicrotask(() => child.emit('close', 0, null));
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile: join(tmp, 'agy.log'),
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => ids.shift() ?? 'unexpected'
        });

        await backend.prompt('agy-session', [{ type: 'text', text: 'first' }], () => {});
        await backend.prompt('agy-session', [{ type: 'text', text: 'second' }], () => {});

        const logFileFor = (args: string[]) => args[args.indexOf('--log-file') + 1];
        expect(spawnedArgs.map(logFileFor)).toEqual([
            join(tmp, 'agy.attempt-1.log'),
            join(tmp, 'agy.attempt-2.log')
        ]);
    });

    it('classifies token refresh network failures instead of reporting a generic response timeout', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hapi-agy-backend-'));
        const spawnCommand = vi.fn((_command: string, args: string[]) => {
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const stdin = new PassThrough();
            const child = new EventEmitter() as EventEmitter & {
                stdout: PassThrough;
                stderr: PassThrough;
                stdin: PassThrough;
                killed: boolean;
                kill: (signal?: NodeJS.Signals) => boolean;
            };
            child.stdout = stdout;
            child.stderr = stderr;
            child.stdin = stdin;
            child.killed = false;
            child.kill = vi.fn(() => true);
            queueMicrotask(() => {
                const logIndex = args.indexOf('--log-file');
                writeFileSync(
                    args[logIndex + 1],
                    'E token refresh failed due to network error: TLS handshake timeout secret=do-not-leak\n'
                );
                stderr.write('Error: timeout waiting for response\n');
                child.emit('close', 1, null);
            });
            return child;
        });
        const backend = new AgyPrintBackend({
            logFile: join(tmp, 'agy.log'),
            spawnCommand: spawnCommand as never,
            attemptLogIdFactory: () => 'refresh-failure'
        });

        await expect(backend.prompt('agy-session', [{ type: 'text', text: 'hello' }], () => {}))
            .rejects.toThrow(
                'auth_refresh_network_error: Antigravity token refresh failed due to a network error before the response completed'
            );
    });

    it('rejects non-native Antigravity conversation IDs before spawning agy', async () => {
        const backend = new AgyPrintBackend({});
        await expect(backend.loadSession({
            sessionId: 'agy-synthetic',
            cwd: '/tmp',
            mcpServers: []
        })).rejects.toThrow('native Antigravity conversation UUIDs');
    });
});
