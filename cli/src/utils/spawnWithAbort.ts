import { spawn, type SpawnOptions, type StdioOptions } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';

const DEFAULT_ABORT_EXIT_CODES = [130, 137, 143];
const DEFAULT_ABORT_SIGNALS: NodeJS.Signals[] = ['SIGTERM'];

const isAbortError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const maybeError = error as { name?: string; code?: string };
    return maybeError.name === 'AbortError' || maybeError.code === 'ABORT_ERR';
};

export type SpawnWithAbortOptions = {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    logLabel: string;
    spawnName: string;
    installHint: string;
    abortKillTimeoutMs?: number;
    abortExitCodes?: number[];
    abortSignals?: NodeJS.Signals[];
    includeCause?: boolean;
    logExit?: boolean;
    shell?: SpawnOptions['shell'];
    stdio?: StdioOptions;
};

export async function spawnWithAbort(options: SpawnWithAbortOptions): Promise<void> {
    const abortKillTimeoutMs = options.abortKillTimeoutMs ?? 5000;
    const abortExitCodes = options.abortExitCodes ?? DEFAULT_ABORT_EXIT_CODES;
    const abortSignals = options.abortSignals ?? DEFAULT_ABORT_SIGNALS;
    const stdio = options.stdio ?? ['inherit', 'inherit', 'inherit'];
    const logPrefix = options.logLabel ? `[${options.logLabel}] ` : '';

    const logDebug = (message: string, ...args: unknown[]) => {
        logger.debug(`${logPrefix}${message}`, ...args);
    };

    await new Promise<void>((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            stdio,
            signal: options.signal,
            cwd: options.cwd,
            env: options.env,
            shell: options.shell
        });

        let abortKillTimeout: NodeJS.Timeout | null = null;

        const abortHandler = () => {
            if (abortKillTimeout) {
                return;
            }
            abortKillTimeout = setTimeout(() => {
                if (child.exitCode === null && !child.killed) {
                    logDebug('Abort timeout reached, sending SIGKILL');
                    try {
                        void killProcessByChildProcess(child, true);
                    } catch (error) {
                        logDebug('Failed to send SIGKILL', error);
                    }
                }
            }, abortKillTimeoutMs);
        };

        if (options.signal.aborted) {
            abortHandler();
        } else {
            options.signal.addEventListener('abort', abortHandler);
        }

        const cleanupAbortHandler = () => {
            if (abortKillTimeout) {
                clearTimeout(abortKillTimeout);
                abortKillTimeout = null;
            }
            options.signal.removeEventListener('abort', abortHandler);
        };

        child.on('error', (error) => {
            cleanupAbortHandler();
            if (options.signal.aborted && isAbortError(error)) {
                logDebug('Spawn aborted while switching');
                if (!child.pid) {
                    resolve();
                }
                return;
            }
            if (options.signal.aborted) {
                resolve();
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const errorMessage = `Failed to spawn ${options.spawnName}: ${message}. ` +
                `Is ${options.installHint} installed and on PATH?`;
            if (options.includeCause) {
                reject(new Error(errorMessage, { cause: error }));
            } else {
                reject(new Error(errorMessage));
            }
        });

        child.on('exit', (code, signal) => {
            cleanupAbortHandler();
            if (options.logExit) {
                logDebug(`Child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, aborted=${options.signal.aborted})`);
            }
            if (options.signal.aborted && signal && abortSignals.includes(signal)) {
                resolve();
                return;
            }
            if (options.signal.aborted && typeof code === 'number' && abortExitCodes.includes(code)) {
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
}
