import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { runtimePath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";


// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(runtimePath(), 'scripts', 'claude_local_launcher.cjs'))

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    allowedTools?: string[]
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Determine session ID strategy:
    // - If resuming an existing session: use --resume (Claude keeps the same session ID)
    // - If starting fresh: generate UUID and pass via --session-id
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Generate new session ID if not resuming
    const newSessionId = startFrom ? null : randomUUID();
    const effectiveSessionId = startFrom || newSessionId!;
    
    // Notify about session ID immediately (we know it upfront now!)
    if (newSessionId) {
        logger.debug(`[ClaudeLocal] Generated new session ID: ${newSessionId}`);
        opts.onSessionFound(newSessionId);
    } else {
        logger.debug(`[ClaudeLocal] Resuming session: ${startFrom}`);
        opts.onSessionFound(startFrom!);
    }

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []
            
            if (startFrom) {
                // Resume existing session (Claude preserves the session ID)
                args.push('--resume', startFrom)
            } else {
                // New session with our generated UUID
                args.push('--session-id', newSessionId!)
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

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure HAPI_PROJECT_ROOT is set correctly for development.');
            }

            // Prepare environment variables
            // Note: Local mode uses global Claude installation with --session-id flag
            const env = {
                ...process.env,
                ...opts.claudeEnvVars
            }

            logger.debug(`[ClaudeLocal] Spawning launcher: ${claudeCliPath}`);
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

            const child = spawn(process.execPath, [claudeCliPath, ...args], {
                stdio: ['inherit', 'inherit', 'inherit'],
                signal: opts.abort,
                cwd: opts.path,
                env: withBunRuntimeEnv(env),
            });
            child.on('error', (error) => {
                // Ignore
            });
            child.on('exit', (code, signal) => {
                if (signal === 'SIGTERM' && opts.abort.aborted) {
                    // Normal termination due to abort signal
                    r();
                } else if (signal) {
                    reject(new Error(`Process terminated with signal: ${signal}`));
                } else {
                    r();
                }
            });
        });
    } finally {
        process.stdin.resume();
    }

    return effectiveSessionId;
}
