import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import {
    buildMcpServerConfigArgs,
    buildDeveloperInstructionsArg,
    buildSessionStartHookConfigArgs,
    buildModelReasoningEffortConfigArgs
} from './utils/codexMcpConfig';
import { codexSystemPrompt } from './utils/systemPrompt';
import type { ReasoningEffort } from './appServerTypes';
import { resolveCodexCommand } from './utils/codexExecutable';
import type { McpServersConfig } from './utils/buildHapiMcpBridge';
import { readCodexProviderConfigArgs } from './utils/providerConfigArgs';
import { resolveManagedProviderWireModel } from '@/host/providerModel';

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
    modelReasoningEffort?: ReasoningEffort;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
    mcpServers?: McpServersConfig;
    sessionHook?: {
        port: number;
        token: string;
    };
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('resume', opts.sessionId);
        opts.onSessionFound(opts.sessionId);
    }

    const wireModel = resolveManagedProviderWireModel(opts.model);
    if (wireModel) {
        args.push('--model', wireModel);
    }

    if (opts.modelReasoningEffort) {
        args.push(...buildModelReasoningEffortConfigArgs(opts.modelReasoningEffort));
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
        const safeArgs = filterResumeSubcommand(opts.codexArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    const codexCommand = resolveCodexCommand();
    const providerConfigArgs = readCodexProviderConfigArgs();

    await spawnWithTerminalGuard({
        command: codexCommand.command,
        args: [...codexCommand.args, ...providerConfigArgs, ...args],
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
