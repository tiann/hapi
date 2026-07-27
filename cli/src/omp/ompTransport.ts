import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { JsonLineParser } from '@/utils/jsonLineParser';
import { OmpAgentEventSchema } from './schemas';
import type { OmpAgentEvent, OmpRpcCommand } from './types';

export interface OmpTransportOptions {
    /** Resolved omp binary path (resolved by resolveOmpCommand). */
    command: string;
    args: string[];
    cwd: string;
}

/**
 * Resolve the omp binary path.
 *
 * `omp` is installed via `bun` and may not be on PATH (the `~/.bun/bin`
 * dir is not always in PATH even when the symlink exists). Resolution order:
 *   1. `~/.bun/bin/omp` symlink (bun global install)
 *   2. `omp` on PATH (spawn resolves it)
 *   3. explicit override via env `OMP_BIN`
 * Returns the bare command string for `spawn(command, args)`; spawn handles
 * PATH lookup when `command === 'omp'`, or uses the absolute path directly.
 */
export function resolveOmpCommand(): string {
    const override = process.env.OMP_BIN;
    if (override) return override;
    const bunBin = join(homedir(), '.bun', 'bin', 'omp');
    if (existsSync(bunBin)) return bunBin;
    // Fallback: let spawn resolve `omp` from PATH.
    return 'omp';
}

/** Default omp rpc-mode spawn args. `--approval-mode=yolo` = auto-approve tools
 *  (OMP rpc mode has no runtime tool-approval round-trip). */
export function defaultOmpArgs(extra: string[] = []): string[] {
    return ['--mode', 'rpc', '--approval-mode', 'yolo', ...extra];
}

export class OmpTransport extends JsonLineParser {
    private process: ChildProcessWithoutNullStreams | null = null;
    private eventHandler: ((event: OmpAgentEvent) => void) | null = null;
    private closeHandler: ((code: number | null, signal: string | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    private killed = false;
    private started = false;
    private exited = false;
    private readonly options: OmpTransportOptions;

    // OMP pushes `{"type":"ready"}` before accepting commands. Buffer sends
    // until ready so the initial handshake (new_session/get_state/...) isn't
    // dropped. `await transport.ready()` resolves on ready or rejects on
    // timeout (10s) / close-before-ready.
    private readyResolve: (() => void) | null = null;
    private readyReject: ((err: Error) => void) | null = null;
    private readyTimer: NodeJS.Timeout | null = null;
    private isReady = false;
    private readonly pendingSends: OmpRpcCommand[] = [];

    constructor(options: OmpTransportOptions) {
        super();
        this.options = options;
    }

    start(): void {
        if (this.started) {
            logger.warn('[omp] OmpTransport.start() called twice — ignoring');
            return;
        }
        this.started = true;

        logger.debug(`[omp] Starting OMP process: ${this.options.command} ${this.options.args.join(' ')}`);

        this.process = spawn(this.options.command, this.options.args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams;

        this.process.stdout.setEncoding('utf8');
        // Register an 'error' listener on stdin so an async EPIPE (process died
        // mid-write) doesn't crash the host as an unhandled stream error. The
        // sync try/catch in write() only catches synchronous throw.
        this.process.stdin.on('error', (err) => {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EPIPE') {
                logger.debug('[omp] stdin EPIPE — process likely exited');
            } else {
                logger.debug(`[omp] stdin error: ${nodeErr.message}`);
            }
        });
        this.process.stdout.on('data', (chunk: string) => this.feed(chunk));
        this.process.stdout.on('end', () => {
            // stdout 'end' almost always fires before ChildProcess 'close' in
            // Node.js. Do NOT call closeHandler here — let 'close' deliver the
            // real exit code/signal. This is only a fallback in case 'close'
            // never fires (shouldn't happen with stdio:'pipe', but guards
            // against edge cases so the host isn't left waiting).
            if (!this.exited && !this.killed) {
                logger.debug('[omp] stdout ended — awaiting process close for exit code');
                setTimeout(() => {
                    if (!this.exited && !this.killed) {
                        logger.debug('[omp] close event did not fire after stdout end — forcing exit');
                        this.exited = true;
                        this.closeHandler?.(null, null);
                    }
                }, 1000);
            }
        });

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk: string) => {
            logger.debug(`[omp][stderr] ${chunk.toString().trim()}`);
        });

        this.process.on('close', (code, signal) => {
            logger.debug(`[omp] Process exited (code=${code}, signal=${signal})`);
            // stdout 'end' may have already surfaced the exit + called closeHandler;
            // guard so the handler fires exactly once.
            const alreadyExited = this.exited;
            this.exited = true;
            if (!this.isReady) {
                this.readyReject?.(new Error(`OMP process exited before ready (code=${code}, signal=${signal})`));
            }
            this.clearReadyTimer();
            if (!alreadyExited) {
                this.closeHandler?.(code, signal);
            }
        });

        this.process.on('error', (err) => {
            const nodeErr = err as NodeJS.ErrnoException;
            // Spawn failure (e.g. ENOENT) may not always trigger a 'close'
            // event, so reject the ready promise immediately rather than
            // waiting out the 10s timeout.
            const spawnErr = nodeErr.code === 'ENOENT'
                ? new Error(`OMP was not found. Install it via 'bun install -g @oh-my-pi/pi-coding-agent' and retry.`)
                : new Error(`Failed to start OMP: ${nodeErr.message}`);
            this.readyReject?.(spawnErr);
            this.clearReadyTimer();
            this.errorHandler?.(spawnErr);
        });
    }

