import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { restoreTerminalState } from "@/ui/terminalState";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { systemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";

const isAbortError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const maybeError = error as { name?: string; code?: string };
    return maybeError.name === 'AbortError' || maybeError.code === 'ABORT_ERR';
};

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    allowedTools?: string[]
    hookSettingsPath: string
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if user passed explicit session control flags.
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);

    // Determine session strategy:
    // - If resuming an existing session: use --resume (unless user already supplied session control)
    // - If starting fresh: let Claude create a new session ID (reported via SessionStart hook)
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    if (opts.abort.aborted) {
        logger.debug('[ClaudeLocal] Abort already signaled before spawn; skipping launch');
        return startFrom ?? null;
    }

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []
            
            if (startFrom && !hasUserSessionControl) {
                // Resume existing session
                args.push('--resume', startFrom)
            }
            
            args.push('--append-system-prompt', systemPrompt);

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
            }

            if (opts.allowedTools && opts.allowedTools.length > 0) {
                args.push('--allowedTools', opts.allowedTools.join(','));
            }

            // Add custom Claude arguments
            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            // Add hook settings for session tracking
            args.push('--settings', opts.hookSettingsPath)
            logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);

            // Prepare environment variables
            // Note: Local mode uses global Claude installation
            const env = {
                ...process.env,
                DISABLE_AUTOUPDATER: '1',
                ...opts.claudeEnvVars
            }

            logger.debug('[ClaudeLocal] Spawning claude');
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

            const child = spawn('claude', args, {
                stdio: ['inherit', 'inherit', 'inherit'],
                signal: opts.abort,
                killSignal: 'SIGINT',
                cwd: opts.path,
                env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
                shell: process.platform === 'win32'
            });
            let settled = false;
            const abortTimeoutMs = {
                term: 1000,
                kill: 3000
            };
            let abortTermTimeout: NodeJS.Timeout | null = null;
            let abortKillTimeout: NodeJS.Timeout | null = null;
            let forcedTermination = false;
            let abortStartedAt: number | null = null;

            const isAlive = () => child.exitCode === null && !child.killed;
            const formatAbortElapsed = () => {
                if (abortStartedAt === null) {
                    return 'n/a';
                }
                return `${Date.now() - abortStartedAt}ms`;
            };

            const abortHandler = () => {
                if (abortTermTimeout || abortKillTimeout) {
                    logger.debug('[ClaudeLocal] Abort already in progress');
                    return;
                }
                abortStartedAt = Date.now();
                logger.debug('[ClaudeLocal] Abort signaled, waiting for SIGINT to exit');
                abortTermTimeout = setTimeout(() => {
                    if (isAlive()) {
                        forcedTermination = true;
                        logger.debug(`[ClaudeLocal] Abort timeout reached (${formatAbortElapsed()}), sending SIGTERM`);
                        try {
                            child.kill('SIGTERM');
                        } catch (error) {
                            logger.debug('[ClaudeLocal] Failed to send SIGTERM', error);
                        }
                    }

                    abortKillTimeout = setTimeout(() => {
                        if (isAlive()) {
                            forcedTermination = true;
                            logger.debug(`[ClaudeLocal] Abort timeout reached (${formatAbortElapsed()}), sending SIGKILL`);
                            try {
                                child.kill('SIGKILL');
                            } catch (error) {
                                logger.debug('[ClaudeLocal] Failed to send SIGKILL', error);
                            }
                        }
                    }, abortTimeoutMs.kill);
                }, abortTimeoutMs.term);
            };

            if (opts.abort.aborted) {
                abortHandler();
            } else {
                opts.abort.addEventListener('abort', abortHandler);
            }

            const cleanupAbortHandler = () => {
                if (abortTermTimeout) {
                    clearTimeout(abortTermTimeout);
                    abortTermTimeout = null;
                }
                if (abortKillTimeout) {
                    clearTimeout(abortKillTimeout);
                    abortKillTimeout = null;
                }
                opts.abort.removeEventListener('abort', abortHandler);
            };
            const finalize = (error?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupAbortHandler();
                if (error) {
                    reject(error);
                } else {
                    r();
                }
            };
            child.on('error', (error) => {
                if (opts.abort.aborted || isAbortError(error)) {
                    logger.debug('[ClaudeLocal] Spawn aborted while switching');
                    if (!child.pid) {
                        finalize();
                    }
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                finalize(new Error(`Failed to spawn claude: ${message}. Is Claude installed and on PATH?`));
            });
            child.on('exit', (code, signal) => {
                logger.debug(`[ClaudeLocal] Child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, aborted=${opts.abort.aborted}, forced=${forcedTermination}, elapsed=${formatAbortElapsed()})`);
                if ((signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGKILL') && opts.abort.aborted) {
                    // Normal termination due to abort signal
                    finalize();
                } else if (signal) {
                    finalize(new Error(`Process terminated with signal: ${signal}`));
                } else {
                    finalize();
                }
            });
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }

    return startFrom ?? null;
}
