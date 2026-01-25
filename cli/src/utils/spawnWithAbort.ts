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

    // On Windows, use shell=false with .cmd extension to avoid cmd.exe argument parsing issues
    // When shell=true, cmd.exe can misinterpret special characters in arguments
    let command = options.command;
    let useShell = options.shell;
    if (process.platform === 'win32') {
        // For Windows, prefer direct spawn without shell
        if (useShell === undefined || useShell === true) {
            // Check if command is a simple name (no path separators) without extension
            if (!command.includes('.') && !command.includes('\\') && !command.includes('/')) {
                // Add .cmd extension for batch files (commonly used for npm CLI tools)
                command = `${command}.cmd`;
            }
            // Use shell=false for direct execution
            useShell = false;
        }
    }

    // Debug: Log spawn parameters
    logDebug(`Spawning: command=${command}, args.length=${options.args.length}, shell=${useShell}, platform=${process.platform}`);

    await new Promise<void>((resolve, reject) => {
        // Note: We intentionally do NOT pass signal to spawn() because Node.js's
        // built-in abort handling only kills the direct child, not grandchildren.
        // Instead, we handle abort ourselves using killProcessByChildProcess which
        // kills the entire process tree to prevent orphan processes.
        const child = spawn(command, options.args, {
            stdio,
            cwd: options.cwd,
            env: options.env,
            shell: useShell
        });

        let abortKillTimeout: NodeJS.Timeout | null = null;

        const abortHandler = () => {
            if (abortKillTimeout) {
                return;
            }
            // First, try graceful termination of entire process tree
            if (child.exitCode === null && !child.killed) {
                logDebug(`Abort signal received, killing process tree (pid=${child.pid}) with SIGTERM`);
                // Note: We don't await here because we're in a sync callback,
                // but killProcessByChildProcess now waits for processes to die internally
                void killProcessByChildProcess(child, false);
            }
            // Set timeout for forceful kill if graceful doesn't work
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
