import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import type { PiAgentEvent, PiRpcCommand } from './types';

export interface PiTransportOptions {
    command: string;
    args: string[];
    cwd: string;
}

export class PiTransport {
    private process: ChildProcessWithoutNullStreams | null = null;
    private eventHandler: ((event: PiAgentEvent) => void) | null = null;
    private closeHandler: ((code: number | null, signal: string | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    private killed = false;
    private started = false;
    private exited = false;
    private buffer = '';
    private readonly options: PiTransportOptions;

    constructor(options: PiTransportOptions) {
        this.options = options;
    }

    start(): void {
        if (this.started) {
            logger.warn('[pi] PiTransport.start() called twice — ignoring');
            return;
        }
        this.started = true;

        logger.debug(`[pi] Starting Pi process: ${this.options.command} ${this.options.args.join(' ')}`);

        this.process = spawn(this.options.command, this.options.args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams;

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk: string) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk: string) => {
            logger.debug(`[pi][stderr] ${chunk.toString().trim()}`);
        });

        this.process.on('close', (code, signal) => {
            logger.debug(`[pi] Process exited (code=${code}, signal=${signal})`);
            this.exited = true;
            this.closeHandler?.(code, signal);
        });

        this.process.on('error', (err) => {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                this.errorHandler?.(new Error(
                    `Pi was not found on PATH. Please install Pi and retry.`
                ));
            } else {
                this.errorHandler?.(new Error(
                    `Failed to start Pi: ${nodeErr.message}`
                ));
            }
        });
    }

    send(message: PiRpcCommand): void {
        if (!this.process || this.killed) {
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

    kill(): void {
        if (!this.process || this.killed) return;
        this.killed = true;
        this.process.kill('SIGTERM');
    }

    isRunning(): boolean {
        return this.process !== null && !this.killed && !this.exited;
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
                this.handleLine(line);
            }

            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    private handleLine(line: string): void {
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed === 'object' && parsed !== null) {
                this.eventHandler?.(parsed as PiAgentEvent);
            }
        } catch {
            logger.debug(`[pi] Skipping malformed JSON: ${line.slice(0, 100)}`);
        }
    }
}
