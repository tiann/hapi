import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import {
    buildMcpServerConfigArgs,
    buildDeveloperInstructionsArg,
    buildSessionStartHookConfigArgs
} from './utils/codexMcpConfig';
import { codexSystemPrompt } from './utils/systemPrompt';
import type { ReasoningEffort } from './appServerTypes';

/**
 * Filter out HAPI-managed session subcommands which are handled internally.
 * Codex CLI format is `codex <subcommand> <session-id>`, so the subcommand is always first.
 */
export function filterManagedSessionSubcommand(args: string[]): string[] {
    if (args.length === 0 || (args[0] !== 'resume' && args[0] !== 'fork')) {
        return args;
    }

    // First arg is 'resume' or 'fork'; filter it and optional session ID
    if (args.length > 1 && !args[1].startsWith('-')) {
        logger.debug(`[CodexLocal] Filtered '${args[0]} ${args[1]}' - session managed by hapi`);
        return args.slice(2);
    }

    logger.debug(`[CodexLocal] Filtered '${args[0]}' - session managed by hapi`);
    return args.slice(1);
}

export async function codexLocal(opts: {
    abort: AbortSignal;
    resumeSessionId: string | null;
    forkSessionId?: string;
    path: string;
    model?: string;
    modelReasoningEffort?: ReasoningEffort;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
    mcpServers?: Record<string, { command: string; args: string[] }>;
    sessionHook?: {
        port: number;
        token: string;
    };
}): Promise<void> {
    const args: string[] = [];

    if (opts.forkSessionId) {
        args.push('fork', opts.forkSessionId);
    } else if (opts.resumeSessionId) {
        args.push('resume', opts.resumeSessionId);
        opts.onSessionFound(opts.resumeSessionId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.modelReasoningEffort) {
        args.push('--model-reasoning-effort', opts.modelReasoningEffort);
    }

    if (opts.sandbox) {
        args.push('--sandbox', opts.sandbox);
    }

    // Add MCP server configuration
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push(...buildMcpServerConfigArgs(opts.mcpServers));
    }

    if (opts.sessionHook) {
        args.push(...buildSessionStartHookConfigArgs(opts.sessionHook.port, opts.sessionHook.token));
    }

    // Add developer instructions (system prompt)
    args.push(...buildDeveloperInstructionsArg(codexSystemPrompt));

    if (opts.codexArgs) {
        const safeArgs = filterManagedSessionSubcommand(opts.codexArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    await spawnWithTerminalGuard({
        command: 'codex',
        args,
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        logLabel: 'CodexLocal',
        spawnName: 'codex',
        installHint: 'Codex CLI',
        includeCause: true,
        logExit: true
    });
}
