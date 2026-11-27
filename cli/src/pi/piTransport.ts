import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveNodeCliLaunch } from '@/agent/agentLaunchCommand';
import { logger } from '@/ui/logger';
import { isWindows, killProcessByChildProcess } from '@/utils/process';
import { JsonLineParser } from '@/utils/jsonLineParser';
import { PiAgentEventSchema } from './schemas';
import type { PiAgentEvent, PiRpcCommand } from './types';

export interface PiTransportOptions {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
}

const PI_NOT_FOUND_MESSAGE = 'Pi was not found on PATH. Please install Pi and retry.';

export class PiTransport extends JsonLineParser {
    private process: ChildProcessWithoutNullStreams | null = null;
    private eventHandler: ((event: PiAgentEvent) => void) | null = null;
    private closeHandler: ((code: number | null, signal: string | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    private killed = false;
    private started = false;
    private exited = false;
    private closeReported = false;
    private readonly options: PiTransportOptions;

    constructor(options: PiTransportOptions) {
        super();
        this.options = options;
    }

    start(): void {
        if (this.started) {
            logger.warn('[pi] PiTransport.start() called twice — ignoring');
            return;
        }
        this.started = true;

        const launch = resolveNodeCliLaunch(this.options.command, this.options.env ?? process.env);
        if (!launch) {
            this.exited = true;
            process.nextTick(() => this.errorHandler?.(new Error(PI_NOT_FOUND_MESSAGE)));
            return;
        }
        const args = [...launch.args, ...this.options.args];

        logger.debug(`[pi] Starting Pi process: ${launch.command} ${args.join(' ')}`);

        this.process = spawn(launch.command, args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.options.env,
            windowsHide: isWindows()
        }) as ChildProcessWithoutNullStreams;

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk: string) => this.feed(chunk));
        this.process.stdout.on('end', () => {
            // stdout can end before ChildProcess emits `close`. Do not publish a
            // synthetic close here: doing so loses the real exit code and used to
            // invoke lifecycle cleanup twice. `close` below is the one authority.
            logger.debug('[pi] stdout ended; awaiting process close for exit status');
        });

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk: string) => {
            logger.debug(`[pi][stderr] ${chunk.toString().trim()}`);
        });

        this.process.on('close', (code, signal) => {
            logger.debug(`[pi] Process exited (code=${code}, signal=${signal})`);
            this.exited = true;
            if (this.closeReported) return;
            this.closeReported = true;
            this.closeHandler?.(code, signal);
        });

        this.process.on('error', (err) => {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                this.errorHandler?.(new Error(PI_NOT_FOUND_MESSAGE));
            } else {
                this.errorHandler?.(new Error(
                    `Failed to start Pi: ${nodeErr.message}`
                ));
            }
        });
    }

    send(message: PiRpcCommand): void {
        if (!this.process || this.killed || this.exited || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
            logger.debug('[pi] Dropping message: transport not running');
            return;
        }
        try {
            this.process.stdin.write(JSON.stringify(message) + '\n');
        } catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EPIPE') {
                logger.debug('[pi] EPIPE on write — process likely exited');
            } else {
                throw err;
            }
        }
    }

    onEvent(handler: (event: PiAgentEvent) => void): void {
        this.eventHandler = handler;
    }

    onClose(handler: (code: number | null, signal: string | null) => void): void {
        this.closeHandler = handler;
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandler = handler;
    }

    /** Resolves once the stop attempt is over, so callers can await it before exiting. */
    async kill(): Promise<void> {
        const child = this.process;
        if (!child || this.killed) return;
        this.killed = true;
        // Once Pi has exited its PID may be reused; never signal it again.
        if (this.exited || child.exitCode != null || child.signalCode != null) return;
        if (!isWindows()) {
            child.kill('SIGTERM');
            return;
        }
        // Windows has no SIGTERM for Pi to clean up on: child.kill() would
        // terminate Pi alone and orphan the tools it started.
        let treeStopped = false;
        try {
            treeStopped = await killProcessByChildProcess(child, true);
        } catch (error) {
            logger.warn(`[pi] Failed to stop Pi process tree (pid ${child.pid}): ${error}`);
        }
        if (treeStopped) return;
        logger.warn(`[pi] Pi process tree (pid ${child.pid}) not confirmed stopped; its tools may still be running`);
        // The handle stays bound to this process, unlike its PID.
        if (child.exitCode == null && child.signalCode == null) child.kill();
    }

    protected handleLine(line: string): void {
        try {
            const parsed = JSON.parse(line);
            const result = PiAgentEventSchema.safeParse(parsed);
            if (result.success) {
                this.eventHandler?.(result.data as PiAgentEvent);
            }
        } catch {
            logger.debug(`[pi] Skipping malformed JSON: ${line.slice(0, 100)}`);
        }
    }
}
