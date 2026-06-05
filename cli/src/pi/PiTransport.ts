import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';

export interface PiTransportOptions {
    command: string;
    args: string[];
    cwd: string;
}

export class PiTransport {
    private process: ChildProcessWithoutNullStreams | null = null;
    private eventHandler: ((event: Record<string, unknown>) => void) | null = null;
    private closeHandler: ((code: number | null, signal: string | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    private killed = false;
    private exited = false;
    private buffer = '';
    private readonly options: PiTransportOptions;

    constructor(command: string, args: string[], cwd: string) {
        this.options = { command, args, cwd };
    }

    start(): void {
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

    send(message: Record<string, unknown>): void {
        if (!this.process || this.killed) return;
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

    onEvent(handler: (event: Record<string, unknown>) => void): void {
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
                this.eventHandler?.(parsed as Record<string, unknown>);
            }
        } catch {
            logger.debug(`[pi] Skipping malformed JSON: ${line.slice(0, 100)}`);
        }
    }
}