    /**
     * Wait for OMP's `ready` frame. Resolves once ready; rejects on 10s
     * timeout or process exit before ready. Safe to await before sending
     * the initial handshake commands.
     */
    ready(timeoutMs = 10_000): Promise<void> {
        if (this.isReady) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            this.readyTimer = setTimeout(() => {
                this.readyReject?.(new Error(`OMP did not signal ready within ${timeoutMs}ms`));
                this.readyResolve = null;
                this.readyReject = null;
            }, timeoutMs);
        });
    }

    private clearReadyTimer(): void {
        if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
        }
    }

    private markReady(): void {
        if (this.isReady) return;
        // If ready() already timed out / the transport is being torn down, do
        // not flip to ready or flush buffered commands to a dying process.
        if (this.killed) return;
        this.isReady = true;
        this.clearReadyTimer();
        // Flush any commands buffered before ready.
        const buffered = this.pendingSends.splice(0);
        for (const cmd of buffered) this.write(cmd);
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
    }

    send(message: OmpRpcCommand): void {
        if (!this.process || this.killed) {
            logger.debug('[omp] Dropping message: transport not running');
            return;
        }
        // Buffer until OMP signals ready — commands sent before ready are dropped by OMP.
        if (!this.isReady) {
            this.pendingSends.push(message);
            return;
        }
        this.write(message);
    }

    private write(message: OmpRpcCommand): void {
        try {
            this.process!.stdin.write(JSON.stringify(message) + '\n');
        } catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EPIPE') {
                logger.debug('[omp] EPIPE on write — process likely exited');
            } else {
                throw err;
            }
        }
    }

    onEvent(handler: (event: OmpAgentEvent) => void): void {
        this.eventHandler = handler;
    }

    onClose(handler: (code: number | null, signal: string | null) => void): void {
        this.closeHandler = handler;
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandler = handler;
    }

    kill(): void {
        if (!this.process || this.killed) return;
        this.killed = true;
        this.clearReadyTimer();
        this.process.kill('SIGTERM');
    }

    protected handleLine(line: string): void {
        try {
            const parsed = JSON.parse(line);
            // `ready` frame is consumed by the transport itself (handshake gate).
            if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'ready') {
                logger.debug('[omp] ready frame received');
                this.markReady();
                return;
            }
            const result = OmpAgentEventSchema.safeParse(parsed);
            if (result.success) {
                this.eventHandler?.(result.data as OmpAgentEvent);
            } else {
                logger.debug(`[omp] Event schema mismatch (type=${(parsed as { type?: string }).type ?? 'unknown'}): ${result.error.message.slice(0, 200)}`);
            }
        } catch {
            logger.debug(`[omp] Skipping malformed JSON: ${line.slice(0, 100)}`);
        }
    }
}
