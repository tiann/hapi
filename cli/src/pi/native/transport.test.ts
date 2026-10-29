import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { PiNativeFrameParser } from './protocol';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
import { PiNativeTransport } from './transport';

describe('PiNativeTransport', () => {
    let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
    const transports: PiNativeTransport[] = [];
    const sockets: Socket[] = [];

    beforeEach(() => {
        mockSpawn.mockReset();
        child = Object.assign(new EventEmitter(), { kill: vi.fn().mockReturnValue(true) });
        mockSpawn.mockReturnValue(child);
    });

    afterEach(() => {
        for (const socket of sockets.splice(0)) socket.destroy();
        for (const transport of transports.splice(0)) transport.kill();
    });

    function transport(startupTimeoutMs = 1000): PiNativeTransport {
        const result = new PiNativeTransport({ command: 'pi', args: ['--continue'], cwd: '/tmp', startupTimeoutMs });
        transports.push(result);
        return result;
    }

    async function peer(token?: string): Promise<{ socket: Socket; frames: Record<string, unknown>[] }> {
        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
        const env = mockSpawn.mock.calls[0][2].env;
        const socket = connect({ host: '127.0.0.1', port: Number(env.HAPI_PI_NATIVE_PORT) });
        sockets.push(socket);
        const frames: Record<string, unknown>[] = [];
        const parser = new PiNativeFrameParser();
        socket.on('data', (data: Buffer) => parser.feed(data, (frame) => frames.push(frame)));
        socket.on('error', () => {});
        await once(socket, 'connect');
        socket.write(JSON.stringify({ kind: 'hello', version: 1, token: token ?? env.HAPI_PI_NATIVE_TOKEN }) + '\n');
        return { socket, frames };
    }

    function announce(socket: Socket, sessionId = 'native-1'): void {
        socket.write(JSON.stringify({ kind: 'event', sessionId, event: { type: 'session_start', state: { sessionId, sessionGeneration: 1 } } }) + '\n');
        socket.write(JSON.stringify({ kind: 'ready', sessionId }) + '\n');
    }

    it('inherits terminal streams, materializes bundled source, authenticates before readiness', async () => {
        const instance = transport();
        const events = vi.fn();
        instance.onEvent(events);
        const started = instance.start();
        const wrong = await peer('wrong-token');
        await once(wrong.socket, 'close');
        expect(wrong.frames).toEqual([]);
        const valid = await peer();
        await vi.waitFor(() => expect(valid.frames[0]).toEqual({ kind: 'welcome', version: 1 }));
        announce(valid.socket);
        await started;
        const [command, args, options] = mockSpawn.mock.calls[0];
        expect(command).toBe('pi');
        expect(args.slice(0, 2)).toEqual(['--continue', '--extension']);
        expect(args.join(' ')).not.toContain(options.env.HAPI_PI_NATIVE_TOKEN);
        expect(options.stdio).toBe('inherit');
        expect(options.cwd).toBe('/tmp');
        expect(await readFile(args[2], 'utf8')).toContain('export default function hapiNativeBridge');
        expect((await stat(args[2])).mode & 0o777).toBe(0o600);
        expect(events).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-1' }));
        expect(instance.start()).toBe(started);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('correlates out-of-order replies and rejects stale and unsupported commands before writing', async () => {
        const instance = transport();
        const started = instance.start();
        const { socket, frames } = await peer();
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        announce(socket);
        await started;
        await expect(instance.request({ type: 'prompt', message: 'danger' }, 'old-session')).rejects.toThrow('Stale');
        await expect(instance.request({ type: 'new_session' })).rejects.toThrow('Unsupported');
        const first = instance.request({ type: 'get_state' }, 'native-1');
        const second = instance.request({ type: 'get_entries' }, 'native-1');
        await vi.waitFor(() => expect(frames).toHaveLength(3));
        expect(frames.slice(1).map((frame) => (frame.command as Record<string, unknown>).type)).toEqual(['get_state', 'get_entries']);
        for (const [frame, value] of [[frames[2], 'second'], [frames[1], 'first']] as const) {
            socket.write(JSON.stringify({ kind: 'response', id: frame.id, sessionId: 'native-1', success: true, data: value }) + '\n');
        }
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        const pending = instance.request({ type: 'abort' }, 'native-1');
        announce(socket, 'native-2');
        await expect(pending).rejects.toThrow('session changed');
        await expect(instance.request({ type: 'abort' }, 'native-1')).rejects.toThrow('Stale');
    });

    it('rejects pending requests on IPC loss, reconnects without replay, reports only child exit as close', async () => {
        const instance = transport();
        const closed = vi.fn();
        instance.onClose(closed);
        const started = instance.start();
        const first = await peer();
        await vi.waitFor(() => expect(first.frames).toHaveLength(1));
        announce(first.socket);
        await started;
        const pending = instance.request({ type: 'prompt', message: 'one' });
        await vi.waitFor(() => expect(first.frames).toHaveLength(2));
        first.socket.destroy();
        await expect(pending).rejects.toThrow('not retried');
        expect(closed).not.toHaveBeenCalled();
        const second = await peer();
        await vi.waitFor(() => expect(second.frames).toHaveLength(1));
        announce(second.socket, 'native-2');
        await vi.waitFor(() => expect(instance.request({ type: 'abort' }, 'native-1')).rejects.toThrow('Stale'));
        expect(second.frames.filter((frame) => frame.kind === 'request')).toEqual([]);
        child.emit('close', 7, null);
        child.emit('close', 7, null);
        expect(closed).toHaveBeenCalledExactlyOnceWith(7, null);
    });

    it('times out uncertain commands without replay or killing Pi', async () => {
        const instance = transport();
        const started = instance.start();
        const { socket, frames } = await peer();
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        announce(socket);
        await started;
        await expect(instance.request({ type: 'abort' }, 'native-1', 10)).rejects.toThrow('not retried');
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('rejects pending and later commands from an old branch epoch within the same native session', async () => {
        const instance = transport();
        const started = instance.start();
        const { socket, frames } = await peer();
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        announce(socket);
        await started;
        const pending = instance.request({ type: 'abort', sessionGeneration: 1 }, 'native-1');
        await vi.waitFor(() => expect(frames).toHaveLength(2));
        socket.write(JSON.stringify({ kind: 'event', sessionId: 'native-1', event: { type: 'session_tree', state: { sessionId: 'native-1', sessionGeneration: 2 } } }) + '\n');
        await expect(pending).rejects.toThrow('generation changed');
        await expect(instance.request({ type: 'abort', sessionGeneration: 1 }, 'native-1')).rejects.toThrow('Stale Pi native session generation');
        expect(frames.filter(frame => frame.kind === 'request')).toHaveLength(1);
    });

    it('fails startup on missing bridge and preserves the actual child exit status', async () => {
        const timed = transport(20);
        await expect(timed.start()).rejects.toThrow('Timed out');
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        mockSpawn.mockClear();
        const exited = transport();
        const closed = vi.fn();
        exited.onClose(closed);
        const started = exited.start();
        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
        child.emit('close', 3, null);
        await expect(started).rejects.toThrow('code=3');
        expect(closed).toHaveBeenCalledExactlyOnceWith(3, null);
    });

    it('fails startup with actionable spawn error', async () => {
        const instance = transport();
        const started = instance.start();
        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
        child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        await expect(started).rejects.toThrow('not found');
    });
});
