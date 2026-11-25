import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { killProcessByChildProcess } from '@/utils/process';

/** Process-owned pipes survive individual turns. Each listener closes over this
 * instance so late output/close from a retired process cannot affect its replacement. */
export class AgyStreamProcess {
    onLine: ((line: string) => void) | null = null;
    onClose: ((code: number | null) => void) | null = null;
    onStderr: (() => void) | null = null;
    stderrTail = '';
    failure: string | null = null;
    closed = false;
    closeCode: number | null = null;
    retiring = false;
    private stdoutBuffer = '';
    private readonly closedPromise: Promise<void>;
    private retirement: Promise<void> | null = null;
    private endGrace: (() => void) | null = null;
    private forceRetirement = false;

    constructor(readonly child: ChildProcessWithoutNullStreams, readonly configKey: string) {
        let resolveClosed!: () => void;
        this.closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (this.closed) return;
            this.stdoutBuffer += chunk;
            const lines = this.stdoutBuffer.split('\n');
            this.stdoutBuffer = lines.pop() ?? '';
            for (const line of lines) this.onLine?.(line);
        });
        child.stderr.on('data', (chunk: string) => {
            if (this.closed) return;
            this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4096);
            this.onStderr?.();
        });
        child.stdout.on('error', () => {});
        child.stderr.on('error', () => {});
        child.stdin.on('error', (error: Error) => this.failWrite(error));
        child.on('error', (error: Error) => {
            this.failure ??= `Failed to start agy: ${error.message}`;
            this.retiring = true;
            // Node emits close after a spawn error. The turn stays attached until
            // then, including when no process was created (ENOENT).
        });
        child.on('close', (code: number | null) => {
            if (this.closed) return;
            // Preserve a valid final record even when EOF has no trailing newline.
            if (this.stdoutBuffer.trim()) this.onLine?.(this.stdoutBuffer);
            this.stdoutBuffer = '';
            this.closed = true;
            this.closeCode = code;
            this.retiring = true;
            resolveClosed();
            this.onClose?.(code);
        });
    }

    get reusable(): boolean {
        return !this.closed && !this.retiring && this.child.exitCode === null && this.child.signalCode == null;
    }

    writePrompt(prompt: string): void {
        try {
            this.child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n', (error) => {
                if (error) this.failWrite(error);
            });
        } catch (error) {
            this.failWrite(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private failWrite(error: Error): void {
        if (this.closed) return;
        this.failure ??= `Failed to write to agy: ${error.message}`;
        void this.retire();
    }

    retire(graceful = false): Promise<void> {
        this.retiring = true;
        if (!graceful) {
            this.forceRetirement = true;
            this.endGrace?.();
        }
        if (this.retirement) return this.retirement;
        this.retirement = Promise.resolve().then(async () => {
            if (this.closed) return;
            if (graceful && !this.forceRetirement && !this.child.stdin.destroyed) {
                try { this.child.stdin.end(); } catch { /* Fall through to tree kill. */ }
                await new Promise<void>((resolve) => {
                    const finish = () => { clearTimeout(timeout); this.endGrace = null; resolve(); };
                    const timeout = setTimeout(finish, 500);
                    this.endGrace = finish;
                    void this.closedPromise.then(finish);
                });
            }
            if (!this.closed && this.child.exitCode === null && this.child.signalCode == null) {
                const terminated = await killProcessByChildProcess(this.child);
                if (!terminated && !this.closed) this.child.kill('SIGKILL');
            }
            await this.closedPromise;
        });
        return this.retirement;
    }
}
