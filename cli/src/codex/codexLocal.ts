import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { buildMcpServerConfigArgs, buildDeveloperInstructionsArg } from './utils/codexMcpConfig';
import { codexSystemPrompt } from './utils/systemPrompt';

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
    mcpServers?: Record<string, { command: string; args: string[] }>;
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

    // Add MCP server configuration
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push(...buildMcpServerConfigArgs(opts.mcpServers));
    }

    // Add developer instructions (system prompt)
    args.push(...buildDeveloperInstructionsArg(codexSystemPrompt));

    if (opts.codexArgs) {
        const safeArgs = filterResumeSubcommand(opts.codexArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    process.stdin.pause();
    try {
        await spawnWithAbort({
            command: 'codex',
            args,
            cwd: opts.path,
            env: process.env,
            signal: opts.abort,
            logLabel: 'CodexLocal',
            spawnName: 'codex',
            installHint: 'Codex CLI',
            includeCause: true,
            logExit: true,
            shell: process.platform === 'win32'
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }
}
