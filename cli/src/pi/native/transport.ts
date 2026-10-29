import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializePiNativeExtension } from './extension';
import { isRecord, PI_NATIVE_COMMANDS, PI_NATIVE_PROTOCOL_VERSION, PiNativeFrameParser, type PiNativeEvent } from './protocol';

export type { PiNativeEvent } from './protocol';

export interface PiNativeTransportOptions {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
}

interface PendingRequest {
    sessionId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Owns Pi's terminal process, but never reads or writes terminal streams. */
export class PiNativeTransport {
    private process: ChildProcess | null = null;
    private server: Server | null = null;
    private socket: Socket | null = null;
    private readonly peers = new Set<Socket>();
    private readonly token = randomBytes(32).toString('hex');
    private readonly pending = new Map<string, PendingRequest>();
    private sessionId: string | null = null;
    private sessionGeneration: number | null = null;
    private extensionDir: string | null = null;
    private startPromise: Promise<void> | null = null;
    private startupResolve: (() => void) | null = null;
    private startupReject: ((error: Error) => void) | null = null;
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    private ready = false;
    private disposed = false;
    private closeReported = false;
    private eventHandler: ((event: PiNativeEvent) => void) | null = null;
    private closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;

    constructor(private readonly options: PiNativeTransportOptions) {}

    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (this.disposed) return Promise.reject(new Error('Pi native transport is closed'));
        this.startPromise = new Promise<void>((resolve, reject) => {
            this.startupResolve = resolve;
            this.startupReject = reject;
        });
        this.startupTimer = setTimeout(() => {
            this.failStartup(new Error('Timed out waiting for the Pi native bridge. Check that Pi supports extensions.'));
            this.kill();
        }, this.options.startupTimeoutMs ?? 15_000);
        void this.launch().catch((error: unknown) => {
            this.failStartup(error instanceof Error ? error : new Error(String(error)));
            this.kill();
        });
        return this.startPromise;
    }

    private async launch(): Promise<void> {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-native-'));
        this.extensionDir = directory;
        if (this.disposed) { await this.cleanupDirectory(); return; }
        const extension = await materializePiNativeExtension(directory);
        if (this.disposed) { await this.cleanupDirectory(); return; }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        server.on('error', (error) => this.errorHandler?.(error));
        if (this.disposed) { server.close(); return; }
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Pi native loopback listener is unavailable');
        this.process = spawn(this.options.command, [...this.options.args, '--extension', extension], {
            cwd: this.options.cwd,
            stdio: 'inherit',
            env: {
                ...process.env,
                ...this.options.env,
                HAPI_PI_NATIVE_PORT: String(address.port),
                HAPI_PI_NATIVE_TOKEN: this.token
            }
        });
        this.process.once('error', (error) => {
            const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'Pi was not found on PATH. Please install Pi and retry.'
                : `Failed to start native Pi: ${error.message}`;
            this.failStartup(new Error(message));
            this.dispose(new Error(message));
        });
        this.process.once('close', (code, signal) => {
            this.failStartup(new Error(`Pi exited before the native bridge was ready (code=${code}, signal=${signal})`));
            this.dispose(new Error('Pi native process exited'));
            if (!this.closeReported) {
                this.closeReported = true;
                this.closeHandler?.(code, signal);
            }
        });
    }

    private accept(peer: Socket): void {
        if (this.disposed) { peer.destroy(); return; }
        this.peers.add(peer);
        const parser = new PiNativeFrameParser();
        let authenticated = false;
        const timer = setTimeout(() => peer.destroy(), 5000);
        timer.unref();
        peer.on('error', () => {});
        peer.on('close', () => {
            clearTimeout(timer);
            this.peers.delete(peer);
            if (this.socket !== peer) return;
            const previousSessionId = this.sessionId;
            this.socket = null;
            this.sessionId = null;
            this.sessionGeneration = null;
            this.rejectPending(new Error('Pi native IPC disconnected; command outcome may be unknown. Commands are not retried.'));
            // /reload, /new, /resume and /fork replace extension runtimes. Only
            // the actual child close event may end the terminal session.
            if (previousSessionId && !this.disposed) {
                this.eventHandler?.({ sessionId: previousSessionId, event: { type: 'bridge_disconnected' } });
            }
        });
        peer.on('data', (chunk: Buffer) => {
            try {
                parser.feed(chunk, (frame) => {
                    if (!authenticated) {
                        const token = typeof frame.token === 'string' ? Buffer.from(frame.token) : Buffer.alloc(0);
                        const expected = Buffer.from(this.token);
                        if (frame.kind !== 'hello' || frame.version !== PI_NATIVE_PROTOCOL_VERSION ||
                            token.length !== expected.length || !timingSafeEqual(token, expected) || (this.socket && !this.socket.destroyed)) {
                            throw new Error('Invalid Pi native IPC authentication');
                        }
                        authenticated = true;
                        clearTimeout(timer);
                        this.socket = peer;
                        peer.write(JSON.stringify({ kind: 'welcome', version: PI_NATIVE_PROTOCOL_VERSION }) + '\n');
                        return;
                    }
                    this.handleFrame(frame, peer);
                });
            } catch { peer.destroy(); }
        });
    }

