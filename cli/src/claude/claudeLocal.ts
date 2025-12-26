import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { restoreTerminalState } from "@/ui/terminalState";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { systemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { spawnWithAbort } from "@/utils/spawnWithAbort";

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

            logger.debug(`[ClaudeLocal] Spawning claude with args: ${JSON.stringify(args)}`);

            spawnWithAbort({
                command: 'claude',
                args,
                cwd: opts.path,
                env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
                signal: opts.abort,
                logLabel: 'ClaudeLocal',
                spawnName: 'claude',
                installHint: 'Claude CLI',
                includeCause: true,
                logExit: true,
                shell: process.platform === 'win32'
            }).then(r).catch(reject);
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }

    return startFrom ?? null;
}
