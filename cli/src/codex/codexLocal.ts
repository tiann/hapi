import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';

export async function codexLocal(opts: {
    abort: AbortSignal;
    sessionId: string | null;
    path: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('resume', opts.sessionId);
        opts.onSessionFound(opts.sessionId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.sandbox) {
        args.push('--sandbox', opts.sandbox);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    process.stdin.pause();
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn('codex', args, {
                stdio: ['inherit', 'inherit', 'inherit'],
                signal: opts.abort,
                cwd: opts.path,
                env: process.env
            });

            let abortKillTimeout: NodeJS.Timeout | null = null;
            const abortHandler = () => {
                if (abortKillTimeout) {
                    return;
                }
                abortKillTimeout = setTimeout(() => {
                    if (child.exitCode === null && !child.killed) {
                        logger.debug('[CodexLocal] Abort timeout reached, sending SIGKILL');
                        try {
                            child.kill('SIGKILL');
                        } catch (error) {
                            logger.debug('[CodexLocal] Failed to send SIGKILL:', error);
                        }
                    }
                }, 5000);
            };

            if (opts.abort.aborted) {
                abortHandler();
            } else {
                opts.abort.addEventListener('abort', abortHandler);
            }

            const cleanupAbortHandler = () => {
                if (abortKillTimeout) {
                    clearTimeout(abortKillTimeout);
                    abortKillTimeout = null;
                }
                opts.abort.removeEventListener('abort', abortHandler);
            };

            child.on('error', (error) => {
                cleanupAbortHandler();
                reject(error);
            });

            child.on('exit', (code, signal) => {
                cleanupAbortHandler();
                if (signal === 'SIGTERM' && opts.abort.aborted) {
                    resolve();
                    return;
                }
                if (signal) {
                    reject(new Error(`Process terminated with signal: ${signal}`));
                    return;
                }
                if (typeof code === 'number' && code !== 0) {
                    reject(new Error(`Process exited with code: ${code}`));
                    return;
                }
                resolve();
            });
        });
    } finally {
        process.stdin.resume();
    }
}