    private handleFrame(frame: Record<string, unknown>, peer: Socket): void {
        if (this.socket !== peer) throw new Error('Inactive Pi native connection');
        if (frame.kind === 'event') {
            if (typeof frame.sessionId !== 'string' || !isRecord(frame.event) || typeof frame.event.type !== 'string') {
                throw new Error('Invalid Pi native event');
            }
            if (frame.event.type === 'session_start') {
                if (!isRecord(frame.event.state) || frame.event.state.sessionId !== frame.sessionId) throw new Error('Invalid Pi session state');
                if (this.sessionId !== frame.sessionId) this.rejectPending(new Error('Pi native session changed'));
                this.sessionId = frame.sessionId;
            } else if (this.sessionId !== frame.sessionId) {
                throw new Error('Pi event arrived before session_start');
            }
            if (isRecord(frame.event.state) && typeof frame.event.state.sessionGeneration === 'number') {
                const nextGeneration = frame.event.state.sessionGeneration;
                if (this.sessionGeneration !== null && this.sessionGeneration !== nextGeneration) {
                    this.rejectPending(new Error('Pi native session generation changed'));
                }
                this.sessionGeneration = nextGeneration;
            }
            this.eventHandler?.({ sessionId: frame.sessionId, event: frame.event });
        } else if (frame.kind === 'ready') {
            if (typeof frame.sessionId !== 'string' || frame.sessionId !== this.sessionId) throw new Error('Pi native bridge ready without session state');
            this.ready = true;
            if (this.startupTimer) clearTimeout(this.startupTimer);
            this.startupTimer = null;
            this.startupResolve?.();
            this.startupResolve = null;
            this.startupReject = null;
        } else if (frame.kind === 'response') {
            if (typeof frame.id !== 'string' || typeof frame.sessionId !== 'string' || typeof frame.success !== 'boolean') throw new Error('Invalid Pi response');
            const pending = this.pending.get(frame.id);
            if (!pending) return; // Late timeout response cannot fulfill a later request.
            this.pending.delete(frame.id);
            clearTimeout(pending.timer);
            if (pending.sessionId !== frame.sessionId || this.sessionId !== frame.sessionId) pending.reject(new Error('Stale Pi native response'));
            else if (frame.success) pending.resolve(frame.data);
            else pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'Pi native command failed'));
        } else {
            throw new Error('Unsupported Pi native IPC frame');
        }
    }

    request(command: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown> {
        if (!(PI_NATIVE_COMMANDS as readonly unknown[]).includes(command.type)) {
            return Promise.reject(new Error(`Unsupported Pi native command: ${String(command.type)}`));
        }
        const target = sessionId ?? this.sessionId;
        if (sessionId !== undefined && sessionId !== this.sessionId) return Promise.reject(new Error('Stale Pi native session'));
        if (command.sessionGeneration !== undefined && command.sessionGeneration !== this.sessionGeneration) {
            return Promise.reject(new Error('Stale Pi native session generation'));
        }
        const socket = this.socket;
        if (!socket || socket.destroyed || !target || this.disposed) return Promise.reject(new Error('Pi native bridge is disconnected'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Pi native command ${String(command.type)} timed out; outcome may be unknown. Commands are not retried.`));
            }, timeoutMs ?? this.options.requestTimeoutMs ?? 15_000);
            this.pending.set(id, { sessionId: target, resolve, reject, timer });
            try {
                socket.write(JSON.stringify({ kind: 'request', id, sessionId: target, command }) + '\n', (error) => {
                    if (!error) return;
                    const pending = this.pending.get(id);
                    if (!pending) return;
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(new Error(`Pi native command write failed: ${error.message}`));
                });
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    onEvent(handler: (event: PiNativeEvent) => void): void { this.eventHandler = handler; }
    onClose(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void { this.closeHandler = handler; }
    onError(handler: (error: Error) => void): void { this.errorHandler = handler; }

    kill(): void {
        if (this.disposed) return;
        this.failStartup(new Error('Pi native transport was stopped'));
        this.process?.kill('SIGTERM');
        this.dispose(new Error('Pi native transport was stopped'));
    }

    private failStartup(error: Error): void {
        if (this.ready || !this.startupReject) return;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.startupReject(error);
        this.startupResolve = null;
        this.startupReject = null;
        this.errorHandler?.(error);
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private dispose(error: Error): void {
        this.disposed = true;
        this.sessionId = null;
        this.sessionGeneration = null;
        this.rejectPending(error);
        for (const peer of this.peers) peer.destroy();
        this.socket = null;
        this.server?.close();
        void this.cleanupDirectory();
    }

    private async cleanupDirectory(): Promise<void> {
        if (!this.extensionDir) return;
        const directory = this.extensionDir;
        this.extensionDir = null;
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
}
