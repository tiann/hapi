import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';

/**
 * Filter out 'resume' subcommand which is managed internally by hapi.
 * Codex CLI format is `codex resume <session-id>`, so subcommand is always first.
 */
export function filterResumeSubcommand(args: string[]): string[] {
    if (args.length === 0 || args[0] !== 'resume') {
        return args;
    }

    // First arg is 'resume', filter it and optional session ID
    if (args.length > 1 && !args[1].startsWith('-')) {
        logger.debug(`[CodexLocal] Filtered 'resume ${args[1]}' - session managed by hapi`);
        return args.slice(2);
    }

    logger.debug(`[CodexLocal] Filtered 'resume' - session managed by hapi`);
    return args.slice(1);
}

export async function codexLocal(opts: {
    abort: AbortSignal;
    sessionId: string | null;
    path: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
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

    if (opts.codexArgs) {
        const safeArgs = filterResumeSubcommand(opts.codexArgs);
        args.push(...safeArgs);
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
        restoreTerminalState();
    }
}
