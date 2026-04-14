import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { systemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { spawnWithTerminalGuard } from "@/utils/spawnWithTerminalGuard";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { stripNewlinesForWindowsShellArg } from "@/utils/shellEscape";
import { getDefaultClaudeCodePath } from "./sdk/utils";

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

    // Build args for Claude CLI
    const args: string[] = [];

    if (startFrom && !hasUserSessionControl) {
        // Resume existing session
        args.push('--resume', startFrom);
    }

    args.push('--append-system-prompt', stripNewlinesForWindowsShellArg(systemPrompt));

    const cleanupMcpConfig = appendMcpConfigArg(args, opts.mcpServers, {
        baseDir: projectDir
    });

    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }

    // Add custom Claude arguments
    if (opts.claudeArgs) {
        args.push(...opts.claudeArgs);
    }

    // Add hook settings for session tracking
    args.push('--settings', opts.hookSettingsPath);
    logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);

    // Add blobs directory for file upload access
    args.push('--add-dir', getHapiBlobsDir());
    logger.debug(`[ClaudeLocal] Adding blobs directory: ${getHapiBlobsDir()}`);

    // Prepare environment variables
    // Note: Local mode uses global Claude installation
    //
    // SDK metadata extraction (extractSDKMetadataAsync → query()) sets
    // CLAUDE_CODE_ENTRYPOINT='sdk-ts' on the current process. If leaked
    // into the local spawn, Claude Code thinks it was SDK-launched and
    // excludes the session from `claude --resume`. Destructure it out
    // so the child uses its own default entrypoint.
    const { CLAUDE_CODE_ENTRYPOINT: _, ...cleanEnv } = process.env
    const env = {
        ...cleanEnv,
        DISABLE_AUTOUPDATER: '1',
        ...opts.claudeEnvVars
    }

    logger.debug(`[ClaudeLocal] Spawning claude with args: ${JSON.stringify(args)}`);

    // Get Claude executable path (absolute path on Windows for shell: false)
    const claudeCommand = getDefaultClaudeCodePath();
    logger.debug(`[ClaudeLocal] Using claude executable: ${claudeCommand}`);

    // Spawn the process
    try {
        await spawnWithTerminalGuard({
            command: claudeCommand,
            args,
            cwd: opts.path,
            env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
            signal: opts.abort,
            logLabel: 'ClaudeLocal',
            spawnName: 'claude',
            installHint: 'Claude CLI',
            includeCause: true,
            logExit: true,
            shell: false  // Use absolute path, no shell needed
        });
    } finally {
        cleanupMcpConfig?.();
    }

    return startFrom ?? null;
}
